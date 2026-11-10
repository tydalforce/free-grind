import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { FastifyInstance } from "fastify";
import sharp from "sharp";
import { buildApp } from "../../src/app";
import { db } from "../../src/db/client";
import { blocks, entitlementUserOverrides } from "../../src/db/schema";
import { invalidate } from "../../src/cache/local";
import { sql } from "drizzle-orm";
import { decodeGeohash, destination, encodeGeohash, haversineMeters } from "../../src/geo/obfuscate";
import { setServerSetting } from "../../src/modules/settings/settings";
import { invalidateRelations } from "../../src/profiles/relations";
import { clientHeaders, registerAndLogin } from "../helpers";

let app: FastifyInstance;
type Session = Awaited<ReturnType<typeof registerAndLogin>>;

/** A random spot so parallel/previous test runs don't crowd the same grid. */
const BASE = { lat: 30 + Math.random() * 20, lon: -10 + Math.random() * 30 };

beforeAll(async () => {
	app = await buildApp();
});

afterAll(async () => {
	await setServerSetting("banned_terms", []);
	await app.close();
});

const h = (s: Session) => clientHeaders({ deviceId: s.deviceId, token: s.sessionId });

async function jpeg(w = 800, hgt = 600, color = "#3a7"): Promise<Buffer> {
	return sharp({ create: { width: w, height: hgt, channels: 3, background: color } })
		.composite([{ input: Buffer.from(`<svg width="${w}" height="${hgt}"><circle cx="${w / 2}" cy="${hgt / 2}" r="${hgt / 3}" fill="#fff"/></svg>`) }])
		.jpeg({ quality: 90 })
		.withMetadata({ exif: { IFD0: { Copyright: "secret-gps-test" } } })
		.toBuffer();
}

async function placeAt(s: Session, meters: number, bearing: number) {
	const p = destination(BASE, meters, bearing);
	const res = await app.inject({ method: "PUT", url: "/v4/location", headers: h(s), payload: { geohash: encodeGeohash(p) } });
	expect(res.statusCode).toBe(200);
	return p;
}

async function setProfile(s: Session, body: Record<string, unknown>) {
	const res = await app.inject({ method: "PUT", url: "/v3.1/me/profile", headers: h(s), payload: { showAge: true, showDistance: true, showPosition: true, showTribes: true, approximateDistance: false, ...body } });
	expect(res.statusCode).toBe(200);
}

async function uploadPhoto(s: Session) {
	const res = await app.inject({
		method: "POST",
		url: "/v4/media/upload?thumbCoords=500,100,500,100&takenOnGrindr=false",
		headers: { ...h(s), "content-type": "image/jpeg" },
		payload: await jpeg(),
	});
	expect(res.statusCode).toBe(200);
	return res.json() as { hash: string; mediaId: number; imageSizes: { fullUrl: string; thumbnail: boolean; size: number }[] };
}

describe("profile media", () => {
	test("upload → variants on the public CDN, metadata stripped; set as primary", async () => {
		const s = await registerAndLogin(app);
		const up = await uploadPhoto(s);
		expect(up.hash).toMatch(/^[a-f0-9]{40}$/);
		expect(typeof up.mediaId).toBe("number");
		expect(up.imageSizes.some((i) => i.thumbnail && i.size === 320)).toBe(true);

		const img = await app.inject({ method: "GET", url: `/images/profile/480x480/${up.hash}` });
		expect(img.statusCode).toBe(200);
		expect(img.headers["cache-control"]).toContain("immutable");
		const meta = await sharp(img.rawPayload).metadata();
		expect(Math.max(meta.width!, meta.height!)).toBe(480);
		expect(meta.exif).toBeUndefined();
		const thumb = await sharp((await app.inject({ method: "GET", url: `/images/thumb/75x75/${up.hash}` })).rawPayload).metadata();
		expect([thumb.width, thumb.height]).toEqual([75, 75]);
		expect((await app.inject({ method: "GET", url: `/images/profile/123x123/${up.hash}` })).statusCode).toBe(404);

		expect((await app.inject({ method: "PUT", url: "/v3/me/profile/images", headers: h(s), payload: { primaryImageHash: up.hash, secondaryImageHashes: [] } })).statusCode).toBe(200);
		const me = (await app.inject({ method: "GET", url: "/v4/me/profile", headers: h(s) })).json().profiles[0];
		expect(me.profileImageMediaHash).toBe(up.hash);
		expect(me.medias[0]).toMatchObject({ mediaHash: up.hash, type: 1, state: 1 });
		expect(me.onlineUntil).toBeNull();
	});

	test("more than profile.images.max (5) is refused; a tiny file is refused", async () => {
		const s = await registerAndLogin(app);
		const hashes: string[] = [];
		for (let i = 0; i < 6; i++) {
			const res = await app.inject({ method: "POST", url: "/v4/media/upload?thumbCoords=100,0,100,0", headers: { ...h(s), "content-type": "image/jpeg" }, payload: await jpeg(300, 300, `#${(i * 37 + 16).toString(16).padStart(2, "0")}4488`) });
			hashes.push(res.json().hash);
		}
		const res = await app.inject({ method: "PUT", url: "/v3/me/profile/images", headers: h(s), payload: { primaryImageHash: hashes[0], secondaryImageHashes: hashes.slice(1) } });
		expect(res.statusCode).toBe(402);
		expect(res.json().type).toBe("urn:gr:err:entitlement_limit");
		const tiny = await app.inject({ method: "POST", url: "/v4/media/upload", headers: { ...h(s), "content-type": "image/jpeg" }, payload: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6, 7, 8, 9]) });
		expect(tiny.statusCode).toBe(400);
	});

	test("deleting removes it from the profile and the CDN", async () => {
		const s = await registerAndLogin(app);
		const up = await uploadPhoto(s);
		await app.inject({ method: "PUT", url: "/v3/me/profile/images", headers: h(s), payload: { primaryImageHash: up.hash, secondaryImageHashes: [] } });
		expect((await app.inject({ method: "DELETE", url: "/v3/me/profile/images", headers: h(s), payload: { media_hashes: [up.hash] } })).statusCode).toBe(200);
		expect((await app.inject({ method: "GET", url: `/images/profile/480x480/${up.hash}` })).statusCode).toBe(404);
		expect((await app.inject({ method: "GET", url: "/v4/me/profile", headers: h(s) })).json().profiles[0].profileImageMediaHash).toBeNull();
	});
});

describe("incognito", () => {
	test("offline everywhere while on; needs the entitlement; switching off shows online again", async () => {
		const viewer = await registerAndLogin(app);
		const ghost = await registerAndLogin(app);
		const viewerPos = await placeAt(viewer, 60_000, 3);
		await placeAt(ghost, 60_200, 3);
		await setProfile(ghost, { displayName: "Ghost" });
		// A chat so the inbox and conversation endpoints have something to show.
		await app.inject({ method: "POST", url: "/v4/chat/message/send", headers: h(ghost), payload: { type: "Text", target: { type: "Direct", targetId: Number(viewer.profileId) }, body: { text: "hi" } } });

		const gh = encodeGeohash(viewerPos);
		const gridCard = async () =>
			((await app.inject({ method: "GET", url: `/v4/cascade?nearbyGeoHash=${gh}&pageNumber=1`, headers: h(viewer) })).json().items as { data: Record<string, unknown> }[]).find(
				(i) => String(i.data.profileId) === ghost.profileId,
			)!.data;
		const detail = async () => (await app.inject({ method: "GET", url: `/v7/profiles/${ghost.profileId}`, headers: h(viewer) })).json().profiles[0] as Record<string, unknown>;
		const inboxEntry = async () =>
			((await app.inject({ method: "POST", url: "/v4/inbox?page=1", headers: h(viewer), payload: {} })).json().entries as { data: { participants: Record<string, unknown>[] } }[])[0]!.data.participants[0]!;
		const settings = async (s: Session) => (await app.inject({ method: "GET", url: "/v3/me/prefs/settings", headers: h(s) })).json() as { incognito: boolean };
		const put = (incognito: boolean) => app.inject({ method: "PUT", url: "/v3/me/prefs/settings", headers: h(ghost), payload: { settings: { incognito } } });

		// The ghost browses, which marks it online.
		await app.inject({ method: "GET", url: `/v4/cascade?nearbyGeoHash=${gh}&pageNumber=1`, headers: h(ghost) });
		expect(typeof (await gridCard()).onlineUntil).toBe("number");

		expect((await put(true)).statusCode).toBe(200);
		expect((await settings(ghost)).incognito).toBe(true);
		// Browsing (which marks you online) doesn't bring the online state back.
		await app.inject({ method: "GET", url: `/v4/cascade?nearbyGeoHash=${gh}&pageNumber=1`, headers: h(ghost) });
		expect((await gridCard()).onlineUntil).toBeNull();
		expect((await detail()).onlineUntil ?? null).toBeNull();
		expect(await inboxEntry()).toMatchObject({ onlineUntil: null });
		const online = (await app.inject({ method: "GET", url: `/v4/cascade?nearbyGeoHash=${gh}&pageNumber=1&onlineOnly=true`, headers: h(viewer) })).json().items as { data: { profileId: number } }[];
		expect(online.map((i) => String(i.data.profileId))).not.toContain(ghost.profileId);

		expect((await put(false)).statusCode).toBe(200);
		expect(typeof (await gridCard()).onlineUntil).toBe("number");

		// Without the entitlement it can't be switched on, and an active one ends.
		await put(true);
		await db.insert(entitlementUserOverrides).values({ userId: BigInt(ghost.profileId), key: "incognito", value: false }).onConflictDoUpdate({ target: [entitlementUserOverrides.userId, entitlementUserOverrides.key], set: { value: false } });
		await invalidate("entitlement-user", ghost.profileId);
		expect((await settings(ghost)).incognito).toBe(false);
		expect((await put(true)).statusCode).toBe(402);
	});
});

describe("profile fields", () => {
	test("PUT full replace persists text; PATCH ignores displayName", async () => {
		const s = await registerAndLogin(app);
		await setProfile(s, { displayName: "Alex", aboutMe: "Hallo", grindrTribes: [1, 3], lookingFor: [2], height: 180, sexualPosition: 2 });
		await app.inject({ method: "PATCH", url: "/v4/me/profile", headers: h(s), payload: { displayName: "Ignored", height: 181 } });
		const me = (await app.inject({ method: "GET", url: "/v4/me/profile", headers: h(s) })).json().profiles[0];
		expect(me).toMatchObject({ displayName: "Alex", aboutMe: "Hallo", grindrTribes: [1, 3], lookingFor: [2], height: 181, sexualPosition: 2 });
		expect(typeof me.age).toBe("number");
	});

	test("banned terms → 400 hit_banned_terms per field", async () => {
		await setServerSetting("banned_terms", ["forbiddenword"]);
		const s = await registerAndLogin(app);
		const before = (await app.inject({ method: "GET", url: "/v4/me/profile", headers: h(s) })).json().profiles[0];
		const res = await app.inject({ method: "PUT", url: "/v3.1/me/profile", headers: h(s), payload: { displayName: "ok", aboutMe: "this has ForbiddenWord inside", height: 199 } });
		expect(res.statusCode).toBe(400);
		expect(res.json()).toMatchObject({ type: "urn:gr:err:hit_banned_terms", about_me: { terms: ["forbiddenword"] } });
		expect(res.json().display_name).toBeUndefined();
		// Rejected wholesale: not even the clean fields were stored.
		const after = (await app.inject({ method: "GET", url: "/v4/me/profile", headers: h(s) })).json().profiles[0];
		expect(after.displayName).toBe(before.displayName);
		expect(after.height).toBe(before.height);
		// Whole words only, accents ignored, wildcard suffix.
		await setServerSetting("banned_terms", ["ass", "nazi*", "böse wort"]);
		const ok = await app.inject({ method: "PUT", url: "/v3.1/me/profile", headers: h(s), payload: { displayName: "Klasse", aboutMe: "Passt schon, Assistent" } });
		expect(ok.statusCode).toBe(200);
		const hit = await app.inject({ method: "PUT", url: "/v3.1/me/profile", headers: h(s), payload: { displayName: "ASS", aboutMe: "Nazis raus, BOSE   Wort" } });
		expect(hit.statusCode).toBe(400);
		expect(hit.json()).toMatchObject({ display_name: { terms: ["ass"] }, about_me: { terms: ["nazis", "bose   wort"] } });
		await setServerSetting("banned_terms", []);
	});

	test("prefs settings round-trip (legacy mapLocationRadius name accepted)", async () => {
		const s = await registerAndLogin(app);
		await app.inject({ method: "PUT", url: "/v3/me/prefs/settings", headers: h(s), payload: { settings: { showOnMap: true, mapLocationRadius: 400, hideViewedMe: true } } });
		const prefs = (await app.inject({ method: "GET", url: "/v3/me/prefs/settings", headers: h(s) })).json();
		expect(prefs).toMatchObject({ showOnMap: true, mapLocationFuzzRadius: 400, hideViewedMe: true });
	});

	test("location accepts lat/lon fallback bodies", async () => {
		const s = await registerAndLogin(app);
		expect((await app.inject({ method: "PUT", url: "/v4/location", headers: h(s), payload: { lat: 52.5, lon: 13.4 } })).statusCode).toBe(200);
		expect((await app.inject({ method: "PUT", url: "/v4/location", headers: h(s), payload: { latitude: 52.5, longitude: 13.4 } })).statusCode).toBe(200);
		expect((await app.inject({ method: "PUT", url: "/v4/location", headers: h(s), payload: { foo: 1 } })).statusCode).toBe(400);
	});
});

describe("grid", () => {
	test("filters hasAlbum, rightNow, notRecentlyChatted; cards carry chatted/unread/viewed/rightNow", async () => {
		const viewer = await registerAndLogin(app);
		const withAlbum = await registerAndLogin(app);
		const hosting = await registerAndLogin(app);
		const chatPartner = await registerAndLogin(app);
		const viewerPos = await placeAt(viewer, 40_000, 2);
		const others = [withAlbum, hosting, chatPartner];
		for (const [i, s] of others.entries()) {
			await placeAt(s, 40_300 + i * 100, 2);
			await setProfile(s, { displayName: `F${i}` });
		}

		// Album with one picture.
		const albumId = (await app.inject({ method: "POST", url: "/v2/albums", headers: h(withAlbum), payload: { albumName: "A" } })).json().albumId as number;
		const boundary = "----fgtest";
		const payload = Buffer.concat([
			Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="content"; filename="a.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`),
			await jpeg(80, 60),
			Buffer.from(`\r\n--${boundary}--\r\n`),
		]);
		const up = await app.inject({ method: "POST", url: `/v1/albums/${albumId}/content?width=80&height=60&isFresh=false`, headers: { ...h(withAlbum), "content-type": `multipart/form-data; boundary=${boundary}` }, payload });
		expect(up.statusCode).toBe(200);

		// Active, hosting Right Now post (and a discreet one that must not count).
		await db.execute(sql`INSERT INTO rightnow_posts (author_id, status, hosting, anchor, is_discreet, expiration)
			VALUES (${BigInt(hosting.profileId)}, 'ACTIVE', true, ST_SetSRID(ST_MakePoint(0, 0), 4326)::geography, 'FALSE', now() + interval '1 hour'),
			       (${BigInt(withAlbum.profileId)}, 'ACTIVE', false, ST_SetSRID(ST_MakePoint(0, 0), 4326)::geography, 'TRUE', now() + interval '1 hour')`);

		// chatPartner writes the viewer (unread for the viewer); the viewer looked at withAlbum.
		const msg = await app.inject({ method: "POST", url: "/v4/chat/message/send", headers: h(chatPartner), payload: { type: "Text", target: { type: "Direct", targetId: Number(viewer.profileId) }, body: { text: "hi" } } });
		expect(msg.statusCode).toBe(201);
		expect((await app.inject({ method: "POST", url: `/v4/views/${withAlbum.profileId}`, headers: h(viewer) })).statusCode).toBe(200);

		const gh = encodeGeohash(viewerPos);
		const ids = async (query: string) =>
			((await app.inject({ method: "GET", url: `/v4/cascade?nearbyGeoHash=${gh}&pageNumber=1${query}`, headers: h(viewer) })).json().items as { data: { profileId: number } }[]).map((i) => String(i.data.profileId));

		const albumIds = await ids("&hasAlbum=true");
		expect(albumIds).toContain(withAlbum.profileId);
		expect(albumIds).not.toContain(hosting.profileId);

		const rightNowIds = await ids("&rightNow=true");
		expect(rightNowIds).toContain(hosting.profileId);
		expect(rightNowIds).not.toContain(withAlbum.profileId);

		const notChatted = await ids("&notRecentlyChatted=true");
		expect(notChatted).not.toContain(chatPartner.profileId);
		expect(notChatted).toContain(hosting.profileId);

		const all = (await app.inject({ method: "GET", url: `/v4/cascade?nearbyGeoHash=${gh}&pageNumber=1`, headers: h(viewer) })).json().items as { data: Record<string, unknown> }[];
		const card = (s: Session) => all.find((i) => String(i.data.profileId) === s.profileId)!.data;
		expect(card(hosting)).toMatchObject({ rightNow: "HOSTING", chatted: false, unreadCount: 0 });
		expect(card(withAlbum)).toMatchObject({ rightNow: "NOT_ACTIVE", viewed: true });
		expect(card(chatPartner)).toMatchObject({ chatted: true, unreadCount: 1, viewed: false });
	});

	test("cascade: nearest first, rounded public distances, self/blocked excluded, filters, map fields only with showOnMap", async () => {
		const viewer = await registerAndLogin(app);
		const near = await registerAndLogin(app);
		const far = await registerAndLogin(app);
		const blocked = await registerAndLogin(app);
		const viewerPos = await placeAt(viewer, 0, 0);
		await placeAt(near, 800, 1);
		await placeAt(far, 4000, 2);
		await placeAt(blocked, 1200, 3);
		await setProfile(near, { displayName: "Near", grindrTribes: [5] });
		await setProfile(far, { displayName: "Far", grindrTribes: [7] });
		await setProfile(blocked, { displayName: "Blocked" });
		// near shares its (fuzzed) map position, far does not.
		await app.inject({ method: "PUT", url: "/v3/me/prefs/settings", headers: h(near), payload: { settings: { showOnMap: true, mapLocationFuzzRadius: 300 } } });
		await db.insert(blocks).values({ ownerId: BigInt(blocked.profileId), targetId: BigInt(viewer.profileId) });
		await invalidateRelations(viewer.profileId, blocked.profileId);

		const gh = encodeGeohash(viewerPos);
		const res = await app.inject({ method: "GET", url: `/v4/cascade?nearbyGeoHash=${gh}&pageNumber=1`, headers: h(viewer) });
		expect(res.statusCode).toBe(200);
		const items = res.json().items as { type: string; data: Record<string, unknown> }[];
		const ids = items.map((i) => String(i.data.profileId));
		expect(ids).not.toContain(viewer.profileId);
		expect(ids).not.toContain(blocked.profileId);
		expect(ids.indexOf(near.profileId)).toBeGreaterThanOrEqual(0);
		expect(ids.indexOf(near.profileId)).toBeLessThan(ids.indexOf(far.profileId));

		const nearItem = items.find((i) => String(i.data.profileId) === near.profileId)!.data;
		expect((nearItem.distanceMeters as number) % 100).toBe(0);
		expect(typeof nearItem.fuzzedLat).toBe("number");
		expect(nearItem.lat).toBeUndefined();
		// The map position is the fuzzed one: within radius of the real point, not on it.
		const realNear = destination(BASE, 800, 1);
		const offset = haversineMeters(realNear, { lat: nearItem.fuzzedLat as number, lon: nearItem.fuzzedLon as number });
		expect(offset).toBeLessThanOrEqual(301);
		expect(offset).toBeGreaterThan(0);
		// The fuzz radius never leaves the server.
		expect(nearItem.locationRadius).toBeUndefined();
		expect(JSON.stringify(res.json())).not.toContain("locationRadius");
		const farItem = items.find((i) => String(i.data.profileId) === far.profileId)!.data;
		expect(farItem.fuzzedLat).toBeUndefined();

		// Opting out of the map hides the coordinates at once (not after the 20 s candidate cache).
		await app.inject({ method: "PUT", url: "/v3/me/prefs/settings", headers: h(near), payload: { settings: { showOnMap: false } } });
		const again = (await app.inject({ method: "GET", url: `/v4/cascade?nearbyGeoHash=${gh}&pageNumber=1`, headers: h(viewer) })).json().items as { data: Record<string, unknown> }[];
		const nearAgain = again.find((i) => String(i.data.profileId) === near.profileId)!.data;
		expect(nearAgain.fuzzedLat).toBeUndefined();
		expect(nearAgain.fuzzedLon).toBeUndefined();

		const tribe = await app.inject({ method: "GET", url: `/v4/cascade?nearbyGeoHash=${gh}&tribes=7`, headers: h(viewer) });
		const tribeIds = (tribe.json().items as { data: { profileId: number } }[]).map((i) => String(i.data.profileId));
		expect(tribeIds).toContain(far.profileId);
		expect(tribeIds).not.toContain(near.profileId);

	});

	test("blocked profile detail is the upstream stub; search pages by keyset", async () => {
		const viewer = await registerAndLogin(app);
		const other = await registerAndLogin(app);
		const viewerPos = await placeAt(viewer, 20_000, 0.5);
		await placeAt(other, 20_600, 0.5);
		await setProfile(other, { displayName: "Other" });

		const before = (await app.inject({ method: "GET", url: `/v7/profiles/${other.profileId}`, headers: h(viewer) })).json().profiles[0];
		expect(before.displayName).toBe("Other");
		expect(typeof before.distance).toBe("number");

		const search = await app.inject({ method: "GET", url: `/v7/search?nearbyGeoHash=${encodeGeohash(viewerPos)}`, headers: h(viewer) });
		expect(search.statusCode).toBe(200);
		const sj = search.json();
		expect(sj.profiles.some((p: { profileId: number }) => String(p.profileId) === other.profileId)).toBe(true);
		const next = await app.inject({ method: "GET", url: `/v7/search?nearbyGeoHash=${encodeGeohash(viewerPos)}&searchAfterDistance=${sj.lastDistanceInKm}&searchAfterProfileId=${sj.lastProfileId}`, headers: h(viewer) });
		expect((next.json().profiles as { profileId: number }[]).some((p) => p.profileId === sj.lastProfileId)).toBe(false);

		await db.insert(blocks).values({ ownerId: BigInt(other.profileId), targetId: BigInt(viewer.profileId) });
		await invalidateRelations(viewer.profileId, other.profileId);
		const stub = (await app.inject({ method: "GET", url: `/v7/profiles/${other.profileId}`, headers: h(viewer) })).json().profiles[0];
		expect(stub).toMatchObject({ profileId: other.profileId, displayName: "4", lastUpdatedTime: null });
		expect(decodeGeohash(encodeGeohash(viewerPos)).lat).toBeCloseTo(viewerPos.lat, 4);
	});
});
