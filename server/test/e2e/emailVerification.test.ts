import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app";
import { invalidate } from "../../src/cache/local";
import { db } from "../../src/db/client";
import { flags } from "../../src/db/schema";
import { clientHeaders, decodeJwt, registerAndLogin } from "../helpers";

let app: FastifyInstance;

async function setMode(mode: "off" | "optional" | "required") {
	await db.update(flags).set({ defaultValue: mode }).where(eq(flags.key, "email_verification"));
	await invalidate("flags");
}

beforeAll(async () => {
	app = await buildApp();
});

afterAll(async () => {
	await setMode("off");
	await Promise.race([app.close(), new Promise((r) => setTimeout(r, 2000))]);
});

/** The newest mail to `email` in Mailpit (docker compose). */
async function mailText(email: string): Promise<string> {
	for (let i = 0; i < 75; i++) {
		await Bun.sleep(200);
		const search = (await fetch(`http://localhost:8025/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`).then((r) => r.json())) as { messages?: { ID: string }[] };
		const id = search.messages?.[0]?.ID;
		if (!id) continue;
		return ((await fetch(`http://localhost:8025/api/v1/message/${id}`).then((r) => r.json())) as { Text: string }).Text;
	}
	throw new Error("no mail");
}

const flagsOf = (token: string) => decodeJwt(token).featureFlags as string[];

describe("e-mail verification (flag email_verification)", () => {
	test("off: no claims, no mail needed", async () => {
		await setMode("off");
		const s = await registerAndLogin(app);
		expect(flagsOf(s.sessionId)).not.toContain("email_unverified");
	});

	test("required: API locked until the mailed code is entered, then a refresh unlocks it", async () => {
		await setMode("required");
		const s = await registerAndLogin(app);
		expect(flagsOf(s.sessionId)).toEqual(expect.arrayContaining(["email_unverified", "email_verification_required"]));
		const h = clientHeaders({ deviceId: s.deviceId, token: s.sessionId });

		const locked = await app.inject({ method: "GET", url: "/v4/cascade?nearbyGeoHash=u33dc0&pageNumber=1", headers: h });
		expect(locked.statusCode).toBe(403);
		expect(locked.json()).toMatchObject({ type: "urn:gr:err:email_verification_required" });
		expect((await app.inject({ method: "GET", url: "/v4/me/profile", headers: h })).statusCode).toBe(200);

		const status = await app.inject({ method: "GET", url: "/v1/me/email-verification", headers: h });
		expect(status.json()).toEqual({ email: s.email, verified: false, mode: "required" });

		const code = /\b(\d{6})\b/.exec(await mailText(s.email))?.[1];
		expect(code).toBeDefined();
		const wrong = String((Number(code) + 1) % 1_000_000).padStart(6, "0");
		expect((await app.inject({ method: "POST", url: "/v1/me/email-verification/verify", headers: h, payload: { code: wrong } })).statusCode).toBe(400);
		const ok = await app.inject({ method: "POST", url: "/v1/me/email-verification/verify", headers: h, payload: { code } });
		expect(ok.json()).toEqual({ verified: true });

		// Old token is invalidated (token version bump); the refreshed one is clean.
		expect((await app.inject({ method: "GET", url: "/v4/me/profile", headers: h })).statusCode).toBe(401);
		const refreshed = await app.inject({ method: "POST", url: "/v8/sessions", headers: clientHeaders({ deviceId: s.deviceId }), payload: { email: s.email, authToken: s.authToken, token: null, geohash: "u33dc0" } });
		const token = (refreshed.json() as { sessionId: string }).sessionId;
		expect(flagsOf(token)).not.toContain("email_unverified");
		const open = await app.inject({ method: "GET", url: "/v4/cascade?nearbyGeoHash=u33dc0&pageNumber=1", headers: clientHeaders({ deviceId: s.deviceId, token }) });
		expect(open.statusCode).toBe(200);
	});

	test("optional: hint only, nothing locked; the mail link verifies too", async () => {
		await setMode("optional");
		const s = await registerAndLogin(app);
		expect(flagsOf(s.sessionId)).toContain("email_unverified");
		expect(flagsOf(s.sessionId)).not.toContain("email_verification_required");
		const h = clientHeaders({ deviceId: s.deviceId, token: s.sessionId });
		expect((await app.inject({ method: "GET", url: "/v4/cascade?nearbyGeoHash=u33dc0&pageNumber=1", headers: h })).statusCode).toBe(200);

		const link = /\/verify-email\?token=([\w-]+)/.exec(await mailText(s.email))?.[1];
		expect(link).toBeDefined();
		const page = await app.inject({ method: "GET", url: `/verify-email?token=${link}` });
		expect(page.statusCode).toBe(200);
		expect(page.body).toContain("E-mail confirmed");
		expect((await app.inject({ method: "GET", url: `/verify-email?token=${link}` })).statusCode).toBe(410);
	});
});
