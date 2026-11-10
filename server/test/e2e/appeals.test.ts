import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { adminPasswordOpts } from "../../src/admin/auth";
import { buildApp } from "../../src/app";
import { db } from "../../src/db/client";
import { admins, deviceBans, networkBans } from "../../src/db/schema";
import { banUser, currentBan } from "../../src/moderation/bans";
import { ADULT_BIRTHDAY, clientHeaders, newDeviceId, randomIp, registerAndLogin, uniqueEmail } from "../helpers";

let app: FastifyInstance;
let cookie: string;
const ADMIN = `appeals_${randomUUID().slice(0, 8)}`;
const PASSWORD = "very-long-admin-password";

beforeAll(async () => {
	app = await buildApp();
	await db.insert(admins).values({ username: ADMIN, passwordHash: await Bun.password.hash(PASSWORD, adminPasswordOpts), role: "moderator" });
	const res = await app.inject({ method: "POST", url: "/admin/api/login", payload: { username: ADMIN, password: PASSWORD }, headers: { "x-forwarded-for": randomIp() } });
	cookie = String(res.headers["set-cookie"] ?? "").split(";")[0]!;
});

afterAll(async () => {
	await db.delete(admins).where(eq(admins.username, ADMIN));
	await Promise.race([app.close(), new Promise((r) => setTimeout(r, 2000))]);
});

const admin = {
	get: (url: string) => app.inject({ method: "GET", url, headers: { cookie } }),
	send: (method: "POST" | "DELETE", url: string, payload?: unknown) =>
		app.inject({ method, url, payload: payload as object, headers: { cookie, "x-admin-request": "1" } }),
};

async function refresh(u: { email: string; authToken: string; deviceId: string }, ip?: string) {
	return app.inject({ method: "POST", url: "/v8/sessions", headers: clientHeaders({ deviceId: u.deviceId, ip }), payload: { email: u.email, authToken: u.authToken, token: null, geohash: "u33dc0" } });
}

describe("decision appeals (app API)", () => {
	test("unbanned account → 400 parameter/validation", async () => {
		const u = await registerAndLogin(app);
		const res = await app.inject({ method: "GET", url: "/v1/decision-appeal", headers: clientHeaders({ deviceId: u.deviceId, token: u.sessionId }) });
		expect(res.statusCode).toBe(400);
		expect(res.json()).toMatchObject({ type: "urn:gr:err:parameter", parameterName: "validation" });
	});

	test("timed ban: appeal once, a second submission returns the same; granting lifts the ban", async () => {
		const u = await registerAndLogin(app);
		await banUser(BigInt(u.profileId), { type: "timed", reason: "Scam / Spam", subReason: "BOT_ACTIVITY", requireAgreement: true, expiresAt: new Date(Date.now() + 86_400_000), createdBy: "test" });
		const r = await refresh(u);
		expect(r.statusCode).toBe(200);
		const token = (r.json() as { sessionId: string }).sessionId;
		const headers = clientHeaders({ deviceId: u.deviceId, token });

		const before = await app.inject({ method: "GET", url: "/v1/decision-appeal", headers });
		expect(before.json()).toEqual({ profileId: Number(u.profileId), result: null });

		const body = { userEmail: u.email, userDevice: "Pixel 8", userLocation: "Berlin", countryCode: "de", userVpn: false, errorDescription: "Not a bot" };
		expect((await app.inject({ method: "POST", url: "/v1/decision-appeal", headers, payload: body })).statusCode).toBe(404);
		const first = await app.inject({ method: "POST", url: "/v2/decision-appeal", headers, payload: body });
		expect(first.statusCode).toBe(200);
		expect(first.json()).toEqual({ profileId: Number(u.profileId), result: "PENDING" });
		const second = await app.inject({ method: "POST", url: "/v2/decision-appeal", headers, payload: { ...body, captchaToken: "x" } });
		expect(second.json()).toEqual({ profileId: Number(u.profileId), result: "PENDING" });

		const list = (await admin.get("/admin/api/appeals?status=PENDING")).json() as { appeals: { id: string; userId: string; countryCode: string; ban: { subReason: string } }[] };
		const mine = list.appeals.filter((a) => a.userId === u.profileId);
		expect(mine).toHaveLength(1);
		expect(mine[0]!.countryCode).toBe("DE");
		expect(mine[0]!.ban.subReason).toBe("BOT_ACTIVITY");

		const decided = await admin.send("POST", `/admin/api/appeals/${mine[0]!.id}/decision`, { status: "GRANTED", note: "ok" });
		expect(decided.statusCode).toBe(200);
		expect(await currentBan(BigInt(u.profileId))).toBeNull();
		expect((await admin.send("POST", `/admin/api/appeals/${mine[0]!.id}/decision`, { status: "REJECTED" })).statusCode).toBe(409);
	});
});

describe("ban-appeal web page (permanent bans)", () => {
	test("needs the account's password, files one appeal per ban", async () => {
		const u = await registerAndLogin(app);
		await banUser(BigInt(u.profileId), { type: "permanent", reason: "Harassment", subReason: null, requireAgreement: false, expiresAt: null, createdBy: "test" });
		expect((await refresh(u)).json()).toMatchObject({ code: 27 });

		const page = await app.inject({ method: "GET", url: "/ban-appeal" });
		expect(page.statusCode).toBe(200);
		expect(page.headers["content-type"]).toContain("text/html");

		const post = (password: string) =>
			app.inject({
				method: "POST",
				url: "/ban-appeal",
				headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": randomIp() },
				payload: new URLSearchParams({ email: u.email, password, description: "Please review" }).toString(),
			});
		expect((await post("wrong-password")).statusCode).toBe(400);
		const ok = await post(u.password);
		expect(ok.statusCode).toBe(200);
		expect(ok.body).toContain("Appeal sent");
		expect((await post(u.password)).body).toContain("still being reviewed");

		const list = (await admin.get("/admin/api/appeals?status=all")).json() as { appeals: { id: string; userId: string; source: string; description: string }[] };
		const mine = list.appeals.find((a) => a.userId === u.profileId)!;
		expect(mine).toMatchObject({ source: "web", description: "Please review" });
		await admin.send("POST", `/admin/api/appeals/${mine.id}/decision`, { status: "REJECTED" });
		expect((await currentBan(BigInt(u.profileId)))?.kind).toBe("permanent");
		expect((await post(u.password)).body).toContain("rejected");
	});
});

describe("device and network bans", () => {
	test("banning a user with their devices bans every account that used them; new accounts there are banned on sign-in", async () => {
		const u = await registerAndLogin(app);
		// Another account that used u's device before.
		const sibling = await registerAndLogin(app, u.deviceId);
		const ban = await admin.send("POST", `/admin/api/users/${u.profileId}/ban`, { type: "permanent", reason: "Scam / Spam", banDevices: true });
		expect(ban.statusCode).toBe(200);
		expect(ban.json()).toMatchObject({ devicesBanned: 1, linkedAccountsBanned: 1 });

		// The sibling got the same ban (permanent, same reason), automated.
		const siblingBan = await currentBan(BigInt(sibling.profileId));
		expect(siblingBan?.kind).toBe("permanent");
		expect(siblingBan?.ban).toMatchObject({ reason: "Scam / Spam", automated: true });
		expect((await refresh(sibling)).json()).toMatchObject({ code: 27 });

		// Sign-up on the device is refused.
		const signup = await app.inject({
			method: "POST",
			url: "/v8/users",
			headers: clientHeaders({ deviceId: u.deviceId }),
			payload: { email: uniqueEmail(), password: "correct-horse-battery", birthday: ADULT_BIRTHDAY, optIn: false },
		});
		expect(signup.statusCode).toBe(403);
		expect(signup.json()).toMatchObject({ code: 28, message: "ACCOUNT_BANNED" });

		// An account from elsewhere signing in on the device is banned right then.
		const newcomer = await registerAndLogin(app);
		const signIn = await app.inject({ method: "POST", url: "/v8/sessions", headers: clientHeaders({ deviceId: u.deviceId }), payload: { email: newcomer.email, password: newcomer.password, token: null, geohash: "u33dc0" } });
		expect(signIn.statusCode).toBe(403);
		expect(signIn.json()).toMatchObject({ code: 27 });
		expect((await currentBan(BigInt(newcomer.profileId)))?.ban).toMatchObject({ type: "permanent", reason: "Scam / Spam", createdBy: "system:device-ban" });
		// A wrong password on the banned device bans nobody.
		const other = await registerAndLogin(app);
		const wrong = await app.inject({ method: "POST", url: "/v8/sessions", headers: clientHeaders({ deviceId: u.deviceId }), payload: { email: other.email, password: "wrong-password", token: null, geohash: "u33dc0" } });
		expect(wrong.json()).toMatchObject({ code: 4 });
		expect(await currentBan(BigInt(other.profileId))).toBeNull();

		// The source account, unbanned by an admin, isn't banned again but can't use the device.
		await admin.send("DELETE", `/admin/api/users/${u.profileId}/ban`);
		const back = await app.inject({ method: "POST", url: "/v8/sessions", headers: clientHeaders({ deviceId: u.deviceId }), payload: { email: u.email, password: u.password, token: null, geohash: "u33dc0" } });
		expect(back.json()).toMatchObject({ code: 28 });
		expect(await currentBan(BigInt(u.profileId))).toBeNull();

		const detail = (await admin.get(`/admin/api/users/${u.profileId}`)).json() as { deviceBans: { id: string; deviceId: string }[] };
		expect(detail.deviceBans.map((d) => d.deviceId)).toEqual([u.deviceId]);
		await admin.send("DELETE", `/admin/api/device-bans/${detail.deviceBans[0]!.id}`);
		await db.delete(deviceBans).where(eq(deviceBans.deviceId, u.deviceId));
	});

	test("a device ban on its own bans the accounts that used the device permanently", async () => {
		const a = await registerAndLogin(app);
		const res = await admin.send("POST", "/admin/api/device-bans", { deviceId: a.deviceId, note: "test" });
		expect(res.json()).toMatchObject({ added: 1, accountsBanned: 1 });
		expect((await currentBan(BigInt(a.profileId)))?.ban).toMatchObject({ type: "permanent", automated: true });
		await db.delete(deviceBans).where(eq(deviceBans.deviceId, a.deviceId));
	});

	test("network ban → code 31 on sign-in from inside the range, lifted → fine", async () => {
		const u = await registerAndLogin(app);
		const bad = await admin.send("POST", "/admin/api/network-bans", { cidr: "10.0.0.1/8" });
		expect(bad.statusCode).toBe(400);
		const ip = "198.51.100.77";
		const created = await admin.send("POST", "/admin/api/network-bans", { cidr: "198.51.100.0/24", durationHours: 1, note: "test" });
		expect(created.statusCode).toBe(200);
		const id = (created.json() as { ban: { id: string; cidr: string } }).ban.id;

		const blocked = await refresh(u, ip);
		expect(blocked.statusCode).toBe(403);
		expect(blocked.json()).toMatchObject({ code: 31, message: "SUSPICIOUS_NETWORK" });
		// Outside the range the refresh token still works (it wasn't consumed).
		expect((await refresh(u, "198.51.101.1")).statusCode).toBe(200);

		await admin.send("DELETE", `/admin/api/network-bans/${id}`);
		const u2 = await registerAndLogin(app, newDeviceId());
		expect((await refresh(u2, ip)).statusCode).toBe(200);
		await db.delete(networkBans).where(eq(networkBans.id, BigInt(id)));
	});
});
