import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { exportPKCS8, generateKeyPair } from "jose";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { adminPasswordOpts } from "../../src/admin/auth";
import { buildApp } from "../../src/app";
import { redis } from "../../src/cache/redis";
import { db } from "../../src/db/client";
import { admins, devices } from "../../src/db/schema";
import { touchOnline } from "../../src/geo/location";
import { type PushJob, notifyQueue, pushQueue } from "../../src/jobs/queues";
import { notifyCameOnline } from "../../src/push/growth";
import { deliverPush } from "../../src/push/notify";
import { clientHeaders, randomIp, registerAndLogin } from "../helpers";

type Session = Awaited<ReturnType<typeof registerAndLogin>>;

/** Fake Google OAuth + FCM HTTP v1. Token "dead-…" answers UNREGISTERED. */
const sent: { token: string; data: Record<string, string> }[] = [];
let fake: ReturnType<typeof Bun.serve>;
let app: FastifyInstance;
let cookie = "";
const ADMIN = `push_${randomUUID().slice(0, 8)}`;

beforeAll(async () => {
	fake = Bun.serve({
		port: 0,
		async fetch(req) {
			const url = new URL(req.url);
			if (url.pathname === "/token") return Response.json({ access_token: "fake-access", expires_in: 3600 });
			if (url.pathname.endsWith("/messages:send")) {
				if (req.headers.get("authorization") !== "Bearer fake-access") return new Response("no auth", { status: 401 });
				const { message } = (await req.json()) as { message: { token: string; data: Record<string, string> } };
				if (message.token.startsWith("dead-")) return Response.json({ error: { status: "NOT_FOUND", details: [{ errorCode: "UNREGISTERED" }] } }, { status: 404 });
				sent.push({ token: message.token, data: message.data });
				return Response.json({ name: "projects/p/messages/1" });
			}
			return new Response("not found", { status: 404 });
		},
	});
	process.env.FCM_API_BASE = `http://127.0.0.1:${fake.port}`;
	app = await buildApp();
	await db.insert(admins).values({ username: ADMIN, passwordHash: await Bun.password.hash("very-long-admin-password", adminPasswordOpts), role: "owner" });
	const login = await app.inject({ method: "POST", url: "/admin/api/login", payload: { username: ADMIN, password: "very-long-admin-password" }, headers: { "x-forwarded-for": randomIp() } });
	cookie = String(login.headers["set-cookie"]).split(";")[0]!;
	await pushQueue.obliterate({ force: true });
	await notifyQueue.obliterate({ force: true });
});

afterAll(async () => {
	const off = await admin("PUT", "/admin/api/integrations/fcm", { serviceAccount: "" });
	expect(off.json()).toEqual({ active: false, serviceAccount: null });
	await db.delete(admins).where(eq(admins.username, ADMIN));
	await app.close();
	fake.stop(true);
	delete process.env.FCM_API_BASE;
});

const admin = (method: "GET" | "PUT" | "POST", url: string, payload?: unknown) =>
	app.inject({ method, url, payload: payload as object, headers: { cookie, ...(method !== "GET" ? { "x-admin-request": "1" } : {}) } });
const h = (s: Session) => clientHeaders({ deviceId: s.deviceId, token: s.sessionId });

/** Runs (and removes) the queued pushes for one user, like the worker would. */
async function drain(userId: string): Promise<PushJob[]> {
	const jobs = (await pushQueue.getJobs(["waiting", "delayed", "prioritized"])).filter((j) => j?.data.userId === userId);
	for (const j of jobs) {
		await deliverPush(j.data);
		await j.remove();
	}
	return jobs.map((j) => j.data);
}

async function registerToken(s: Session, token: string) {
	const res = await app.inject({ method: "POST", url: "/v3/gcm-push-tokens", headers: h(s), payload: { token, vendorProvidedIdentifier: token.split(":")[0] } });
	expect(res.statusCode).toBe(200);
}

describe("push (FCM)", () => {
	test("integration in the admin stores the service account; no client config is published", async () => {
		const { privateKey } = await generateKeyPair("RS256", { extractable: true });
		const serviceAccount = JSON.stringify({ type: "service_account", project_id: "fg-test", client_email: "push@fg-test.iam.gserviceaccount.com", private_key: await exportPKCS8(privateKey), token_uri: `http://127.0.0.1:${fake.port}/token` });
		const bad = await admin("PUT", "/admin/api/integrations/fcm", { serviceAccount: "{\"nope\":1}" });
		expect(bad.statusCode).toBe(400);
		const res = await admin("PUT", "/admin/api/integrations/fcm", { serviceAccount });
		expect(res.statusCode).toBe(200);
		expect(res.json()).toEqual({ active: true, serviceAccount: { projectId: "fg-test", clientEmail: "push@fg-test.iam.gserviceaccount.com" } });
		expect(JSON.stringify(res.json())).not.toContain("PRIVATE KEY");

		// The app gets its Firebase client config at build time (FG_FCM_*), not from the server.
		const assignments = (await app.inject({ method: "GET", url: "/public/v1/assignments", headers: clientHeaders() })).json().assignments as { key: string }[];
		expect(assignments.some((a) => a.key === "push_fcm_config")).toBe(false);
	});

	test("chat message → push to the offline recipient (V2 envelope); unsend withdraws it; dead tokens are dropped", async () => {
		const a = await registerAndLogin(app);
		const b = await registerAndLogin(app);
		await registerToken(b, "inst1:APA91b-live-token");
		const msg = (await app.inject({ method: "POST", url: "/v4/chat/message/send", headers: h(a), payload: { type: "Text", target: { type: "Direct", targetId: Number(b.profileId) }, body: { text: "Hallo!" } } })).json();
		sent.length = 0;
		await drain(b.profileId);
		expect(sent).toHaveLength(1);
		expect(sent[0]!.token).toBe("inst1:APA91b-live-token");
		expect(sent[0]!.data).toMatchObject({
			version: "2",
			notificationId: msg.messageId.split(":")[1],
			body: "Hallo!",
			translateBody: "false",
			action: `grindr://conversation?id=${msg.conversationId}&senderId=${a.profileId}`,
			channel: "id_grindr_notifications_channel_individual_v2",
			senderId: a.profileId,
			quickReply: "true",
		});
		expect(Object.values(sent[0]!.data).every((v) => typeof v === "string")).toBe(true);

		await app.inject({ method: "POST", url: "/v4/chat/message/unsend", headers: h(a), payload: { conversationId: msg.conversationId, messageId: msg.messageId } });
		sent.length = 0;
		await drain(b.profileId);
		expect(sent[0]!.data.action).toBe(`grindr://unsend?notificationId=${msg.messageId.split(":")[1]}`);

		// Connected users get it live instead.
		await redis.set(`presence:${b.profileId}`, "1", "EX", 30);
		await app.inject({ method: "POST", url: "/v4/chat/message/send", headers: h(a), payload: { type: "Image", target: { type: "Direct", targetId: Number(b.profileId) }, body: { mediaId: 1 } } }).catch(() => undefined);
		await app.inject({ method: "POST", url: "/v4/chat/message/send", headers: h(a), payload: { type: "Text", target: { type: "Direct", targetId: Number(b.profileId) }, body: { text: "live" } } });
		sent.length = 0;
		await drain(b.profileId);
		expect(sent).toHaveLength(0);
		await redis.del(`presence:${b.profileId}`);

		// A token FCM no longer knows is removed from the device.
		await registerToken(b, "dead-inst:APA91b-gone");
		await app.inject({ method: "POST", url: "/v4/chat/message/send", headers: h(a), payload: { type: "Text", target: { type: "Direct", targetId: Number(b.profileId) }, body: { text: "x" } } });
		await drain(b.profileId);
		const [dev] = await db.select({ t: devices.fcmToken }).from(devices).where(eq(devices.deviceId, b.deviceId));
		expect(dev?.t).toBeNull();
	});

	test("push settings: all types offered (default on); a switched-off type sends nothing", async () => {
		const a = await registerAndLogin(app);
		const b = await registerAndLogin(app);
		await registerToken(b, "inst2:APA91b-tap-token");
		const settings = (await app.inject({ method: "GET", url: "/v5/push-settings", headers: h(b) })).json();
		expect(settings).toEqual({
			favoritePushNotification: true,
			tapPushNotification: true,
			tappedPushNotification: true,
			mediaRecipientPushNotification: true,
			recommendedPushNotification: true,
			unreadChatsPushNotification: true,
			viewedProfilePushNotification: true,
		});
		expect((await app.inject({ method: "PUT", url: "/v5/push-settings", headers: h(b), payload: { tapPushNotification: false } })).statusCode).toBe(200);
		expect((await app.inject({ method: "GET", url: "/v5/push-settings", headers: h(b) })).json()).toMatchObject({ tapPushNotification: false, favoritePushNotification: true });
		await app.inject({ method: "POST", url: "/v2/taps/add", headers: h(a), payload: { recipientId: Number(b.profileId), tapType: 1 } });
		expect(await drain(b.profileId)).toHaveLength(0);

		await app.inject({ method: "PUT", url: "/v5/push-settings", headers: h(b), payload: { tapPushNotification: true } });
		await redis.del(`push:viewed:${b.profileId}`);
		await app.inject({ method: "POST", url: `/v4/views/${b.profileId}`, headers: h(a) });
		const jobs = await drain(b.profileId);
		expect(jobs[0]?.data).toMatchObject({ title: "VIEWED_PROFILE_NOTIFICATION_TITLE", translateTitle: "true", body: "VIEWED_PROFILE_NOTIFICATION_BODY" });
	});

	test("came online: favorite owner and tapper get their pushes, once", async () => {
		const target = await registerAndLogin(app);
		const fan = await registerAndLogin(app);
		const tapper = await registerAndLogin(app);
		for (const [s, t] of [[fan, "inst3:APA91b-fan"], [tapper, "inst4:APA91b-tapper"]] as const) await registerToken(s, t);
		await app.inject({ method: "POST", url: `/v3/me/favorites/${target.profileId}`, headers: h(fan) });
		await app.inject({ method: "POST", url: "/v2/taps/add", headers: h(tapper), payload: { recipientId: Number(target.profileId), tapType: 0 } });
		await drain(target.profileId);

		// Going online enqueues the fan-out; a repeat within 30 min doesn't.
		await db.execute(`UPDATE profiles SET online_until = now() - interval '1 minute' WHERE user_id = ${target.profileId}` as never);
		await redis.del(`online:came:${target.profileId}`);
		await touchOnline(BigInt(target.profileId));
		await touchOnline(BigInt(target.profileId));
		const queued = (await notifyQueue.getJobs(["waiting"])).filter((j) => j?.data.kind === "came_online" && j.data.userId === target.profileId);
		expect(queued).toHaveLength(1);

		await notifyCameOnline(target.profileId);
		expect((await drain(fan.profileId))[0]?.data).toMatchObject({ title: "FAVORITE_ONLINE_NOTIFICATION_TITLE", action: `grindr://growth-notification?type=favorite_online&profileID=${target.profileId}`, senderId: target.profileId });
		expect((await drain(tapper.profileId))[0]?.data).toMatchObject({ title: "TAPPED_ONLINE_NOTIFICATION_TITLE" });
		// Throttled: no second favorite push for the same pair.
		await notifyCameOnline(target.profileId);
		expect(await drain(fan.profileId)).toHaveLength(0);
	});
});
