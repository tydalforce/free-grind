import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { deleteServerSetting, setServerSetting } from "../../src/modules/settings/settings";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { adminPasswordOpts, totpCode } from "../../src/admin/auth";
import { buildApp } from "../../src/app";
import { db } from "../../src/db/client";
import { admins, entitlementProfiles } from "../../src/db/schema";
import { clientHeaders, decodeJwt, randomIp, registerAndLogin } from "../helpers";

let app: FastifyInstance;
const OWNER = `owner_${randomUUID().slice(0, 8)}`;
const MOD = `mod_${randomUUID().slice(0, 8)}`;
const PASSWORD = "very-long-admin-password";

beforeAll(async () => {
	app = await buildApp();
	const hash = await Bun.password.hash(PASSWORD, adminPasswordOpts);
	await db.insert(admins).values([
		{ username: OWNER, passwordHash: hash, role: "owner" },
		{ username: MOD, passwordHash: hash, role: "moderator" },
	]);
});

afterAll(async () => {
	await db.delete(admins).where(eq(admins.username, OWNER));
	await db.delete(admins).where(eq(admins.username, MOD));
	// Leave no role-wide limits behind for other test files.
	await db.delete(entitlementProfiles).where(eq(entitlementProfiles.profile, "free"));
	await app.close();
});

async function login(username: string, totp?: string) {
	const res = await app.inject({ method: "POST", url: "/admin/api/login", payload: { username, password: PASSWORD, totp }, headers: { "x-forwarded-for": randomIp() } });
	const cookie = String(res.headers["set-cookie"] ?? "").split(";")[0]!;
	return { res, cookie };
}

function as(cookie: string) {
	return {
		get: (url: string) => app.inject({ method: "GET", url, headers: { cookie } }),
		send: (method: "POST" | "PUT" | "DELETE", url: string, payload?: unknown, csrf = true) =>
			app.inject({ method, url, payload: payload as object, headers: { cookie, ...(csrf ? { "x-admin-request": "1" } : {}) } }),
	};
}

describe("admin auth", () => {
	test("wrong password → 401, right → cookie (HttpOnly, SameSite=Strict, Path=/admin)", async () => {
		const bad = await app.inject({ method: "POST", url: "/admin/api/login", payload: { username: OWNER, password: "nope" } });
		expect(bad.statusCode).toBe(401);
		const { res } = await login(OWNER);
		expect(res.statusCode).toBe(200);
		const setCookie = String(res.headers["set-cookie"]);
		expect(setCookie).toContain("HttpOnly");
		expect(setCookie).toContain("SameSite=Strict");
		expect(setCookie).toContain("Path=/admin");
	});

	test("admin API needs no app headers but a session", async () => {
		expect((await app.inject({ method: "GET", url: "/admin/api/me" })).statusCode).toBe(401);
		const { cookie } = await login(OWNER);
		const me = await as(cookie).get("/admin/api/me");
		expect(me.statusCode).toBe(200);
		expect(me.json()).toMatchObject({ username: OWNER, role: "owner", totpEnabled: false });
	});

	test("mutations without the CSRF header are refused", async () => {
		const { cookie } = await login(OWNER);
		expect((await as(cookie).send("POST", "/admin/api/logout", {}, false)).statusCode).toBe(403);
	});

	test("moderator can read but not change entitlements", async () => {
		const { cookie } = await login(MOD);
		expect((await as(cookie).get("/admin/api/entitlements")).statusCode).toBe(200);
		expect((await as(cookie).send("PUT", "/admin/api/entitlements/free/taps.perDay", { value: { unlimited: true } })).statusCode).toBe(403);
	});

	test("TOTP: enable, then login requires a valid code", async () => {
		const { cookie } = await login(MOD);
		const setup = (await as(cookie).send("POST", "/admin/api/me/totp/setup", {})).json() as { secret: string };
		expect((await as(cookie).send("POST", "/admin/api/me/totp/enable", { secret: setup.secret, code: "000000" })).statusCode).toBe(400);
		expect((await as(cookie).send("POST", "/admin/api/me/totp/enable", { secret: setup.secret, code: totpCode(setup.secret) })).statusCode).toBe(200);
		expect((await login(MOD)).res.json()).toEqual({ error: "totp_required" });
		expect((await login(MOD, "123456")).res.statusCode).toBe(401);
		expect((await login(MOD, totpCode(setup.secret))).res.statusCode).toBe(200);
	});
});

describe("entitlements via admin", () => {
	test("role profile + user override + reset usage; effective value shows its source", async () => {
		const { cookie } = await login(OWNER);
		const admin = as(cookie);
		const s = await registerAndLogin(app);

		// Rejects a value of the wrong type.
		expect((await admin.send("PUT", "/admin/api/entitlements/free/taps.perDay", { value: { max: 3 } })).statusCode).toBe(400);
		expect((await admin.send("PUT", "/admin/api/entitlements/free/taps.perDay", { value: { windows: [{ count: 3, window: "day" }] } })).statusCode).toBe(200);

		const appGet = () => app.inject({ method: "GET", url: "/v1/me/entitlements", headers: clientHeaders({ deviceId: s.deviceId, token: s.sessionId }) });
		const taps = (await appGet()).json().entitlements.find((e: { key: string }) => e.key === "taps.perDay");
		expect(taps).toMatchObject({ limit: 3, remaining: 3, unlimited: false });

		const detail = (await admin.get(`/admin/api/users/${s.profileId}`)).json();
		expect(detail.entitlements.find((e: { key: string }) => e.key === "taps.perDay").source).toEqual({ kind: "role", role: "free" });

		expect((await admin.send("PUT", `/admin/api/users/${s.profileId}/entitlements/taps.perDay`, { value: { unlimited: true } })).statusCode).toBe(200);
		const after = (await admin.get(`/admin/api/users/${s.profileId}`)).json();
		const overridden = after.entitlements.find((e: { key: string }) => e.key === "taps.perDay");
		expect(overridden.source).toEqual({ kind: "override" });
		expect(overridden.unlimited).toBe(true);

		expect((await admin.send("POST", `/admin/api/users/${s.profileId}/entitlements/taps.perDay/reset`, {})).statusCode).toBe(200);
	});

	test("granting a role re-issues the session: old JWT → 401, refreshed JWT carries the role", async () => {
		const { cookie } = await login(OWNER);
		const s = await registerAndLogin(app);
		const headers = clientHeaders({ deviceId: s.deviceId, token: s.sessionId });
		expect((await app.inject({ method: "GET", url: "/v1/me/entitlements", headers })).statusCode).toBe(200);

		const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
		expect((await as(cookie).send("POST", `/admin/api/users/${s.profileId}/roles`, { role: "unlimited", expiresAt })).statusCode).toBe(200);
		expect((await app.inject({ method: "GET", url: "/v1/me/entitlements", headers })).statusCode).toBe(401);

		const refreshed = await app.inject({
			method: "POST",
			url: "/v8/sessions",
			headers: clientHeaders({ deviceId: s.deviceId }),
			payload: { email: s.email, authToken: s.authToken, token: null, geohash: null },
		});
		expect(refreshed.statusCode).toBe(200);
		expect(decodeJwt(refreshed.json().sessionId).roles).toEqual(["unlimited"]);

		const claims = (await as(cookie).get(`/admin/api/users/${s.profileId}/claims`)).json().claims;
		expect(claims.roles).toEqual(["unlimited"]);
	});

	test("disabling a feature for free removes it from the JWT", async () => {
		// CreateVideoCall is only issued with LiveKit set up.
		await setServerSetting("livekit.url", "ws://127.0.0.1:7880");
		await setServerSetting("livekit.apiKey", "devkey");
		await setServerSetting("livekit.apiSecret", "secret", { secret: true });
		const { cookie } = await login(OWNER);
		await as(cookie).send("PUT", "/admin/api/entitlements/free/videocall.enabled", { value: false });
		const s = await registerAndLogin(app);
		expect(decodeJwt(s.sessionId).features).not.toContain("CreateVideoCall");
		await as(cookie).send("PUT", "/admin/api/entitlements/free/videocall.enabled", { value: null });
		const s2 = await registerAndLogin(app);
		expect(decodeJwt(s2.sessionId).features).toContain("CreateVideoCall");
		for (const k of ["livekit.url", "livekit.apiKey", "livekit.apiSecret"]) await deleteServerSetting(k);
	});

	test("template preview shows a diff, apply writes it, unlimited reverts it", async () => {
		const { cookie } = await login(OWNER);
		const admin = as(cookie);
		await admin.send("POST", "/admin/api/entitlements/templates/unlimited/apply", {});
		const preview = (await admin.get("/admin/api/entitlements/templates/restricted-free/preview")).json();
		expect(preview.changes.length).toBeGreaterThan(5);
		expect(preview.changes.every((c: { before: unknown }) => c.before === null)).toBe(true);
		expect((await admin.send("POST", "/admin/api/entitlements/templates/restricted-free/apply", {})).json().applied).toBe(preview.changes.length);
		expect((await admin.get("/admin/api/entitlements/templates/restricted-free/preview")).json().changes).toEqual([]);
		await admin.send("POST", "/admin/api/entitlements/templates/unlimited/apply", {});
		expect((await admin.get("/admin/api/entitlements")).json().matrix.free ?? {}).toEqual({});
	});
});

describe("flags, settings, audit", () => {
	test("locked flags can't be changed; public payload must not carry secrets", async () => {
		const { cookie } = await login(OWNER);
		const admin = as(cookie);
		expect((await admin.send("PUT", "/admin/api/flags/recaptcha_first_party", { defaultValue: "on" })).statusCode).toBe(409);
		expect((await admin.send("PUT", "/admin/api/flags/oauth_google", { payload: { clientSecret: "x" } })).json().error).toBe("secret_in_public_payload");
	});

	test("settings are validated; audit log records changes", async () => {
		const { cookie } = await login(OWNER);
		const admin = as(cookie);
		expect((await admin.send("PUT", "/admin/api/settings/quota.timeZone", { value: "Mars/Olympus" })).statusCode).toBe(400);
		expect((await admin.send("PUT", "/admin/api/settings/quota.timeZone", { value: "Europe/Berlin" })).statusCode).toBe(200);
		expect((await admin.get("/admin/api/settings")).json().settings["quota.timeZone"].value).toBe("Europe/Berlin");
		await admin.send("PUT", "/admin/api/settings/quota.timeZone", { value: "UTC" });
		const audit = (await admin.get("/admin/api/audit?limit=20")).json().entries as { action: string; actor: string }[];
		expect(audit.some((e) => e.action === "setting.set" && e.actor === OWNER)).toBe(true);
	});

	test("ban via admin API: timed with agreement, unknown reason refused, audit logged", async () => {
		const { cookie } = await login(OWNER);
		const admin = as(cookie);
		const s = await registerAndLogin(app);
		const meta = (await admin.get("/admin/api/bans/meta")).json();
		expect(meta.reasons).toContain("Harassment");
		expect(meta.subReasons).toContain("BULLYING");
		const res = await admin.send("POST", `/admin/api/users/${s.profileId}/ban`, { type: "timed", durationHours: 24, reason: "Harassment", subReason: "BULLYING" });
		expect(res.statusCode).toBe(200);
		expect(res.json().ban).toMatchObject({ type: "timed", reason: "Harassment", requireAgreement: true });
		expect((await admin.send("POST", `/admin/api/users/${s.profileId}/ban`, { type: "timed", durationHours: 24, reason: "Made Up" })).statusCode).toBe(400);
		const detail = (await admin.get(`/admin/api/users/${s.profileId}`)).json();
		expect(detail.ban.state).toBe("active");
		const list = (await admin.get(`/admin/api/users?q=${s.profileId}`)).json();
		expect(list.users[0].banned).toBe(true);
		expect((await admin.send("DELETE", `/admin/api/users/${s.profileId}/ban`)).json().lifted).toBe(true);
		const audit = (await admin.get("/admin/api/audit?limit=10")).json().entries as { action: string }[];
		expect(audit.some((e) => e.action === "user.ban")).toBe(true);
	});

	test("unbuilt admin UI answers 503 (or serves the SPA once built)", async () => {
		const res = await app.inject({ method: "GET", url: "/admin" });
		expect([200, 503]).toContain(res.statusCode);
	});
});
