import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app";
import { db } from "../../src/db/client";
import { blocks, entitlementUserOverrides } from "../../src/db/schema";
import { invalidate } from "../../src/cache/local";
import { decodeGeohash, haversineMeters } from "../../src/geo/obfuscate";
import { invalidateRelations } from "../../src/profiles/relations";
import { clientHeaders, registerAndLogin } from "../helpers";

let app: FastifyInstance;
type Session = Awaited<ReturnType<typeof registerAndLogin>>;

beforeAll(async () => {
	app = await buildApp();
});
afterAll(async () => {
	await app.close();
});

const h = (s: Session) => clientHeaders({ deviceId: s.deviceId, token: s.sessionId });
const DAY = 86_400_000;
// A precise spot (Berlin, Alexanderplatz) — 12 chars like upstream requires.
const EXACT = "u33dc1v0twx0";

async function plans(viewer: Session, owner: Session) {
	const res = await app.inject({ method: "GET", url: `/v6/profiles/travel/${owner.profileId}`, headers: h(viewer) });
	expect(res.statusCode).toBe(200);
	return res.json().travelPlans as { travelPlanId: number; geohash: string; showOnProfile: boolean; notes: string | null; startDate: number; endDate: number }[];
}

describe("travel plans", () => {
	test("create, update, delete; others see only visible, upcoming plans — coarsened, without notes", async () => {
		const owner = await registerAndLogin(app);
		const viewer = await registerAndLogin(app);
		const now = Date.now();
		const create = (body: Record<string, unknown>) => app.inject({ method: "POST", url: "/v6/profiles/travel", headers: h(owner), payload: { profileId: Number(owner.profileId), ...body } });

		expect((await create({ geohash: EXACT, startDate: now + DAY, endDate: now + 3 * DAY, showOnProfile: true, notes: "Hotel am Alex" })).statusCode).toBe(200);
		expect((await create({ geohash: "u0yjjd6jk0yp", startDate: now + 5 * DAY, endDate: now + 6 * DAY, showOnProfile: false, notes: null })).statusCode).toBe(200);
		// End before start, or already over: refused.
		expect((await create({ geohash: EXACT, startDate: now + 2 * DAY, endDate: now + DAY, showOnProfile: true })).statusCode).toBe(400);
		expect((await create({ geohash: EXACT, startDate: now - 3 * DAY, endDate: now - DAY, showOnProfile: true })).statusCode).toBe(400);

		const mine = await plans(owner, owner);
		expect(mine.length).toBe(2);
		expect(mine[0]).toMatchObject({ geohash: EXACT, notes: "Hotel am Alex", showOnProfile: true });

		const theirs = await plans(viewer, owner);
		expect(theirs.length).toBe(1);
		expect(theirs[0]!.notes).toBeNull();
		expect(theirs[0]!.geohash).toHaveLength(12);
		expect(theirs[0]!.geohash).not.toBe(EXACT);
		// Same ~5 km area, not the exact spot.
		const offset = haversineMeters(decodeGeohash(EXACT), decodeGeohash(theirs[0]!.geohash));
		expect(offset).toBeGreaterThan(10);
		expect(offset).toBeLessThan(4000);

		const id = mine[0]!.travelPlanId;
		const upd = await app.inject({ method: "POST", url: "/v6/profiles/travel/update", headers: h(owner), payload: { travelPlanId: id, profileId: Number(owner.profileId), geohash: EXACT, startDate: now + DAY, endDate: now + 4 * DAY, showOnProfile: false, notes: "x" } });
		expect(upd.statusCode).toBe(200);
		expect((await plans(viewer, owner)).length).toBe(0);
		// Someone else can't change or delete it.
		expect((await app.inject({ method: "DELETE", url: `/v6/profiles/travel/${id}`, headers: h(viewer) })).statusCode).toBe(404);
		expect((await app.inject({ method: "DELETE", url: `/v6/profiles/travel/${id}`, headers: h(owner) })).statusCode).toBe(200);
		expect((await plans(owner, owner)).length).toBe(1);
	});

	test("travel.plans.max applies; blocked viewers see nothing", async () => {
		const owner = await registerAndLogin(app);
		const viewer = await registerAndLogin(app);
		await db.insert(entitlementUserOverrides).values({ userId: BigInt(owner.profileId), key: "travel.plans.max", value: { max: 1 } });
		await invalidate("entitlement-user", owner.profileId);
		const now = Date.now();
		const body = { profileId: Number(owner.profileId), geohash: EXACT, startDate: now + DAY, endDate: now + 2 * DAY, showOnProfile: true };
		expect((await app.inject({ method: "POST", url: "/v6/profiles/travel", headers: h(owner), payload: body })).statusCode).toBe(200);
		const second = await app.inject({ method: "POST", url: "/v6/profiles/travel", headers: h(owner), payload: body });
		expect(second.statusCode).toBe(402);
		expect(second.json().type).toBe("urn:gr:err:entitlement_limit");

		expect((await plans(viewer, owner)).length).toBe(1);
		await db.insert(blocks).values({ ownerId: BigInt(owner.profileId), targetId: BigInt(viewer.profileId) });
		await invalidateRelations(owner.profileId, viewer.profileId);
		expect((await plans(viewer, owner)).length).toBe(0);
		await db.delete(entitlementUserOverrides).where(eq(entitlementUserOverrides.userId, BigInt(owner.profileId)));
	});
});

describe("spotify favorite songs", () => {
	test("save up to 5 track ids, read back by others; invalid ids and >5 refused", async () => {
		const owner = await registerAndLogin(app);
		const viewer = await registerAndLogin(app);
		const ids = ["4uLU6hMCjMI75M1A2tKUQC", "7GhIk7Il098yCjg4BQjzvb", "0VjIjW4GlUZAMYd2vXMi3b"];
		const save = await app.inject({ method: "POST", url: "/v4/spotify/favorites", headers: h(owner), payload: { songIds: ids } });
		expect(save.statusCode).toBe(200);
		expect((await app.inject({ method: "GET", url: `/v4/spotify/favorites/${owner.profileId}`, headers: h(viewer) })).json()).toEqual({ songIds: ids });

		expect((await app.inject({ method: "POST", url: "/v4/spotify/favorites", headers: h(owner), payload: { songIds: ["not-a-track"] } })).statusCode).toBe(400);
		expect((await app.inject({ method: "POST", url: "/v4/spotify/favorites", headers: h(owner), payload: { songIds: Array(6).fill(ids[0]).map((x, i) => x.slice(0, 21) + String(i)) } })).statusCode).toBe(400);
		// Clearing works.
		await app.inject({ method: "POST", url: "/v4/spotify/favorites", headers: h(owner), payload: { songIds: [] } });
		expect((await app.inject({ method: "GET", url: `/v4/spotify/favorites/${owner.profileId}`, headers: h(owner) })).json()).toEqual({ songIds: [] });
	});
});
