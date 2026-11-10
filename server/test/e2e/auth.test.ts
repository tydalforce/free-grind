import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app";
import { ADULT_BIRTHDAY, clientHeaders, decodeJwt, newDeviceId, registerAndLogin, uniqueEmail } from "../helpers";

let app: FastifyInstance;

beforeAll(async () => {
	app = await buildApp();
});

afterAll(async () => {
	await app.close();
});

describe("security headers", () => {
	test("missing User-Agent → 400 urn:gr:err:header", async () => {
		const h = clientHeaders();
		delete h["user-agent"];
		const res = await app.inject({ method: "GET", url: "/public/v1/assignments", headers: h });
		expect(res.statusCode).toBe(400);
		expect(res.json().type).toBe("urn:gr:err:header");
	});

	test("malformed L-Device-Info → 403", async () => {
		const res = await app.inject({ method: "GET", url: "/public/v1/assignments", headers: { ...clientHeaders(), "l-device-info": "nope" } });
		expect(res.statusCode).toBe(403);
	});

	test("sign-in with bad headers → ACCOUNT_BANNED decoy (code 28)", async () => {
		const res = await app.inject({
			method: "POST",
			url: "/v8/sessions",
			headers: { ...clientHeaders(), "l-device-info": "bad" },
			payload: { email: "a@b.de", password: "x" },
		});
		expect(res.statusCode).toBe(403);
		expect(res.json().code).toBe(28);
	});

	test("unknown endpoint → 404 resource_not_found", async () => {
		const res = await app.inject({ method: "GET", url: "/v1/does-not-exist", headers: clientHeaders() });
		expect(res.statusCode).toBe(404);
		expect(res.json().type).toBe("urn:gr:err:resource_not_found");
	});
});

describe("registration & sessions", () => {
	test("underage registration is rejected", async () => {
		const res = await app.inject({
			method: "POST",
			url: "/v8/users",
			headers: clientHeaders(),
			payload: { email: uniqueEmail(), password: "long-enough-pw", birthday: Date.now() - 10 * 365 * 86_400_000, captchaToken: "", token: "", optIn: false, sessionId: null },
		});
		expect(res.statusCode).toBe(400);
	});

	test("register → login yields upstream-shaped session + JWT claims", async () => {
		const s = await registerAndLogin(app);
		expect(s.profileId).toMatch(/^\d+$/);
		expect(typeof s.authToken).toBe("string");
		const header = JSON.parse(Buffer.from(s.sessionId.split(".")[0]!, "base64url").toString());
		expect(header).toMatchObject({ alg: "RS256", typ: "JWT" });
		expect(typeof header.kid).toBe("string");
		const claims = decodeJwt(s.sessionId);
		expect(claims.profileId).toBe(s.profileId);
		expect(Array.isArray(claims.roles)).toBe(true);
		// Video calls need LiveKit configured first (see videocall.test.ts).
		expect(claims.features).not.toContain("CreateVideoCall");
		expect(claims.featureFlags).toContain("right-now-map");
		expect(claims.upsells).toEqual({});
		expect(typeof claims.exp).toBe("number");
		expect(typeof claims.systemTime).toBe("number");
	});

	test("wrong password → code 4 (client's INVALID_INPUT_PARAMETERS)", async () => {
		const s = await registerAndLogin(app);
		const res = await app.inject({
			method: "POST",
			url: "/v8/sessions",
			headers: clientHeaders({ deviceId: s.deviceId }),
			payload: { email: s.email, password: "wrong-password!", token: null, geohash: null },
		});
		expect(res.statusCode).toBe(400);
		expect(res.json().code).toBe(4);
	});

	test("refresh rotates authToken; replay revokes the family", async () => {
		const s = await registerAndLogin(app);
		const refresh = (authToken: string) =>
			app.inject({
				method: "POST",
				url: "/v8/sessions",
				headers: clientHeaders({ deviceId: s.deviceId }),
				payload: { email: s.email, authToken, token: null, geohash: null },
			});
		const r1 = await refresh(s.authToken);
		expect(r1.statusCode).toBe(200);
		const next = r1.json().authToken as string;
		expect(next).not.toBe(s.authToken);

		// Replaying the consumed token → rejected and the whole family revoked.
		expect((await refresh(s.authToken)).statusCode).toBe(400);
		expect((await refresh(next)).statusCode).toBe(400);
	});

	test("refresh from another device is rejected", async () => {
		const s = await registerAndLogin(app);
		const res = await app.inject({
			method: "POST",
			url: "/v8/sessions",
			headers: clientHeaders({ deviceId: newDeviceId() }),
			payload: { email: s.email, authToken: s.authToken, token: null, geohash: null },
		});
		expect(res.statusCode).toBe(400);
	});

	test("/v9/sessions works without captcha", async () => {
		const s = await registerAndLogin(app);
		const res = await app.inject({
			method: "POST",
			url: "/v9/sessions",
			headers: clientHeaders({ deviceId: s.deviceId }),
			payload: { email: s.email, password: s.password, token: null, geohash: null, captchaToken: null },
		});
		expect(res.statusCode).toBe(200);
	});

	test("duplicate email is rejected", async () => {
		const s = await registerAndLogin(app);
		const res = await app.inject({
			method: "POST",
			url: "/v8/users",
			headers: clientHeaders(),
			payload: { email: s.email, password: "another-password", birthday: ADULT_BIRTHDAY, captchaToken: "", token: "", optIn: false, sessionId: null },
		});
		expect(res.statusCode).toBe(400);
	});
});

describe("authenticated requests", () => {
	test("token on a different device → 401 (device binding)", async () => {
		const s = await registerAndLogin(app);
		const res = await app.inject({ method: "GET", url: "/v3/assignment", headers: clientHeaders({ deviceId: newDeviceId(), token: s.sessionId }) });
		expect(res.statusCode).toBe(401);
	});

	test("/v3/assignment mirrors JWT flags", async () => {
		const s = await registerAndLogin(app);
		const res = await app.inject({ method: "GET", url: "/v3/assignment?geohash=u33dc0", headers: clientHeaders({ deviceId: s.deviceId, token: s.sessionId }) });
		expect(res.statusCode).toBe(200);
		const keys = (res.json().assignments as { key: string; value: string }[]).map((a) => a.key);
		expect(keys).toContain("right-now-map");
		expect(keys).toContain("recaptcha_first_party");
	});

	test("public assignments expose only public flags, recaptcha off", async () => {
		const res = await app.inject({ method: "GET", url: "/public/v1/assignments", headers: clientHeaders() });
		const list = res.json().assignments as { key: string; value: string }[];
		expect(list.find((a) => a.key === "recaptcha_first_party")?.value).toBe("off");
		expect(list.some((a) => a.key === "right-now-map")).toBe(false);
	});

	test("/healthz answers without client headers (app's connection test)", async () => {
		const res = await app.inject({ method: "GET", url: "/healthz" });
		expect(res.statusCode).toBe(200);
		expect(res.json()).toEqual({ ok: true });
	});

	test("JWKS publishes the signing key", async () => {
		const res = await app.inject({ method: "GET", url: "/.well-known/jwks.json" });
		expect(res.statusCode).toBe(200);
		expect(res.json().keys[0].kty).toBe("RSA");
	});
});
