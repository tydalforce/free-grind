import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import Redis from "ioredis";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app";
import { invalidate } from "../../src/cache/local";
import { config } from "../../src/config";
import { db } from "../../src/db/client";
import { entitlementUserOverrides } from "../../src/db/schema";
import { deleteServerSetting, setServerSetting } from "../../src/modules/settings/settings";
import { handleCallTimer } from "../../src/videocall/routes";
import { clientHeaders, decodeJwt, registerAndLogin } from "../helpers";

type Session = Awaited<ReturnType<typeof registerAndLogin>>;
type Obj = Record<string, any>;

let app: FastifyInstance;
let fake: ReturnType<typeof Bun.serve>;
const deletedRooms: string[] = [];
const events: { user: string; type: string; payload: Obj }[] = [];
let sub: Redis;

beforeAll(async () => {
	// Fake LiveKit RoomService (Twirp).
	fake = Bun.serve({
		port: 0,
		async fetch(req) {
			const url = new URL(req.url);
			if (!req.headers.get("authorization")?.startsWith("Bearer ")) return new Response("unauthorized", { status: 401 });
			if (url.pathname.endsWith("/DeleteRoom")) {
				deletedRooms.push(((await req.json()) as { room: string }).room);
				return Response.json({});
			}
			if (url.pathname.endsWith("/ListRooms")) return Response.json({ rooms: [] });
			return new Response("nope", { status: 404 });
		},
	});
	app = await buildApp();
	sub = new Redis(config.REDIS_URL);
	await sub.psubscribe("ws:user:*");
	sub.on("pmessage", (_p, channel, message) => {
		const m = JSON.parse(message) as { type: string; payload: Obj };
		if (m.type.startsWith("videocall.")) events.push({ user: channel.slice("ws:user:".length), type: m.type, payload: m.payload });
	});
});

afterAll(async () => {
	for (const k of ["livekit.url", "livekit.apiKey", "livekit.apiSecret"]) await deleteServerSetting(k);
	sub.disconnect();
	await app.close();
	fake.stop(true);
});

const h = (s: Session) => clientHeaders({ deviceId: s.deviceId, token: s.sessionId });
const call = (s: Session, target: Session) => app.inject({ method: "POST", url: "/v1/video-call", headers: h(s), payload: { targetProfileId: Number(target.profileId) } });
const waitFor = async (pred: (e: (typeof events)[number]) => boolean) => {
	for (let i = 0; i < 40; i++) {
		const e = events.find(pred);
		if (e) return e;
		await Bun.sleep(25);
	}
	throw new Error("event not received");
};

/** VideoCall status messages in the a↔b chat, oldest first, as `b` sees them. */
async function callStatuses(a: Session, b: Session): Promise<{ senderId: number; body: { result: string; videoCallDuration: number } }[]> {
	const [x, y] = [BigInt(a.profileId), BigInt(b.profileId)];
	const cid = x < y ? `${x}:${y}` : `${y}:${x}`;
	const res = await app.inject({ method: "GET", url: `/v5/chat/conversation/${cid}/message`, headers: h(b) });
	if (res.statusCode !== 200) return [];
	return (res.json().messages as { type: string; senderId: number; body: { result: string; videoCallDuration: number } }[])
		.filter((m) => m.type === "VideoCall");
}

async function override(s: Session, key: string, value: unknown) {
	await db.insert(entitlementUserOverrides).values({ userId: BigInt(s.profileId), key, value }).onConflictDoUpdate({ target: [entitlementUserOverrides.userId, entitlementUserOverrides.key], set: { value } });
	await invalidate("entitlement-user", s.profileId);
}

async function relogin(s: Session): Promise<Obj> {
	const res = await app.inject({ method: "POST", url: "/v8/sessions", headers: clientHeaders({ deviceId: s.deviceId }), payload: { email: s.email, password: s.password, token: null, geohash: null } });
	s.sessionId = res.json().sessionId;
	return decodeJwt(s.sessionId);
}

describe("video calls (LiveKit)", () => {
	test("without LiveKit: no CreateVideoCall feature and calls are refused", async () => {
		const a = await registerAndLogin(app);
		const b = await registerAndLogin(app);
		expect((await relogin(a)).features).not.toContain("CreateVideoCall");
		expect((await call(a, b)).statusCode).toBe(403);
	});

	test("call, answer, busy, hang up → call_ended to both, seconds charged, room closed", async () => {
		await setServerSetting("livekit.url", `ws://127.0.0.1:${fake.port}`);
		await setServerSetting("livekit.apiKey", "devkey");
		await setServerSetting("livekit.apiSecret", "secret-of-at-least-32-characters-ok", { secret: true });
		const a = await registerAndLogin(app);
		const b = await registerAndLogin(app);
		const c = await registerAndLogin(app);
		expect((await relogin(a)).features).toContain("CreateVideoCall");
		await override(a, "videocall.dailySeconds", { windows: [{ count: 600, window: "day" }] });

		const started = await call(a, b);
		expect(started.statusCode).toBe(200);
		const s = started.json();
		expect(s).toMatchObject({ result: "SUCCESS", maxSeconds: 600, provider: "livekit", url: `ws://127.0.0.1:${fake.port}` });
		const grant = decodeJwt(s.token);
		expect(grant).toMatchObject({ iss: "devkey", sub: a.profileId, video: { room: s.channelId, roomJoin: true, canPublish: true } });
		const incoming = await waitFor((e) => e.user === b.profileId && e.type === "videocall.v1.incoming_call");
		expect(incoming.payload).toMatchObject({ channelId: s.channelId, senderId: a.profileId });

		// The callee is busy for anyone else meanwhile.
		expect((await call(c, b)).json()).toMatchObject({ result: "TARGET_PROFILE_UNAVAILABLE", channelId: null, token: null });

		const joined = await app.inject({ method: "PATCH", url: "/v1/video-call/join", headers: h(b), payload: { channelId: s.channelId } });
		expect(joined.json()).toMatchObject({ result: "SUCCESS", provider: "livekit" });
		expect(decodeJwt(joined.json().token)).toMatchObject({ sub: b.profileId, video: { room: s.channelId } });
		// Only the callee can join.
		expect((await app.inject({ method: "PATCH", url: "/v1/video-call/join", headers: h(c), payload: { channelId: s.channelId } })).statusCode).toBe(404);

		const renewed = (await app.inject({ method: "PATCH", url: "/v1/video-call", headers: h(a) })).json();
		expect(renewed).toMatchObject({ result: "SUCCESS", refreshSeconds: 300 });
		expect(renewed.remainingSeconds).toBeLessThanOrEqual(600);

		await Bun.sleep(1100);
		expect((await app.inject({ method: "PATCH", url: "/v1/video-call/leave", headers: h(b), payload: { channelId: s.channelId } })).statusCode).toBe(200);
		const ended = await waitFor((e) => e.user === a.profileId && e.type === "videocall.v1.call_ended" && e.payload.channelId === s.channelId);
		expect(ended.payload).toMatchObject({ senderId: a.profileId, recipientId: b.profileId, result: "SUCCESSFUL" });
		expect(ended.payload.duration).toBeGreaterThanOrEqual(1);
		await waitFor((e) => e.user === b.profileId && e.type === "videocall.v1.call_ended");
		expect(deletedRooms).toContain(s.channelId);
		// Chat status line from the caller: successful, with the talked seconds.
		const statuses = await callStatuses(a, b);
		expect(statuses.map((m) => m.body.result)).toContain("SUCCESSFUL");
		const done = statuses.find((m) => m.body.result === "SUCCESSFUL")!;
		expect(done.senderId).toBe(Number(a.profileId));
		expect(done.body.videoCallDuration).toBeGreaterThanOrEqual(1);
		// c tried while b was busy: a BUSY line in c↔b.
		expect((await callStatuses(c, b)).map((m) => m.body)).toEqual([{ result: "BUSY", videoCallDuration: 0 }]);
		const left = (await app.inject({ method: "GET", url: "/v3/video-call", headers: h(a) })).json().remainingSeconds;
		expect(left).toBeLessThan(600);
		expect((await app.inject({ method: "GET", url: "/v3/video-call", headers: h(c) })).json().remainingSeconds).toBe(2_147_483_647);
		// The callee's own allowance is untouched: receiving costs nothing.
		await override(b, "videocall.dailySeconds", { windows: [{ count: 600, window: "day" }] });
		expect((await app.inject({ method: "GET", url: "/v3/video-call", headers: h(b) })).json().remainingSeconds).toBe(600);
	});

	test("decline, ring timeout and an exhausted allowance", async () => {
		const a = await registerAndLogin(app);
		const b = await registerAndLogin(app);
		const declined = (await call(a, b)).json();
		await app.inject({ method: "PATCH", url: "/v1/video-call/leave", headers: h(b), payload: { channelId: declined.channelId } });
		expect((await waitFor((e) => e.user === a.profileId && e.payload.channelId === declined.channelId && e.type === "videocall.v1.call_ended")).payload.result).toBe("DECLINED");

		const unanswered = (await call(a, b)).json();
		await handleCallTimer(unanswered.channelId, "ring");
		expect((await waitFor((e) => e.user === b.profileId && e.payload.channelId === unanswered.channelId && e.type === "videocall.v1.call_ended")).payload.result).toBe("UNANSWERED");

		// Caller hangs up while it rings → Cancelled.
		const cancelled = (await call(a, b)).json();
		await app.inject({ method: "PATCH", url: "/v1/video-call/leave", headers: h(a), payload: { channelId: cancelled.channelId } });
		const results = (await callStatuses(a, b)).map((m) => m.body.result);
		expect(results).toEqual(expect.arrayContaining(["DECLINED", "UNANSWERED", "Cancelled"]));

		// The callee's allowance doesn't matter; the caller's does.
		await override(b, "videocall.dailySeconds", { windows: [{ count: 0, window: "day" }] });
		const free = (await call(a, b)).json();
		expect(free.result).toBe("SUCCESS");
		await app.inject({ method: "PATCH", url: "/v1/video-call/leave", headers: h(a), payload: { channelId: free.channelId } });
		await override(a, "videocall.dailySeconds", { windows: [{ count: 0, window: "day" }] });
		expect((await call(a, b)).json()).toMatchObject({ result: "EXCEED_LENGTH_LIMIT", token: null });
		await override(b, "videocall.receive", false);
		expect((await call(a, b)).json().result).toBe("TARGET_PROFILE_UNAVAILABLE");
	});
});
