import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import sharp from "sharp";
import WebSocket from "ws";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app";
import { invalidate } from "../../src/cache/local";
import { db } from "../../src/db/client";
import { entitlementUserOverrides, profiles, rightNowPosts, rightNowRequests } from "../../src/db/schema";
import { sweepExpiredRightNowPosts } from "../../src/rightnow/routes";
import { eq } from "drizzle-orm";
import { clientHeaders, registerAndLogin } from "../helpers";

type Session = Awaited<ReturnType<typeof registerAndLogin>>;
type Obj = Record<string, any>;

let app: FastifyInstance;
let base = "";
beforeAll(async () => {
	app = await buildApp();
	await app.listen({ port: 0, host: "127.0.0.1" });
	const addr = app.server.address();
	base = typeof addr === "object" && addr ? `127.0.0.1:${addr.port}` : "";
});
afterAll(async () => {
	await Promise.race([app.close(), Bun.sleep(1500)]);
});

const h = (s: Session) => clientHeaders({ deviceId: s.deviceId, token: s.sessionId });
const get = (s: Session, url: string) => app.inject({ method: "GET", url, headers: h(s) });
const send = (s: Session, method: "POST" | "PUT" | "PATCH" | "DELETE", url: string, payload?: unknown) => app.inject({ method, url, headers: h(s), payload: payload as object });
const cid = (a: Session, b: Session) => {
	const [x, y] = [BigInt(a.profileId), BigInt(b.profileId)];
	return x < y ? `${x}:${y}` : `${y}:${x}`;
};

async function at(s: Session, geohash: string) {
	expect((await send(s, "PUT", "/v4/location", { geohash })).statusCode).toBe(200);
}

async function override(s: Session, key: string, value: unknown) {
	await db.insert(entitlementUserOverrides).values({ userId: BigInt(s.profileId), key, value }).onConflictDoUpdate({ target: [entitlementUserOverrides.userId, entitlementUserOverrides.key], set: { value } });
	await invalidate("entitlement-user", s.profileId);
}

/** Collects WS frames of one session. */
async function socket(s: Session) {
	const frames: Obj[] = [];
	const ws = new WebSocket(`ws://${base}/v1/ws`, { headers: h(s) });
	ws.on("message", (d) => frames.push(JSON.parse(String(d))));
	await new Promise<void>((resolve) => ws.on("message", () => resolve()));
	const wait = async (type: string) => {
		for (let i = 0; i < 60; i++) {
			const f = frames.find((x) => x.type === type);
			if (f) return f;
			await Bun.sleep(50);
		}
		throw new Error(`no ${type}`);
	};
	return { ws, frames, wait };
}

const BERLIN = "u33dc1v0twx0";
const BERLIN_NEAR = "u33dc1v8";

describe("blocks, taps, views, reports", () => {
	test("profile shows my tap and theirs", async () => {
		const a = await registerAndLogin(app);
		const b = await registerAndLogin(app);
		expect((await get(a, `/v7/profiles/${b.profileId}`)).json().profiles[0]).toMatchObject({ tapped: false, tapType: null, lastReceivedTapTimestamp: null });
		await send(a, "POST", "/v2/taps/add", { recipientId: Number(b.profileId), tapType: 2 });
		expect((await get(a, `/v7/profiles/${b.profileId}`)).json().profiles[0]).toMatchObject({ tapped: true, tapType: 2 });
		expect((await get(b, `/v7/profiles/${a.profileId}`)).json().profiles[0].lastReceivedTapTimestamp).toBeNumber();
	});

	test("tap: mutual, repeat refused, live events, lists", async () => {
		const a = await registerAndLogin(app);
		const b = await registerAndLogin(app);
		const wb = await socket(b);
		const first = await send(a, "POST", "/v2/taps/add", { recipientId: Number(b.profileId), tapType: 1 });
		expect(first.json()).toEqual({ isMutual: false });
		expect((await send(a, "POST", "/v2/taps/add", { recipientId: Number(b.profileId), tapType: 1 })).statusCode).toBe(400);
		const ev = await wb.wait("tap.v1.tap_sent");
		expect(ev.payload).toMatchObject({ senderId: Number(a.profileId), recipientId: Number(b.profileId), tapType: 1, isMutual: false });
		await wb.wait("tap.v2.tap_sent");
		expect((await send(b, "POST", "/v2/taps/add", { recipientId: Number(a.profileId), tapType: 0 })).json()).toEqual({ isMutual: true });

		const received = (await get(b, "/v2/taps/received")).json().profiles as Obj[];
		expect(received).toHaveLength(1);
		expect(received[0]).toMatchObject({ profileId: Number(a.profileId), tapType: 1, isMutual: true });
		const v3 = (await get(b, "/v3/taps/received?withTappedSent=true")).json().items as Obj[];
		expect(v3[0]).toMatchObject({ type: "tap_profile_v1", data: { tapped: true } });
		const sent = (await get(a, "/v1/interactions/taps/sent")).json() as Obj[];
		expect(sent[0]).toMatchObject({ senderId: Number(a.profileId), receiverId: Number(b.profileId), tapType: 1, deleted: false });
		wb.ws.close();
	});

	test("views: recorded, eyeball + list, event; hideViewedMe", async () => {
		const a = await registerAndLogin(app);
		const b = await registerAndLogin(app);
		const wb = await socket(b);
		expect((await send(a, "POST", `/v4/views/${b.profileId}`)).statusCode).toBe(200);
		const ev = await wb.wait("viewed_me.v1.new_view_received");
		expect(ev.payload).toMatchObject({ viewedCount: 1, mostRecent: { profileId: a.profileId } });
		expect((await get(b, "/v6/views/eyeball")).json()).toMatchObject({ viewedCount: 1, mostRecent: { profileId: a.profileId } });
		const list = (await get(b, "/v7/views/list")).json();
		expect(list.totalViewers).toBe(1);
		expect(list.profiles[0]).toMatchObject({ profileId: a.profileId, viewedCount: { totalCount: 1 } });

		await override(b, "viewedMe.visibleCount", { max: 0 });
		const masked = (await get(b, "/v7/views/list")).json();
		expect(masked.profiles).toHaveLength(0);
		expect(masked.previews).toHaveLength(1);
		expect(masked.previews[0].profileId).toBeUndefined();
		wb.ws.close();
	});

	test("block: lists both ways, conversation.delete to both, unblock all", async () => {
		const a = await registerAndLogin(app);
		const b = await registerAndLogin(app);
		const wa = await socket(a);
		const wb = await socket(b);
		await send(a, "POST", "/v4/chat/message/send", { type: "Text", target: { type: "Direct", targetId: Number(b.profileId) }, body: { text: "hi" } });
		expect((await send(a, "POST", `/v3/me/blocks/${b.profileId}`)).json()).toEqual({ updateTime: 0 });
		for (const w of [wa, wb]) expect((await w.wait("chat.v1.conversation.delete")).payload).toEqual({ conversationIds: [cid(a, b)] });
		expect((await get(a, "/v3.1/me/blocks")).json().blocking).toEqual([{ profileId: Number(b.profileId), blockedTime: 0 }]);
		expect((await get(b, "/v3.1/me/blocks")).json().blockedBy).toEqual([a.profileId]);
		expect((await send(b, "POST", "/v2/taps/add", { recipientId: Number(a.profileId), tapType: 1 })).statusCode).toBe(400);
		expect((await get(b, `/v5/chat/conversation/${cid(a, b)}/message`)).statusCode).toBe(403);
		expect((await send(a, "DELETE", "/v3/me/blocks")).statusCode).toBe(200);
		expect((await get(a, "/v3.1/me/blocks")).json().blocking).toEqual([]);
		// The conversation is gone on the server for both sides.
		const after = await get(b, `/v5/chat/conversation/${cid(a, b)}/message`);
		expect(after.statusCode).toBe(200);
		expect(after.json().messages).toEqual([]);
		for (const s of [a, b]) expect((await send(s, "POST", "/v4/inbox?page=1", {})).json().entries).toEqual([]);
		wa.ws.close();
		wb.ws.close();
	});

	test("report: stored once, readable, 404 when none", async () => {
		const a = await registerAndLogin(app);
		const b = await registerAndLogin(app);
		expect((await get(a, `/v3.1/flags/${b.profileId}`)).statusCode).toBe(404);
		expect((await send(a, "POST", `/v3.1/flags/${b.profileId}`, { reason: "SPAM", comment: "", locations: ["CHAT_MESSAGE"] })).statusCode).toBe(200);
		expect((await get(a, `/v3.1/flags/${b.profileId}`)).json()).toMatchObject({ status: "PENDING" });
	});
});

async function rightNowPhoto(s: Session): Promise<number> {
	const raw = Buffer.from(Array.from({ length: 120 * 90 * 3 }, (_, i) => (i * 31) % 256));
	const img = await sharp(raw, { raw: { width: 120, height: 90, channels: 3 } }).jpeg({ quality: 95 }).toBuffer();
	const res = await app.inject({
		method: "POST",
		url: "/v2/media/upload?crop_top=0&crop_bottom=90&crop_left=0&crop_right=120&img_1_top=0&img_1_bottom=90&img_1_left=15&img_1_right=105&rotate=0&flip_vertical=false",
		headers: { ...h(s), "content-type": "image/jpeg" },
		payload: img,
	});
	expect(res.statusCode).toBe(200);
	expect(res.json().url).toContain("/0/");
	return res.json().mediaId;
}

describe("right now", () => {
	test("create without lat/lon uses the last set location; none known → 400 client_action", async () => {
		const s = await registerAndLogin(app);
		await db.update(profiles).set({ location: null, publicLocation: null }).where(eq(profiles.userId, BigInt(s.profileId)));
		const none = await send(s, "POST", "/v3/rightnow/posts", { hosting: false, media: [] });
		expect(none.statusCode).toBe(400);
		expect(none.json().type).toBe("urn:gr:err:client_action");
		// lat/lon in the body set it.
		expect((await send(s, "POST", "/v3/rightnow/posts", { hosting: false, media: [], lat: 52.52, lon: 13.4 })).statusCode).toBe(200);
	});

	test("post lifecycle: create, one at a time, hide/show, edit, entitlements, expiry", async () => {
		const a = await registerAndLogin(app);
		await at(a, BERLIN);
		const mediaId = await rightNowPhoto(a);
		const created = await send(a, "POST", "/v3/rightnow/posts", { text: "Kaffee?", shareLocation: "DISTANCE_AND_MAP", locationRadius: 20, hosting: true, media: [{ type: "image_v1", data: { id: mediaId } }] });
		expect(created.statusCode).toBe(200);
		const post = created.json().post;
		expect(post).toMatchObject({ profileId: Number(a.profileId), activeText: "Kaffee?", postStatus: "ACTIVE", hosting: true, shareLocation: "DISTANCE_AND_MAP", locationRadius: 20, isDiscreet: "NOT_SELECTED" });
		expect(post.expiration - post.posted).toBe(3_600_000);
		expect(post.media[0].fullImageUrl).toContain("/0/");
		expect((await send(a, "POST", "/v3/rightnow/posts", { hosting: false, media: [] })).statusCode).toBe(400);

		expect((await get(a, "/v3/rightnow/active-post")).json().post.id).toBe(post.id);
		const other = await registerAndLogin(app);
		expect((await get(other, `/v3/rightnow/profiles/${a.profileId}`)).json().post).toMatchObject({ id: post.id, locationRadius: null });
		const profile = (await get(other, `/v7/profiles/${a.profileId}`)).json().profiles[0];
		expect(profile).toMatchObject({ rightNow: "HOSTING", rightNowStatus: "ACTIVE", rightNowText: "Kaffee?", rightNowPosted: post.posted });
		expect(profile.rightNowThumbnailUrl).toBeString();

		expect((await send(a, "PATCH", `/v1/rightnow/posts/${post.id}/settings`, {})).statusCode).toBe(400);
		expect((await send(a, "PATCH", `/v1/rightnow/posts/${post.id}/settings`, { hidden: true })).json().post.postStatus).toBe("HIDDEN");
		expect((await get(other, `/v3/rightnow/profiles/${a.profileId}`)).json().post).toBeNull();
		expect((await get(other, `/v7/profiles/${a.profileId}`)).json().profiles[0]).toMatchObject({ rightNow: "NOT_ACTIVE", rightNowStatus: "NONE", rightNowText: null });
		expect((await send(a, "PATCH", `/v1/rightnow/posts/${post.id}/settings`, { hidden: false })).json().post.postStatus).toBe("ACTIVE");
		expect((await send(a, "PATCH", `/v4/rightnow/posts/${post.id}`, { hosting: "yes" })).json().type).toBe("urn:gr:err:internal_error");
		const v4 = (await send(a, "PATCH", `/v4/rightnow/posts/${post.id}`, { text: "Neu", isDiscreet: true })).json().post;
		expect(v4).toMatchObject({ activeText: "Neu", isDiscreet: "FALSE" });
		expect((await send(a, "PATCH", "/v4/rightnow/posts/999999999", { text: "x" })).json().type).toBe("urn:gr:err:resource_not_found");

		expect((await get(a, "/v1/rightnow/entitlements/posts")).json()).toEqual({ type: "UNLIMITED" });
		await override(a, "rightnow.posts", { windows: [{ count: 1, window: "week" }] });
		expect((await get(a, "/v1/rightnow/entitlements/posts")).json()).toEqual({ type: "GRANTED", count: 1 });

		// Expiry: gone from active-post; showing again refused; next post possible.
		await db.update(rightNowPosts).set({ expiration: new Date(Date.now() - 1000) }).where(eq(rightNowPosts.id, post.id));
		expect((await get(a, "/v3/rightnow/active-post")).json().post).toBeNull();
		expect((await send(a, "PATCH", `/v1/rightnow/posts/${post.id}/settings`, { hidden: false })).statusCode).toBe(400);
		await sweepExpiredRightNowPosts();
		const second = (await send(a, "POST", "/v3/rightnow/posts", { hosting: false, media: [] })).json().post;
		expect(second.postStatus).toBe("ACTIVE");
		// Out of posts → stored, but parked like upstream.
		await db.update(rightNowPosts).set({ expiration: new Date(Date.now() - 1000) }).where(eq(rightNowPosts.id, second.id));
		expect((await get(a, "/v1/rightnow/entitlements/posts")).json()).toEqual({ type: "GRANTED", count: 0 });
		const parked = (await send(a, "POST", "/v3/rightnow/posts", { hosting: false, media: [] })).json().post;
		expect(parked).toMatchObject({ postStatus: "AWAITING_PAYMENT", posted: null, expiration: null });
	});

	test("feed: standard and discreet posts, no identity leak, filters, locked", async () => {
		const author = await registerAndLogin(app);
		const shy = await registerAndLogin(app);
		const viewer = await registerAndLogin(app);
		for (const s of [author, shy]) await at(s, BERLIN);
		await at(viewer, BERLIN_NEAR);
		const photo = await rightNowPhoto(shy);
		const hidden = (await send(shy, "POST", "/v4/rightnow/posts", { text: "diskret", shareLocation: "DISTANCE_ONLY", hosting: false, media: [{ type: "image_v1", data: { id: photo } }] })).json().post;
		expect(hidden.postStatus).toBe("HIDDEN");
		expect((await send(shy, "PATCH", `/v5/rightnow/posts/${hidden.id}`, { isDiscreet: true, sharedFields: ["AGE"] })).json().post).toMatchObject({ isDiscreet: "TRUE", sharedFields: ["AGE"] });
		expect((await send(shy, "PATCH", `/v5/rightnow/posts/${hidden.id}`, { isDiscreet: false })).json().type).toBe("urn:gr:err:client_action");
		expect((await send(shy, "PATCH", `/v5/rightnow/posts/${hidden.id}`, { sharedFields: ["SHOE_SIZE"] })).statusCode).toBe(400);
		expect((await send(shy, "PATCH", `/v5/rightnow/posts/${hidden.id}`, { sharedFields: ["SHOE_SIZE"] })).json().type).toBe("urn:gr:err:client_action");
		// Not allowed to post discreetly: 402 tiered_feature, not a "session ended" client_action.
		await override(author, "rightnow.discreet", false);
		const own = (await send(author, "POST", "/v4/rightnow/posts", { text: "offen", shareLocation: "DISTANCE_AND_MAP", hosting: true, media: [] })).json().post;
		const denied = await send(author, "PATCH", `/v5/rightnow/posts/${own.id}`, { isDiscreet: true });
		expect(denied.statusCode).toBe(402);
		expect(denied.json().type).toBe("urn:gr:err:tiered_feature");
		await send(author, "PATCH", `/v1/rightnow/posts/${own.id}/settings`, { hidden: false });
		await send(shy, "PATCH", `/v1/rightnow/posts/${hidden.id}/settings`, { hidden: false });

		const feed = (await get(viewer, "/v5/rightnow/feed")).json();
		const mine = feed.items.filter((i: Obj) => i.data.id === hidden.id || i.data.profileId === Number(author.profileId));
		expect(mine).toHaveLength(2);
		const open = mine.find((i: Obj) => i.type === "right_now_post_v3")!;
		expect(open.data).toMatchObject({ profileId: Number(author.profileId), text: "offen", hosting: true });
		expect(open.data.lat).toBeNumber();
		expect(open.data.distance).toBeNumber();
		const discreet = mine.find((i: Obj) => i.type === "discreet_right_now_post_v1")!;
		const raw = JSON.stringify(discreet);
		expect(raw).not.toContain(shy.profileId);
		expect(discreet.data.profileId).toBeUndefined();
		expect(discreet.data.lat).toBeUndefined();
		expect(discreet.data.profileFields).toMatchObject({ height: null, weight: null, position: null });
		expect(discreet.data.media[0].data.fullImageUrl).toContain("/0/");
		expect((await get(viewer, `/v3/rightnow/profiles/${shy.profileId}`)).json().post).toBeNull();

		const hostingOnly = (await get(viewer, "/v4/rightnow/feed?hosting=true")).json().items as Obj[];
		expect(hostingOnly.some((i) => i.data.id === hidden.id)).toBe(false);
		expect((await get(viewer, "/v6/rightnow/feed?sexualPositions=abc")).statusCode).toBe(500);

		await override(viewer, "rightnow.feedUnlocked", false);
		const locked = (await get(viewer, "/v5/rightnow/feed")).json().items as Obj[];
		expect(locked.find((i) => i.data.id === hidden.id)!.type).toBe("discreet_locked_post_v1");
		expect(locked.find((i) => i.data.profileId === Number(author.profileId))!.type).toBe("locked_post_v1");
	});

	test("requests: live event to the author, inbox/outbox, reject silently, accept → chat message", async () => {
		const author = await registerAndLogin(app);
		const sender = await registerAndLogin(app);
		await at(author, BERLIN);
		await at(sender, BERLIN_NEAR);
		const photoId = await rightNowPhoto(author);
		const post = (await send(author, "POST", "/v4/rightnow/posts", { hosting: false, media: [{ type: "image_v1", data: { id: photoId } }] })).json().post;
		await send(author, "PATCH", `/v5/rightnow/posts/${post.id}`, { isDiscreet: true, sharedFields: [] });
		await send(author, "PATCH", `/v1/rightnow/posts/${post.id}/settings`, { hidden: false });
		const wa = await socket(author);

		expect((await send(author, "POST", "/v1/rightnow/requests", { postId: post.id })).statusCode).toBe(404); // own post
		expect((await send(sender, "POST", "/v1/rightnow/requests", { postId: post.id })).statusCode).toBe(200);
		expect((await send(sender, "POST", "/v1/rightnow/requests", { postId: post.id })).statusCode).toBe(409);
		const ev = await wa.wait("rightnow.v1.request");
		expect(ev.ref).toBeNull();
		expect(ev.payload).toMatchObject({ title: "RIGHT_NOW_REQUEST_NOTIFICATION_TITLE", body: "RIGHT_NOW_REQUEST_NOTIFICATION_BODY", translateTitle: true, translateBody: true, action: "grindr://right-now-inbox" });

		const inbox = (await get(author, "/v1/rightnow/requests/inbox")).json().requests as Obj[];
		expect(inbox).toHaveLength(1);
		expect(inbox[0]).toMatchObject({ profileId: Number(sender.profileId), status: "PENDING", postId: post.id });
		expect((await get(sender, "/v1/rightnow/requests/outbox")).json().requests[0]).toMatchObject({ recipientProfileId: null, status: "PENDING" });

		// A hidden post hides its requests.
		await send(author, "PATCH", `/v1/rightnow/posts/${post.id}/settings`, { hidden: true });
		expect((await get(author, "/v1/rightnow/requests/inbox")).json().requests).toHaveLength(0);
		await send(author, "PATCH", `/v1/rightnow/posts/${post.id}/settings`, { hidden: false });

		expect((await send(sender, "PUT", `/v1/rightnow/requests/${inbox[0]!.id}`, { status: "ACCEPTED" })).statusCode).toBe(404);
		expect((await send(author, "PUT", `/v1/rightnow/requests/${inbox[0]!.id}`, { status: "REJECTED" })).statusCode).toBe(200);
		expect((await get(sender, `/v5/chat/conversation/${cid(author, sender)}/message`)).json().messages).toHaveLength(0);
		expect((await send(author, "PUT", `/v1/rightnow/requests/${inbox[0]!.id}`, { status: "ACCEPTED" })).statusCode).toBe(200);
		const msgs = (await get(sender, `/v5/chat/conversation/${cid(author, sender)}/message`)).json().messages as Obj[];
		expect(msgs).toHaveLength(1);
		expect(msgs[0]).toMatchObject({ type: "RightNowRequest", senderId: Number(author.profileId), body: { requestId: inbox[0]!.id, postId: post.id, postStatus: "ACTIVE" } });
		const body = msgs[0]!.body as { requestCreatedAt: number; requestUpdatedAt: number; medias: { mediaHash: string; isNsfw: boolean }[] };
		expect(typeof body.requestCreatedAt).toBe("number");
		expect(body.requestUpdatedAt).toBeGreaterThanOrEqual(body.requestCreatedAt);
		expect(body.medias).toHaveLength(1);
		expect(body.medias[0]!.isNsfw).toBe(false);
		// The app loads the photo by hash from the public image host, like upstream's CDN.
		const thumb = await app.inject({ method: "GET", url: `/images/thumb/320x320/${body.medias[0]!.mediaHash}` });
		expect(thumb.statusCode).toBe(200);
		expect(thumb.headers["content-type"]).toBe("image/jpeg");
		expect((await get(sender, "/v1/rightnow/requests/outbox")).json().requests[0]).toMatchObject({ recipientProfileId: Number(author.profileId), status: "ACCEPTED" });

		// Expiry: every request of the session goes, accepted ones too; the chat stays.
		await db.update(rightNowPosts).set({ expiration: new Date(Date.now() - 1000) }).where(eq(rightNowPosts.id, post.id));
		// Hidden right away, before the worker sweeps.
		expect((await get(sender, "/v1/rightnow/requests/outbox")).json().requests).toHaveLength(0);
		expect((await get(author, "/v1/rightnow/requests/inbox")).json().requests).toHaveLength(0);
		await sweepExpiredRightNowPosts();
		expect(await db.select().from(rightNowRequests).where(eq(rightNowRequests.postId, post.id))).toHaveLength(0);
		const after = (await get(sender, `/v5/chat/conversation/${cid(author, sender)}/message`)).json().messages as Obj[];
		expect(after).toHaveLength(1);
		// The chat message reports the post's status as it is now.
		expect((after[0]!.body as { postStatus: string }).postStatus).toBe("EXPIRED");
		wa.ws.close();
	});

	test("heatmap: only cells with enough active profiles", async () => {
		const users = await Promise.all([0, 1, 2].map(() => registerAndLogin(app)));
		for (const u of users) await at(u, "u0yjjd6jk0yp");
		const res = await send(users[0]!, "POST", "/v1/explore_heatmaps", { coordinates: { lat: 50.11, lng: 8.68 }, searchSquareSide: 0.25, includeHeatmaps: true });
		expect(res.statusCode).toBe(200);
		const body = res.json();
		expect(body.locations).toEqual([]);
		expect(body.heatmaps.length).toBeGreaterThanOrEqual(1);
		expect(body.heatmaps[0].intensity).toBeGreaterThanOrEqual(1);
		expect((await get(users[0]!, "/v1/explore_heatmaps/all_locations")).json()).toEqual({ locations: [] });
	});
});
