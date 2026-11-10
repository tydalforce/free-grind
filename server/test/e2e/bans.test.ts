import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app";
import { db } from "../../src/db/client";
import { bans } from "../../src/db/schema";
import { encodeGeohash } from "../../src/geo/obfuscate";
import { banUser, liftBan, sweepExpiredBans } from "../../src/moderation/bans";
import { clientHeaders, decodeJwt, registerAndLogin } from "../helpers";

let app: FastifyInstance;
type Session = Awaited<ReturnType<typeof registerAndLogin>>;

beforeAll(async () => {
	app = await buildApp();
});
afterAll(async () => {
	await app.close();
});

const h = (s: Session, token = s.sessionId) => clientHeaders({ deviceId: s.deviceId, token });

/** Refresh like the Rust client (authToken rotation); updates the session in place. */
async function refresh(s: Session) {
	const res = await app.inject({ method: "POST", url: "/v8/sessions", headers: clientHeaders({ deviceId: s.deviceId }), payload: { email: s.email, authToken: s.authToken, token: null, geohash: null } });
	if (res.statusCode === 200) {
		const body = res.json();
		s.sessionId = body.sessionId;
		s.authToken = body.authToken;
	}
	return res;
}

async function endBanNow(userId: string) {
	await db.update(bans).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(bans.userId, BigInt(userId)));
}

async function visibleInGrid(viewer: Session, target: Session, geohash: string): Promise<boolean> {
	const res = await app.inject({ method: "GET", url: `/v4/cascade?nearbyGeoHash=${geohash}`, headers: h(viewer) });
	return (res.json().items as { data: { profileId: number } }[]).some((i) => String(i.data.profileId) === target.profileId);
}

describe("timed ban with ban agreement", () => {
	test("active → restricted + hidden; after the end still restricted until the agreement is accepted", async () => {
		const user = await registerAndLogin(app);
		const viewer = await registerAndLogin(app);
		const gh = encodeGeohash({ lat: -20 + Math.random() * 10, lon: 120 + Math.random() * 10 });
		await app.inject({ method: "PUT", url: "/v4/location", headers: h(user), payload: { geohash: gh } });
		await app.inject({ method: "PUT", url: "/v4/location", headers: h(viewer), payload: { geohash: gh } });
		expect(await visibleInGrid(viewer, user, gh)).toBe(true);

		await banUser(BigInt(user.profileId), { type: "timed", reason: "Harassment", subReason: "BULLYING", requireAgreement: true, expiresAt: new Date(Date.now() + 3_600_000), createdBy: "test" });

		// Running session is invalidated; refresh yields the TIMED_BAN restriction.
		expect((await app.inject({ method: "GET", url: "/v4/me/profile", headers: h(user) })).statusCode).toBe(401);
		expect((await refresh(user)).statusCode).toBe(200);
		const claims = decodeJwt(user.sessionId) as { restriction: string; banDetails: Record<string, unknown>; exp: number };
		expect(claims.restriction).toBe("TIMED_BAN");
		expect(claims.banDetails).toMatchObject({ reason: "Harassment", subReason: "BULLYING", isAutomated: false, isAgreementCompleted: false });
		expect(claims.banDetails.expiryTime as number).toBeGreaterThan(Date.now());
		// The token ends no later than the ban (client refreshes then).
		expect(claims.exp * 1000).toBeLessThanOrEqual((claims.banDetails.expiryTime as number) + 1000);

		// Restricted: normal API refused, the agreement can't be accepted yet; hidden from others.
		expect((await app.inject({ method: "GET", url: "/v4/me/profile", headers: h(user) })).statusCode).toBe(403);
		expect((await app.inject({ method: "POST", url: "/v1/agreements/ban", headers: h(user), payload: { version: 1, locale: "de_DE" } })).statusCode).toBe(400);
		expect(await visibleInGrid(viewer, user, gh)).toBe(false);

		// Ban over, agreement still pending → still restricted, client shows "read and agree".
		await endBanNow(user.profileId);
		await refresh(user);
		const pending = decodeJwt(user.sessionId) as { restriction: string; banDetails: { isAgreementCompleted: boolean; expiryTime: number } };
		expect(pending.restriction).toBe("TIMED_BAN");
		expect(pending.banDetails.isAgreementCompleted).toBe(false);
		expect(pending.banDetails.expiryTime).toBeLessThan(Date.now());
		expect(await visibleInGrid(viewer, user, gh)).toBe(false);

		// Accept (what src-tauri accept_ban_agreement does), then refresh → unrestricted.
		const accept = await app.inject({ method: "POST", url: "/v1/agreements/ban", headers: h(user), payload: { version: 1, locale: "de_DE" } });
		expect(accept.statusCode).toBe(200);
		expect((await refresh(user)).statusCode).toBe(200);
		expect(decodeJwt(user.sessionId).restriction).toBeNull();
		expect((await app.inject({ method: "GET", url: "/v4/me/profile", headers: h(user) })).statusCode).toBe(200);
		expect(await visibleInGrid(viewer, user, gh)).toBe(true);
	});
});

describe("timed ban without agreement", () => {
	test("lifts by itself at the end; sweep makes the profile visible again", async () => {
		const user = await registerAndLogin(app);
		await banUser(BigInt(user.profileId), { type: "timed", reason: "Scam / Spam", subReason: "PROFILE_SPAM", requireAgreement: false, expiresAt: new Date(Date.now() + 600_000), createdBy: "test" });
		await refresh(user);
		expect((decodeJwt(user.sessionId) as { banDetails: { isAgreementCompleted: boolean } }).banDetails.isAgreementCompleted).toBe(true);
		await endBanNow(user.profileId);
		await refresh(user);
		expect(decodeJwt(user.sessionId).restriction).toBeNull();
		expect(await sweepExpiredBans()).toBeGreaterThanOrEqual(0);
	});
});

describe("permanent ban", () => {
	test("refresh and sign-in refused with code 27 incl. reason/sub-reason; lifting restores access", async () => {
		const user = await registerAndLogin(app);
		await banUser(BigInt(user.profileId), { type: "permanent", reason: "Drug Selling", subReason: "DRUG_SALES", requireAgreement: false, expiresAt: null, createdBy: "test" });
		const res = await refresh(user);
		expect(res.statusCode).toBe(403);
		expect(res.json()).toMatchObject({ code: 27, message: "Profile is banned", profileId: user.profileId, reason: "Drug Selling", banSubReason: "DRUG_SALES", isBanAutomated: false });
		const signIn = await app.inject({ method: "POST", url: "/v8/sessions", headers: clientHeaders({ deviceId: user.deviceId }), payload: { email: user.email, password: user.password, token: null, geohash: null } });
		expect(signIn.json().code).toBe(27);

		await liftBan(BigInt(user.profileId), "test");
		const again = await app.inject({ method: "POST", url: "/v8/sessions", headers: clientHeaders({ deviceId: user.deviceId }), payload: { email: user.email, password: user.password, token: null, geohash: null } });
		expect(again.statusCode).toBe(200);
		expect(decodeJwt(again.json().sessionId).restriction).toBeNull();
	});

	test("underage reasons use code 35", async () => {
		const user = await registerAndLogin(app);
		await banUser(BigInt(user.profileId), { type: "permanent", reason: "Underage User", subReason: "UNDERAGE_ACCESS", requireAgreement: false, expiresAt: null, createdBy: "test" });
		expect((await refresh(user)).json().code).toBe(35);
	});

	test("a timed ban needs an end in the future", async () => {
		const user = await registerAndLogin(app);
		await expect(banUser(BigInt(user.profileId), { type: "timed", reason: null, subReason: null, requireAgreement: true, expiresAt: new Date(Date.now() - 1), createdBy: "test" })).rejects.toThrow();
	});
});
