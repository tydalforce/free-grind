import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import sharp from "sharp";
import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { adminPasswordOpts } from "../../src/admin/auth";
import { buildApp } from "../../src/app";
import { db } from "../../src/db/client";
import { admins, devices, media, userRoles } from "../../src/db/schema";
import { sweepExpiredGrants } from "../../src/jobs/expiryCleanup";
import { drainSecurityEvents } from "../../src/jobs/securityEventsDrain";
import { recordSecurityEvent } from "../../src/lib/securityEvents";
import { clientHeaders, randomIp, registerAndLogin } from "../helpers";

type Session = Awaited<ReturnType<typeof registerAndLogin>>;

let app: FastifyInstance;
let cookie = "";
const OWNER = `ops_${randomUUID().slice(0, 8)}`;

beforeAll(async () => {
	app = await buildApp();
	await db.insert(admins).values({ username: OWNER, passwordHash: await Bun.password.hash("very-long-admin-password", adminPasswordOpts), role: "owner" });
	const login = await app.inject({ method: "POST", url: "/admin/api/login", payload: { username: OWNER, password: "very-long-admin-password" }, headers: { "x-forwarded-for": randomIp() } });
	cookie = String(login.headers["set-cookie"]).split(";")[0]!;
});
afterAll(async () => {
	await db.delete(admins).where(eq(admins.username, OWNER));
	await app.close();
});

const admin = (method: "GET" | "POST" | "DELETE", url: string, payload?: unknown) =>
	app.inject({ method, url, payload: payload as object, headers: { cookie, ...(method !== "GET" ? { "x-admin-request": "1" } : {}) } });
const h = (s: Session) => clientHeaders({ deviceId: s.deviceId, token: s.sessionId });
const me = (s: Session) => app.inject({ method: "GET", url: "/v4/me/profile", headers: h(s) });

describe("admin operations", () => {
	test("expired roles are removed and the session token re-issued", async () => {
		const s = await registerAndLogin(app);
		await db.insert(userRoles).values({ userId: BigInt(s.profileId), role: "unlimited", grantedBy: "test", expiresAt: new Date(Date.now() - 1000) });
		expect((await me(s)).statusCode).toBe(200);
		expect(await sweepExpiredGrants()).toBeGreaterThanOrEqual(1);
		expect(await db.select().from(userRoles).where(eq(userRoles.userId, BigInt(s.profileId)))).toHaveLength(0);
		// Old token (with the old token_version) is refused → the app refreshes and gets the new claims.
		expect((await me(s)).statusCode).toBe(401);
	});

	test("device revocation signs that device out; the refresh token dies too", async () => {
		const s = await registerAndLogin(app);
		expect((await admin("POST", `/admin/api/users/${s.profileId}/devices/${s.deviceId}/revoke`)).statusCode).toBe(200);
		expect((await me(s)).statusCode).toBe(401);
		const refresh = await app.inject({ method: "POST", url: "/v8/sessions", headers: clientHeaders({ deviceId: s.deviceId }), payload: { email: s.email, authToken: s.authToken, token: null, geohash: null } });
		expect(refresh.statusCode).not.toBe(200);
		const detail = (await admin("GET", `/admin/api/users/${s.profileId}`)).json();
		expect(detail.devices[0].revokedAt).not.toBeNull();
	});

	test("security events are listed and summarized; key rotation keeps sessions valid", async () => {
		const s = await registerAndLogin(app);
		await recordSecurityEvent("token_reuse", { userId: s.profileId, ip: "10.9.9.9" });
		await drainSecurityEvents("admin-test");
		const list = (await admin("GET", `/admin/api/security/events?userId=${s.profileId}`)).json();
		expect(list.events[0]).toMatchObject({ kind: "token_reuse", userId: s.profileId, ip: "10.9.9.9" });
		expect((await admin("GET", "/admin/api/security/summary")).json().last24h.token_reuse).toBeGreaterThanOrEqual(1);

		const rotated = await admin("POST", "/admin/api/security/rotate/jwt");
		expect(rotated.json().kid).toBeString();
		expect((await me(s)).statusCode).toBe(200);
		expect((await admin("POST", "/admin/api/security/rotate/media")).statusCode).toBe(200);
	});

	test("media: listed with usage, preview served, moderation delete clears the profile photo", async () => {
		const s = await registerAndLogin(app);
		const raw = Buffer.from(Array.from({ length: 96 * 96 * 3 }, (_, i) => (i * 13) % 256));
		const jpeg = await sharp(raw, { raw: { width: 96, height: 96, channels: 3 } }).jpeg({ quality: 95 }).toBuffer();
		const up = await app.inject({ method: "POST", url: "/v4/media/upload", headers: { ...h(s), "content-type": "image/jpeg" }, payload: jpeg });
		const hash = up.json().hash as string;
		await app.inject({ method: "PUT", url: "/v3/me/profile/images", headers: h(s), payload: { primaryImageHash: hash, secondaryImageHashes: [] } });

		const list = (await admin("GET", `/admin/api/media?ownerId=${s.profileId}`)).json().media;
		expect(list[0]).toMatchObject({ hash, purpose: "profile", kind: "image", inProfile: true, ownerId: s.profileId });
		const preview = await admin("GET", `/admin/api/media/${hash}/preview`);
		expect(preview.statusCode).toBe(200);
		expect(preview.headers["content-type"]).toBe("image/jpeg");
		expect((await app.inject({ method: "GET", url: `/admin/api/media/${hash}/preview` })).statusCode).toBe(401);
		expect((await admin("GET", "/admin/api/media/storage")).json().total.files).toBeGreaterThan(0);

		expect((await admin("DELETE", `/admin/api/media/${hash}`)).statusCode).toBe(200);
		const [row] = await db.select({ deletedAt: media.deletedAt }).from(media).where(eq(media.hash, hash));
		expect(row?.deletedAt).not.toBeNull();
		expect((await me(s)).json().profiles[0].profileImageMediaHash).toBeNull();
	});

	test("broadcast: recipient estimate; refused without push configured", async () => {
		const s = await registerAndLogin(app);
		await db.update(devices).set({ fcmToken: `inst:${randomUUID()}` }).where(eq(devices.deviceId, s.deviceId));
		const est = (await admin("POST", "/admin/api/broadcast/estimate", { target: { kind: "users", userIds: [s.profileId] } })).json();
		expect(est.recipients).toBe(1);
		const send = await admin("POST", "/admin/api/broadcast", { title: "Hallo", body: "Wartung heute Nacht", target: { kind: "all" } });
		expect(send.statusCode).toBe(400);
		expect(send.json().error).toBe("not_configured");
	});

	test("metrics: hidden without the token, Prometheus text with it", async () => {
		process.env.METRICS_TOKEN = "scrape-secret";
		try {
			await app.inject({ method: "GET", url: "/healthz" });
			expect((await app.inject({ method: "GET", url: "/metrics" })).statusCode).toBe(404);
			expect((await app.inject({ method: "GET", url: "/metrics", headers: { authorization: "Bearer wrong" } })).statusCode).toBe(404);
			const res = await app.inject({ method: "GET", url: "/metrics", headers: { authorization: "Bearer scrape-secret" } });
			expect(res.statusCode).toBe(200);
			expect(res.body).toContain("http_request_duration_seconds_bucket");
			expect(res.body).toContain('route="/healthz"');
			expect(res.body).toContain("queue_jobs");
			expect(res.body).toContain("ws_connections");
		} finally {
			delete process.env.METRICS_TOKEN;
		}
	});
});
