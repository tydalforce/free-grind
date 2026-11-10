import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import sharp from "sharp";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app";
import { invalidate } from "../../src/cache/local";
import { db } from "../../src/db/client";
import { albumShares, entitlementUserOverrides } from "../../src/db/schema";
import { clientHeaders, registerAndLogin } from "../helpers";
// The app's own schema: the album page parses the feed with it.
import { sharedAlbumViewSchema } from "../../../src/types/albums";

type Session = Awaited<ReturnType<typeof registerAndLogin>>;
type Obj = Record<string, any>;

let app: FastifyInstance;
beforeAll(async () => {
	app = await buildApp();
});
afterAll(async () => {
	await app.close();
});

const h = (s: Session) => clientHeaders({ deviceId: s.deviceId, token: s.sessionId });
const cid = (a: Session, b: Session) => {
	const [x, y] = [BigInt(a.profileId), BigInt(b.profileId)];
	return x < y ? `${x}:${y}` : `${y}:${x}`;
};

async function jpeg(seed: number): Promise<Buffer> {
	const raw = Buffer.from(Array.from({ length: 80 * 60 * 3 }, (_, i) => (i * seed * 7919) % 256));
	return sharp(raw, { raw: { width: 80, height: 60, channels: 3 } }).jpeg({ quality: 95 }).toBuffer();
}

function multipart(file: Buffer, type = "image/jpeg") {
	const boundary = `----fg${Math.random().toString(16).slice(2)}`;
	const payload = Buffer.concat([
		Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="content"; filename="a.jpg"\r\nContent-Type: ${type}\r\n\r\n`),
		file,
		Buffer.from(`\r\n--${boundary}--\r\n`),
	]);
	return { payload, contentType: `multipart/form-data; boundary=${boundary}` };
}

async function createAlbum(s: Session, name = "Privat") {
	const res = await app.inject({ method: "POST", url: "/v2/albums", headers: h(s), payload: { albumName: name } });
	expect(res.statusCode).toBe(200);
	return res.json().albumId as number;
}

async function upload(s: Session, albumId: number, file: Buffer) {
	const mp = multipart(file);
	return app.inject({ method: "POST", url: `/v1/albums/${albumId}/content?width=80&height=60&isFresh=false`, headers: { ...h(s), "content-type": mp.contentType }, payload: mp.payload });
}

async function override(s: Session, key: string, value: unknown) {
	await db.insert(entitlementUserOverrides).values({ userId: BigInt(s.profileId), key, value }).onConflictDoUpdate({ target: [entitlementUserOverrides.userId, entitlementUserOverrides.key], set: { value } });
	await invalidate("entitlement-user", s.profileId);
}

describe("albums", () => {
	test("create, upload (dedup), order, rename, details, delete content; limits", async () => {
		const a = await registerAndLogin(app);
		const id = await createAlbum(a);
		const first = await upload(a, id, await jpeg(3));
		expect(first.statusCode).toBe(200);
		expect(first.json()).toMatchObject({ contentUrl: null });
		const c1 = first.json().contentId as number;
		// Byte-identical photo → same contentId.
		expect((await upload(a, id, await jpeg(3))).json().contentId).toBe(c1);
		const c2 = (await upload(a, id, await jpeg(5))).json().contentId as number;

		const list = (await app.inject({ method: "GET", url: "/v1/albums", headers: h(a) })).json().albums as Obj[];
		expect(list).toHaveLength(1);
		expect(list[0]).toMatchObject({ albumId: id, albumName: "Privat", profileId: Number(a.profileId), isShareable: true, sharedCount: 0 });
		expect(list[0]!.createdAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d$/);
		// Newest first.
		expect(list[0]!.content.map((c: Obj) => c.contentId)).toEqual([c2, c1]);
		expect(list[0]!.content[0]).toMatchObject({ contentType: "image/jpeg", statusId: 1, processing: false });
		expect(list[0]!.content[0].contentHash).toBeString();

		expect((await app.inject({ method: "POST", url: `/v1/albums/${id}/content/order`, headers: h(a), payload: { contentIds: [c1] } })).statusCode).toBe(400);
		expect((await app.inject({ method: "POST", url: `/v1/albums/${id}/content/order`, headers: h(a), payload: { contentIds: [c1, c2] } })).statusCode).toBe(200);
		expect((await app.inject({ method: "PUT", url: `/v2/albums/${id}`, headers: h(a), payload: { albumName: "Neu" } })).json()).toEqual({ albumId: id, albumName: "Neu" });

		const details = (await app.inject({ method: "GET", url: `/v2/albums/${id}`, headers: h(a) })).json();
		expect(details.content.map((c: Obj) => c.contentId)).toEqual([c1, c2]);
		expect(details).toMatchObject({ albumName: "Neu", contentCount: { imageCount: 2, videoCount: 0 } });
		// Signed media: full file, preview and blurred cover all served.
		for (const key of ["url", "thumbUrl", "coverUrl"]) {
			const u = new URL(details.content[0][key]);
			const res = await app.inject({ method: "GET", url: u.pathname + u.search });
			expect(res.statusCode).toBe(200);
			expect(res.headers["content-type"]).toBe("image/jpeg");
		}
		expect((await app.inject({ method: "GET", url: `/v1/albums/${id}/content/${c2}/processing`, headers: h(a) })).json()).toEqual({ processing: false });
		const poster = (await app.inject({ method: "GET", url: `/v1/albums/${id}/content/${c2}/poster`, headers: h(a) })).json();
		expect(poster.posterUrl).toContain("/thumb?");
		expect(poster.blurredPosterUrl).toContain("/blur?");
		expect((await app.inject({ method: "DELETE", url: `/v1/albums/${id}/content/${c2}`, headers: h(a) })).statusCode).toBe(200);

		await override(a, "albums.maxImagesPerAlbum", { max: 1 });
		expect((await upload(a, id, await jpeg(9))).statusCode).toBe(402);
		await override(a, "albums.maxCount", { max: 1 });
		expect((await app.inject({ method: "POST", url: "/v2/albums", headers: h(a), payload: { albumName: null } })).statusCode).toBe(402);
		const storage = (await app.inject({ method: "GET", url: "/v1/albums/storage", headers: h(a) })).json();
		expect(storage).toMatchObject({ subscriptionType: "FreeAlbums", maxAlbums: 1, maxContentItemsPerAlbum: 1, maxVideosPerAlbum: 2_147_483_647 });
		expect(storage.maxContentSizeHumanReadable).toMatch(/MB$/);

		// Others can't touch it.
		const b = await registerAndLogin(app);
		expect((await app.inject({ method: "GET", url: `/v2/albums/${id}`, headers: h(b) })).statusCode).toBe(403);
		expect((await app.inject({ method: "DELETE", url: `/v1/albums/${id}`, headers: h(b) })).statusCode).toBe(403);
		expect((await app.inject({ method: "DELETE", url: `/v1/albums/${id}`, headers: h(a) })).statusCode).toBe(200);
		expect((await app.inject({ method: "DELETE", url: `/v1/albums/${id}`, headers: h(a) })).statusCode).toBe(403);
	});

	test("share → album message in chat; recipient views; unshare; recipient removal", async () => {
		const a = await registerAndLogin(app);
		const b = await registerAndLogin(app);
		const id = await createAlbum(a);
		const content = (await upload(a, id, await jpeg(11))).json().contentId as number;

		expect((await app.inject({ method: "POST", url: `/v4/albums/${id}/shares`, headers: h(a), payload: { profiles: [{ profileId: Number(b.profileId), expirationType: "INDEFINITE" }] } })).statusCode).toBe(200);
		expect((await app.inject({ method: "GET", url: `/v1/albums/${id}/shares`, headers: h(a) })).json()).toEqual({ profileIds: [Number(b.profileId)] });

		const msgs = (await app.inject({ method: "GET", url: `/v5/chat/conversation/${cid(a, b)}/message`, headers: h(b) })).json().messages as Obj[];
		expect(msgs).toHaveLength(1);
		expect(msgs[0]).toMatchObject({ type: "Album", chat1Type: "album_share", dynamic: true, senderId: Number(a.profileId) });
		expect(msgs[0]!.body).toMatchObject({ albumId: id, isViewable: true, ownerProfileId: Number(a.profileId), albumNumber: 1, totalAlbumsShared: 1, hasPhoto: true, hasVideo: false, hasUnseenContent: true, expirationType: "INDEFINITE", viewableUntil: null });
		expect(msgs[0]!.body.coverUrl).toContain("/blur?");

		const shared = (await app.inject({ method: "GET", url: `/v2/albums/shares/${a.profileId}`, headers: h(b) })).json().albums as Obj[];
		expect(shared).toHaveLength(1);
		expect(shared[0]).toMatchObject({ albumId: id, profileId: Number(a.profileId), albumViewable: true, contentCount: { imageCount: 1, videoCount: 0 } });
		expect((await app.inject({ method: "POST", url: "/v2/albums/shares", headers: h(b), payload: { profileId: Number(a.profileId) } })).json()).toEqual({ profileId: Number(a.profileId), hasAlbum: true, hasSharedWithMe: true });

		expect((await app.inject({ method: "GET", url: `/v3/albums/${id}/view`, headers: h(b) })).statusCode).toBe(200);
		const view = (await app.inject({ method: "GET", url: `/v2/albums/${id}`, headers: h(b) })).json();
		expect(view).toMatchObject({ albumId: id, profileId: Number(a.profileId), albumNumber: 1, hasUnseenContent: false, isShareable: false });
		expect(view.content[0]).toMatchObject({ contentId: content, remainingViews: -1 });
		expect(view.content[0].contentHash).toBeUndefined();

		const feed = (await app.inject({ method: "POST", url: "/v3/pressie-albums/feed", headers: h(b), payload: {} })).json();
		expect(feed.sharedAlbums).toHaveLength(1);
		expect(feed.sharedAlbums[0]).toMatchObject({ albumId: id, ownerProfileId: Number(a.profileId), imageCount: 1, albumViewable: true });
		expect(feed.sharedAlbums[0].coverContent.location).toContain("/blur?");

		// Reaction on an album item, sent by the recipient.
		const react = await app.inject({ method: "POST", url: "/v4/chat/message/send", headers: h(b), payload: { type: "AlbumContentReply", target: { type: "Direct", targetId: Number(a.profileId) }, body: { albumId: id, albumContentId: content, albumContentReply: "wow" } } });
		expect(react.statusCode).toBe(201);
		expect(react.json().body).toMatchObject({ albumId: id, ownerProfileId: Number(a.profileId), albumContentId: content, viewable: true, albumContentReply: "wow", contentType: "image/jpeg" });

		// Unshare: the old message stays, but is no longer viewable.
		expect((await app.inject({ method: "PUT", url: `/v1/albums/${id}/unshares`, headers: h(a), payload: { profiles: [{ profileId: Number(b.profileId), shareId: crypto.randomUUID() }] } })).statusCode).toBe(200);
		const after = (await app.inject({ method: "GET", url: `/v5/chat/conversation/${cid(a, b)}/message`, headers: h(b) })).json().messages as Obj[];
		expect(after.find((m) => m.type === "Album")!.body).toMatchObject({ isViewable: false, ownerProfileId: null, coverUrl: null, albumNumber: null });
		expect((await app.inject({ method: "GET", url: `/v2/albums/${id}`, headers: h(b) })).statusCode).toBe(403);

		// Recipient-side removal; 403 once gone.
		await app.inject({ method: "POST", url: `/v4/albums/${id}/shares`, headers: h(a), payload: { profiles: [{ profileId: Number(b.profileId), expirationType: 0 }] } });
		expect((await app.inject({ method: "PUT", url: `/v1/albums/${id}/shares/remove`, headers: h(b) })).statusCode).toBe(200);
		expect((await app.inject({ method: "PUT", url: `/v1/albums/${id}/shares/remove`, headers: h(b) })).statusCode).toBe(403);
	});

	test("expiring shares: ONCE starts at first view, second view refused, ends after expiry; entitlement", async () => {
		const a = await registerAndLogin(app);
		const b = await registerAndLogin(app);
		const id = await createAlbum(a);
		await upload(a, id, await jpeg(13));
		expect((await app.inject({ method: "POST", url: `/v4/albums/${id}/shares`, headers: h(a), payload: { profiles: [{ profileId: Number(b.profileId), expirationType: "ONCE" }] } })).statusCode).toBe(200);
		const msg = (await app.inject({ method: "GET", url: `/v5/chat/conversation/${cid(a, b)}/message`, headers: h(b) })).json().messages[0] as Obj;
		expect(msg.type).toBe("ExpiringAlbumV2");
		expect(msg.body).toMatchObject({ expirationType: "ONCE", viewableUntil: null, isViewable: true });

		expect((await app.inject({ method: "GET", url: `/v3/albums/${id}/view`, headers: h(b) })).statusCode).toBe(200);
		expect((await app.inject({ method: "GET", url: `/v3/albums/${id}/view`, headers: h(b) })).statusCode).toBe(403);
		const viewing = (await app.inject({ method: "GET", url: `/v2/albums/${id}`, headers: h(b) })).json();
		const until = new URL(viewing.content[0].url).searchParams.get("Expires");
		expect(Number(until) * 1000 - Date.now()).toBeLessThanOrEqual(30 * 60_000 + 1000);
		const body = (await app.inject({ method: "GET", url: `/v5/chat/conversation/${cid(a, b)}/message`, headers: h(b) })).json().messages[0].body;
		expect(body.viewableUntil - Date.now()).toBeGreaterThan(29 * 60_000);

		// Expired → gone everywhere.
		await db.update(albumShares).set({ expiresAt: new Date(Date.now() - 1000) }).where(and(eq(albumShares.albumId, id), eq(albumShares.profileId, BigInt(b.profileId))));
		expect((await app.inject({ method: "GET", url: `/v2/albums/${id}`, headers: h(b) })).statusCode).toBe(403);
		expect((await app.inject({ method: "GET", url: `/v5/chat/conversation/${cid(a, b)}/message`, headers: h(b) })).json().messages[0].body.isViewable).toBe(false);

		await override(a, "albums.expiringShares", false);
		const denied = await app.inject({ method: "POST", url: `/v4/albums/${id}/shares`, headers: h(a), payload: { profiles: [{ profileId: Number(b.profileId), expirationType: "ONE_HOUR" }] } });
		expect(denied.statusCode).toBe(402);
		expect(denied.json().type).toBe("urn:gr:err:tiered_feature");
	});

	test("drawer media into an album; expiring status endpoints", async () => {
		const a = await registerAndLogin(app);
		const up = await app.inject({ method: "POST", url: "/v5/chat/media/upload", headers: { ...h(a), "content-type": "image/jpeg" }, payload: await jpeg(17) });
		const mediaId = up.json().mediaId as number;
		await app.inject({ method: "PUT", url: `/v4/chat/media/drawer/${mediaId}`, headers: h(a) });
		const id = await createAlbum(a);
		expect((await app.inject({ method: "POST", url: `/v1/albums/${id}/content/chat/list-by-id?isFresh=false`, headers: h(a), payload: { ids: [mediaId] } })).statusCode).toBe(200);
		const details = (await app.inject({ method: "GET", url: `/v2/albums/${id}`, headers: h(a) })).json();
		expect(details.content).toHaveLength(1);
		expect(details.content[0].contentHash).not.toBe(up.json().mediaHash);

		expect((await app.inject({ method: "GET", url: "/v4/pics/expiring/status", headers: h(a) })).json()).toEqual({ total: 2_147_483_647, available: 2_147_483_647 });
		await override(a, "chat.expiringImages.perDay", { windows: [{ count: 3, window: "day" }] });
		expect((await app.inject({ method: "GET", url: "/v4/pics/expiring/status", headers: h(a) })).json()).toEqual({ total: 3, available: 3 });
		await override(a, "chat.expiringVideos.enabled", false);
		expect((await app.inject({ method: "GET", url: "/v4/videos/expiring/status", headers: h(a) })).json()).toEqual({ total: 0, available: 0 });
	});

	test("expiring album allowance: status endpoint and quota per expiring share", async () => {
		const a = await registerAndLogin(app);
		const b = await registerAndLogin(app);
		const c = await registerAndLogin(app);
		const id = await createAlbum(a);
		await upload(a, id, await jpeg(19));
		const status = async () => (await app.inject({ method: "GET", url: "/v4/albums/expiring/status", headers: h(a) })).json();
		expect(await status()).toEqual({ total: 2_147_483_647, available: 2_147_483_647 });

		await override(a, "albums.expiringShares.perDay", { windows: [{ count: 1, window: "day" }] });
		expect(await status()).toEqual({ total: 1, available: 1 });
		// INDEFINITE shares don't count.
		expect((await app.inject({ method: "POST", url: `/v4/albums/${id}/shares`, headers: h(a), payload: { profiles: [{ profileId: Number(c.profileId), expirationType: "INDEFINITE" }] } })).statusCode).toBe(200);
		expect(await status()).toEqual({ total: 1, available: 1 });
		expect((await app.inject({ method: "POST", url: `/v4/albums/${id}/shares`, headers: h(a), payload: { profiles: [{ profileId: Number(b.profileId), expirationType: "ONE_HOUR" }] } })).statusCode).toBe(200);
		expect(await status()).toEqual({ total: 1, available: 0 });
		const denied = await app.inject({ method: "POST", url: `/v4/albums/${id}/shares`, headers: h(a), payload: { profiles: [{ profileId: Number(b.profileId), expirationType: "ONCE" }] } });
		expect(denied.statusCode).toBe(402);
		expect(denied.json().type).toBe("urn:gr:err:entitlement_limit");

		await override(a, "albums.expiringShares", false);
		expect(await status()).toEqual({ total: 0, available: 0 });
	});

	test("view limit: albums beyond albums.maxViewableAlbums come back locked and empty everywhere", async () => {
		const a = await registerAndLogin(app);
		const b = await registerAndLogin(app);
		const older = await createAlbum(a, "alt");
		await upload(a, older, await jpeg(21));
		const newer = await createAlbum(a, "neu");
		await upload(a, newer, await jpeg(23));
		const share = (id: number) => app.inject({ method: "POST", url: `/v4/albums/${id}/shares`, headers: h(a), payload: { profiles: [{ profileId: Number(b.profileId), expirationType: "INDEFINITE" }] } });
		await share(older);
		await Bun.sleep(5);
		await share(newer);
		await override(b, "albums.maxViewableAlbums", { max: 1 });

		const feed = (await app.inject({ method: "POST", url: "/v3/pressie-albums/feed", headers: h(b), payload: {} })).json();
		// Parses with the app's schema without dropping a single entry.
		const parsed = sharedAlbumViewSchema.parse(feed);
		expect(parsed.sharedAlbums).toHaveLength(feed.sharedAlbums.length);
		expect(parsed.profileFeeds).toHaveLength(feed.profileFeeds.length);
		const byId = new Map((feed.sharedAlbums as Obj[]).map((x) => [x.albumId, x]));
		// The most recently shared album stays viewable.
		expect(byId.get(newer)).toMatchObject({ albumViewable: true, imageCount: 1 });
		expect(byId.get(newer)!.coverContent.location).toContain("/blur?");
		expect(byId.get(older)).toMatchObject({ albumViewable: false, imageCount: 0, videoCount: 0, hasUnseenContent: false, coverContent: { id: 0, location: null } });
		expect(byId.get(older)!.albumNumber).toBeNumber();
		expect(feed.profileFeeds).toHaveLength(1);
		expect(feed.profileFeeds[0]).toMatchObject({ profileId: Number(a.profileId), paywallStatus: "ALLOW" });

		const locked = (await app.inject({ method: "GET", url: `/v2/albums/${older}`, headers: h(b) })).json();
		expect(locked).toMatchObject({ albumId: older, albumViewable: false, content: [], contentCount: { imageCount: 0, videoCount: 0 } });
		expect((await app.inject({ method: "GET", url: `/v3/albums/${older}/view`, headers: h(b) })).statusCode).toBe(403);
		const sharesByProfile = (await app.inject({ method: "GET", url: `/v2/albums/shares/${a.profileId}`, headers: h(b) })).json().albums as Obj[];
		expect(sharesByProfile.find((x) => x.albumId === older)).toMatchObject({ albumViewable: false, content: null });
		const msgs = (await app.inject({ method: "GET", url: `/v5/chat/conversation/${cid(a, b)}/message`, headers: h(b) })).json().messages as Obj[];
		expect(msgs.find((m) => m.body.albumId === older)!.body).toMatchObject({ isViewable: false, coverUrl: null });
		expect(msgs.find((m) => m.body.albumId === newer)!.body.isViewable).toBe(true);

		// Limit 0: everything locked → PAYWALL.
		await override(b, "albums.maxViewableAlbums", { max: 0 });
		const none = (await app.inject({ method: "POST", url: "/v3/pressie-albums/feed", headers: h(b), payload: {} })).json();
		expect((none.sharedAlbums as Obj[]).every((x) => !x.albumViewable)).toBe(true);
		expect(sharedAlbumViewSchema.parse(none).sharedAlbums).toHaveLength(none.sharedAlbums.length);
		expect(none.profileFeeds[0]).toMatchObject({ paywallStatus: "PAYWALL", content: { coverUrl: null } });
	});
});
