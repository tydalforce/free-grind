import { randomInt } from "node:crypto";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import sharp from "sharp";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { RIGHT_NOW_UPLOADER } from "../chat/media";
import { sendSystemMessage } from "../chat/service";
import { db } from "../db/client";
import { media, rightNowPosts, rightNowRequests } from "../db/schema";
import { capValue, consume, durationSeconds, isFeatureEnabled, peek } from "../entitlements/enforce";
import { touchOnline, updateLocation } from "../geo/location";
import { type LatLon, destination, displayedDistance, haversineMeters } from "../geo/obfuscate";
import { errors, problem } from "../lib/errors";
import { signMediaUrl } from "../lib/mediaUrls";
import { enforceRateLimit } from "../lib/rateLimit";
import { readBodyLimited } from "../media/body";
import { publicImageUrl } from "../media/routes";
import { storeUpload } from "../media/service";
import { getServerSetting } from "../modules/settings/settings";
import { type ProfileCard, getProfileCards } from "../profiles/cards";
import type { ProfileRightNow } from "../profiles/serialize";
import { getRelations, isBlockedEitherWay } from "../profiles/relations";
import { publishToUser } from "../realtime/bus";
import { notifyRightNowRequest } from "../push/notify";

/**
 * Right Now (docs/content/generated/grindr-api/right-now.md): time-limited
 * posts, the feed (incl. discreet posts without author identity) and chat
 * requests. Positions are the author's public (obfuscated) location plus a
 * per-post displacement; real locations never leave the server.
 */

type PostRow = typeof rightNowPosts.$inferSelect;
type ShareLocation = PostRow["shareLocation"];
const SHARED_FIELDS = ["AGE", "HEIGHT", "WEIGHT", "POSITION"] as const;
const SHARE_LOCATIONS = ["DISTANCE_AND_MAP", "DISTANCE_ONLY", "NONE"] as const;
/** Posts are listed within this distance of where they were posted. */
const FEED_RADIUS_M = 80_000;
const FEED_LIMIT = 200;
const UPLOAD_MAX_BYTES = 25 * 1024 * 1024;

const clientAction = (detail = "Action not allowed at this time") => problem(400, "client_action", detail);
const notFound400 = () => problem(400, "resource_not_found");
const internal400 = () => problem(400, "internal_error");

/** locationRadius (0–100, a precision value, not meters) → displacement radius in meters. */
function displacementMeters(locationRadius: number | null): number {
	const r = Math.max(0, Math.min(100, locationRadius ?? 0));
	return 50 + r * 30;
}

function rollOffset(locationRadius: number | null): { offsetEast: number; offsetNorth: number } {
	const radius = displacementMeters(locationRadius);
	// Uniform over the disc.
	const d = radius * Math.sqrt(randomInt(0, 1_000_000) / 1_000_000);
	const a = (randomInt(0, 1_000_000) / 1_000_000) * 2 * Math.PI;
	return { offsetEast: d * Math.sin(a), offsetNorth: d * Math.cos(a) };
}

function postPosition(author: LatLon, post: Pick<PostRow, "offsetEast" | "offsetNorth">): LatLon {
	const meters = Math.hypot(post.offsetEast, post.offsetNorth);
	return meters ? destination(author, meters, Math.atan2(post.offsetEast, post.offsetNorth)) : author;
}

/** Status as seen now: an ACTIVE/HIDDEN post past its expiration is EXPIRED. */
function liveStatus(p: Pick<PostRow, "status" | "expiration">, now = Date.now()): PostRow["status"] {
	if ((p.status === "ACTIVE" || p.status === "HIDDEN") && p.expiration && p.expiration.getTime() <= now) return "EXPIRED";
	return p.status;
}

async function publicLocations(ids: bigint[]): Promise<Map<string, { pos: LatLon | null; onlineUntil: number | null }>> {
	if (!ids.length) return new Map();
	const rows = (await db.execute(sql`
		SELECT user_id::text AS id, ST_Y(public_location::geometry) AS lat, ST_X(public_location::geometry) AS lon,
		       (extract(epoch FROM online_until) * 1000)::bigint AS ou
		FROM profiles WHERE user_id = ANY(${`{${[...new Set(ids.map(String))].join(",")}}`}::bigint[])`)) as unknown as { id: string; lat: number | null; lon: number | null; ou: string | null }[];
	return new Map(rows.map((r) => [r.id, { pos: r.lat == null || r.lon == null ? null : { lat: Number(r.lat), lon: Number(r.lon) }, onlineUntil: r.ou == null ? null : Number(r.ou) }]));
}

async function chatTtl(): Promise<number> {
	return (await getServerSetting<number>("media.url.chatTtlSec")) ?? 900;
}

async function mediaItems(mediaIds: number[]) {
	if (!mediaIds.length) return [];
	const rows = await db.select({ mediaId: media.mediaId, hash: media.hash }).from(media).where(and(inArray(media.mediaId, mediaIds), eq(media.purpose, "rightnow")));
	const byId = new Map(rows.map((r) => [r.mediaId, r]));
	const ttl = await chatTtl();
	const out = [];
	for (const id of mediaIds) {
		const m = byId.get(id);
		if (!m) continue;
		const [full, thumb] = await Promise.all([
			signMediaUrl({ uploaderProfileId: RIGHT_NOW_UPLOADER, mediaHash: m.hash, ttlSeconds: ttl }),
			signMediaUrl({ uploaderProfileId: RIGHT_NOW_UPLOADER, mediaHash: m.hash, variant: "thumb", ttlSeconds: ttl }),
		]);
		out.push({ mediaId: id, hash: m.hash, thumbnailUrl: thumb.url, fullImageUrl: full.url, contentType: "image/jpeg", state: "APPROVED", reason: null, isRejectAutomated: null, shouldBlur: false, isNsfw: false, source: "RIGHT_NOW" });
	}
	return out;
}

/** RightNowPostDetails. `own`: the author's view (radius, map position always). */
async function postDetails(p: PostRow, opts: { own: boolean }) {
	const status = liveStatus(p);
	const media = (await mediaItems(p.mediaIds)).map(({ hash: _h, ...m }) => m);
	let lat: number | null = null;
	let lon: number | null = null;
	if (status !== "AWAITING_PAYMENT" && (opts.own || p.shareLocation === "DISTANCE_AND_MAP")) {
		const author = (await publicLocations([p.authorId])).get(String(p.authorId))?.pos;
		if (author) ({ lat, lon } = postPosition(author, p));
	}
	return {
		id: p.id,
		profileId: Number(p.authorId),
		posted: p.posted?.getTime() ?? null,
		expiration: p.expiration?.getTime() ?? null,
		hosting: p.hosting,
		activeText: p.text,
		moderatedText: null,
		media,
		lat,
		lon,
		postStatus: status,
		shareLocation: p.shareLocation,
		locationRadius: opts.own ? p.locationRadius : null,
		isDiscreet: p.isDiscreet,
		sharedFields: p.sharedFields,
		boostUpsellOfferAvailableUntil: null,
	};
}

async function ownPost(me: bigint, postId: number): Promise<PostRow | null> {
	if (!Number.isSafeInteger(postId)) return null;
	const [row] = await db.select().from(rightNowPosts).where(and(eq(rightNowPosts.id, postId), eq(rightNowPosts.authorId, me))).limit(1);
	return row ?? null;
}

/** The author's running (ACTIVE or HIDDEN, not expired) post. */
async function runningPost(authorId: bigint): Promise<PostRow | null> {
	const [row] = await db
		.select()
		.from(rightNowPosts)
		.where(and(eq(rightNowPosts.authorId, authorId), inArray(rightNowPosts.status, ["ACTIVE", "HIDDEN"]), sql`${rightNowPosts.expiration} > now()`))
		.orderBy(desc(rightNowPosts.createdAt))
		.limit(1);
	return row ?? null;
}

const mediaSchema = z.array(z.object({ type: z.string(), data: z.object({ id: z.number().int() }) })).max(10);

async function ownMediaIds(me: bigint, items: z.infer<typeof mediaSchema>): Promise<number[]> {
	const ids = items.filter((m) => m.type === "image_v1").map((m) => m.data.id);
	if (!ids.length) return [];
	const rows = await db.select({ id: media.mediaId }).from(media).where(and(inArray(media.mediaId, ids), eq(media.ownerId, me), eq(media.purpose, "rightnow"), sql`${media.deletedAt} IS NULL`));
	const ok = new Set(rows.map((r) => r.id));
	if (ids.some((id) => !ok.has(id))) throw errors.badRequest("Invalid request");
	return ids;
}

const createSchema = z.object({
	text: z.string().max(500).nullable().optional(),
	shareLocation: z.enum(SHARE_LOCATIONS).optional(),
	lat: z.number().nullable().optional(),
	lon: z.number().nullable().optional(),
	locationRadius: z.number().int().min(0).max(100).nullable().optional(),
	media: mediaSchema.optional(),
	hosting: z.boolean().optional(),
});

async function createPost(req: FastifyRequest, startHidden: boolean) {
	const me = req.auth.userId;
	const b = createSchema.safeParse(req.body ?? {});
	if (!b.success) throw errors.badRequest("Invalid request");
	const running = await runningPost(me);
	if (running) {
		const [n] = await db
			.select({ n: sql<number>`count(*)::int` })
			.from(rightNowPosts)
			.where(and(eq(rightNowPosts.authorId, me), inArray(rightNowPosts.status, ["ACTIVE", "HIDDEN"]), sql`${rightNowPosts.expiration} > now()`));
		const max = await capValue(me, "rightnow.maxActivePosts");
		if ((n?.n ?? 0) >= max) throw clientAction();
	}
	// Upstream: lat/lon in the body set the location; without them the last one
	// set via Update location (grid/cascade) is used; with none known → 400 client_action.
	const { lat, lon } = b.data;
	if (lat != null && lon != null && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) await updateLocation(me, { lat, lon });
	const author = (await publicLocations([me])).get(String(me))?.pos;
	if (!author) throw clientAction();
	const mediaIds = await ownMediaIds(me, b.data.media ?? []);

	// Out of posts: upstream still stores it, parked as AWAITING_PAYMENT where nobody sees it.
	let paid = true;
	try {
		await consume(me, "rightnow.posts");
	} catch {
		paid = false;
	}
	const now = new Date();
	const duration = await durationSeconds(me, "rightnow.postDuration");
	const expiration = Number.isFinite(duration) ? new Date(now.getTime() + duration * 1000) : new Date(now.getTime() + 365 * 86_400_000);
	const locationRadius = b.data.locationRadius ?? null;
	const [row] = await db
		.insert(rightNowPosts)
		.values({
			authorId: me,
			status: paid ? (startHidden ? "HIDDEN" : "ACTIVE") : "AWAITING_PAYMENT",
			text: b.data.text?.trim() || null,
			hosting: b.data.hosting ?? false,
			shareLocation: b.data.shareLocation ?? "NONE",
			locationRadius,
			...rollOffset(locationRadius),
			anchor: author,
			mediaIds,
			posted: paid ? now : null,
			expiration: paid ? expiration : null,
		})
		.returning();
	return { post: await postDetails(row!, { own: true }) };
}

const patchSchema = z.object({
	hosting: z.unknown().optional(),
	text: z.string().max(500).nullable().optional(),
	media: mediaSchema.nullable().optional(),
	hidden: z.boolean().optional(),
	shareLocation: z.string().optional(),
	locationRadius: z.number().int().min(0).max(100).nullable().optional(),
	isDiscreet: z.boolean().optional(),
	sharedFields: z.array(z.unknown()).max(20).optional(),
});

function setHidden(post: PostRow, hidden: boolean): Partial<PostRow> {
	const status = liveStatus(post);
	if (!hidden && status === "EXPIRED") throw clientAction();
	if (status === "AWAITING_PAYMENT" || status === "EXPIRED") return {};
	return { status: hidden ? "HIDDEN" : "ACTIVE" };
}

async function patchPost(req: FastifyRequest, version: "v4" | "v5") {
	const me = req.auth.userId;
	const b = patchSchema.safeParse(req.body ?? {});
	if (!b.success) throw errors.badRequest("Invalid request");
	// Upstream checks the hosting type before the post id.
	if (b.data.hosting !== undefined && typeof b.data.hosting !== "boolean") throw internal400();
	if (b.data.shareLocation !== undefined && !(SHARE_LOCATIONS as readonly string[]).includes(b.data.shareLocation)) throw internal400();
	const post = await ownPost(me, Number((req.params as { id: string }).id));
	if (!post) throw notFound400();

	const set: Partial<PostRow> = { updatedAt: new Date() };
	if (typeof b.data.hosting === "boolean") set.hosting = b.data.hosting;
	if (b.data.text !== undefined) set.text = b.data.text?.trim() || null;
	if (b.data.media) set.mediaIds = await ownMediaIds(me, b.data.media);
	if (b.data.shareLocation) set.shareLocation = b.data.shareLocation as ShareLocation;
	if (b.data.locationRadius !== undefined && b.data.locationRadius !== post.locationRadius) {
		set.locationRadius = b.data.locationRadius;
		Object.assign(set, rollOffset(b.data.locationRadius));
	}
	if (b.data.hidden !== undefined) Object.assign(set, setHidden(post, b.data.hidden));
	if (version === "v4") {
		if (post.isDiscreet === "NOT_SELECTED") set.isDiscreet = "FALSE";
	} else {
		if (b.data.sharedFields && b.data.sharedFields.some((f) => typeof f !== "string" || !(SHARED_FIELDS as readonly string[]).includes(f))) throw clientAction();
		if (b.data.isDiscreet === false && post.isDiscreet === "TRUE") throw clientAction();
		if (b.data.isDiscreet === true) {
			// A tier question, not a state one: 402 like other paid features.
			if (!(await isFeatureEnabled(me, "rightnow.discreet"))) throw errors.tieredFeature("rightnow.discreet");
			set.isDiscreet = "TRUE";
		} else if (b.data.isDiscreet === false) set.isDiscreet = "FALSE";
		if (b.data.sharedFields) set.sharedFields = [...new Set(b.data.sharedFields as string[])];
	}
	const [row] = await db.update(rightNowPosts).set(set).where(eq(rightNowPosts.id, post.id)).returning();
	return { post: await postDetails(row!, { own: true }) };
}

/**
 * Right Now part of profile details. Discreet posts never show up here (that
 * would link them to the profile). `distanceOf` gives the profile's shown
 * distance, used when the post shares one.
 */
export async function profileRightNow(ids: bigint[], distanceOf: (id: string) => number | null): Promise<Map<string, ProfileRightNow>> {
	if (!ids.length) return new Map();
	const rows = await db
		.selectDistinctOn([rightNowPosts.authorId])
		.from(rightNowPosts)
		.where(and(inArray(rightNowPosts.authorId, ids), eq(rightNowPosts.status, "ACTIVE"), sql`${rightNowPosts.isDiscreet} <> 'TRUE'`, sql`${rightNowPosts.expiration} > now()`))
		.orderBy(rightNowPosts.authorId, desc(rightNowPosts.createdAt));
	const out = new Map<string, ProfileRightNow>();
	for (const p of rows) {
		const id = String(p.authorId);
		const [first] = await mediaItems(p.mediaIds.slice(0, 1));
		out.set(id, {
			rightNow: p.hosting ? "HOSTING" : "NOT_HOSTING",
			rightNowStatus: "ACTIVE",
			rightNowText: p.text,
			rightNowPosted: p.posted?.getTime() ?? null,
			rightNowDistance: p.shareLocation === "NONE" ? null : distanceOf(id),
			rightNowThumbnailUrl: first?.thumbnailUrl ?? null,
			rightNowFullImageUrl: first?.fullImageUrl ?? null,
		});
	}
	return out;
}

// --- Feed ------------------------------------------------------------------------

type FeedRow = {
	id: number;
	author_id: string;
	text: string | null;
	hosting: boolean;
	share_location: ShareLocation;
	offset_east: number;
	offset_north: number;
	is_discreet: string;
	shared_fields: string[];
	media_ids: (string | number)[];
	posted: Date | string;
	expiration: Date | string;
};

function profileFields(card: ProfileCard | undefined, shared: string[]) {
	const has = (f: string) => shared.includes(f);
	return {
		age: card && has("AGE") && card.showAge ? card.age : null,
		height: card && has("HEIGHT") ? card.heightCm : null,
		weight: card && has("WEIGHT") ? card.weightGrams : null,
		position: card && has("POSITION") && card.showPosition ? card.sexualPosition : null,
	};
}

async function feed(req: FastifyRequest) {
	const me = req.auth.userId;
	const q = req.query as Record<string, string | undefined>;
	let positions: number[] | null = null;
	if (q.sexualPositions) {
		const parts = q.sexualPositions.split(",");
		if (parts.some((p) => !/^-?\d+$/.test(p.trim()))) throw problem(500, "internal_error");
		positions = parts.map((p) => Number(p));
	}
	const ageMin = q.ageMin && /^\d+$/.test(q.ageMin) ? Number(q.ageMin) : null;
	const ageMax = q.ageMax && /^\d+$/.test(q.ageMax) ? Number(q.ageMax) : null;
	const hosting = q.hosting === "true" ? true : q.hosting === "false" ? false : null;
	const sortByDistance = q.sort === "DISTANCE";

	const viewer = (await publicLocations([me])).get(String(me))?.pos;
	if (!viewer) throw clientAction();
	await touchOnline(me);

	const rows = (await db.execute(sql`
		SELECT r.id, r.author_id::text AS author_id, r.text, r.hosting, r.share_location, r.offset_east, r.offset_north,
		       r.is_discreet, r.shared_fields, r.media_ids, r.posted, r.expiration
		FROM rightnow_posts r JOIN users u ON u.id = r.author_id AND u.deleted_at IS NULL
		WHERE r.status = 'ACTIVE' AND r.expiration > now()
		  AND ST_DWithin(r.anchor, ST_GeogFromText(${`SRID=4326;POINT(${viewer.lon} ${viewer.lat})`}), ${FEED_RADIUS_M})
		ORDER BY r.anchor <-> ST_GeogFromText(${`SRID=4326;POINT(${viewer.lon} ${viewer.lat})`})
		LIMIT ${FEED_LIMIT}`)) as unknown as FeedRow[];

	const rel = await getRelations(String(me));
	const visible = rows.filter((r) => !rel.blocked.has(r.author_id) && !rel.hidden.has(r.author_id));
	const authors = visible.map((r) => BigInt(r.author_id));
	const [cards, locs] = await Promise.all([getProfileCards(authors), publicLocations(authors)]);
	const round = (await getServerSetting<number>("distance.roundMeters")) ?? 100;
	const mapAllowed = req.auth.featureFlags.has("right-now-map");

	const filtered = visible.filter((r) => {
		if (r.author_id === String(me)) return true; // an own post stays despite filters
		const card = cards.get(r.author_id);
		if (!card || card.banned) return false;
		if (hosting != null && r.hosting !== hosting) return false;
		if (ageMin != null && (card.age == null || card.age < ageMin)) return false;
		if (ageMax != null && (card.age == null || card.age > ageMax)) return false;
		if (positions && !positions.includes(card.sexualPosition ?? -1)) return false;
		return true;
	});

	const enriched = filtered.map((r) => {
		const loc = locs.get(r.author_id);
		const pos = loc?.pos ? postPosition(loc.pos, { offsetEast: Number(r.offset_east), offsetNorth: Number(r.offset_north) }) : null;
		const meters = pos ? haversineMeters(viewer, pos) : null;
		return { r, pos, meters, onlineUntil: loc?.onlineUntil ?? null, posted: new Date(r.posted).getTime(), expiration: new Date(r.expiration).getTime() };
	});
	enriched.sort((a, b) => (sortByDistance ? (a.meters ?? Infinity) - (b.meters ?? Infinity) : b.posted - a.posted));

	const unlocked = await isFeatureEnabled(me, "rightnow.feedUnlocked");
	const visibleFull = await capValue(me, "rightnow.feedVisiblePosts");
	const items = [];
	let fullCount = 0;
	for (const e of enriched) {
		const { r } = e;
		const own = r.author_id === String(me);
		const locked = !own && (!unlocked || fullCount >= visibleFull);
		if (!locked && !own) fullCount++;
		const card = cards.get(r.author_id);
		const mediaList = await mediaItems(r.media_ids.map(Number));
		const showDistance = r.share_location !== "NONE" && e.meters != null && (r.is_discreet === "TRUE" || card?.showDistance !== false);
		const distance = showDistance ? displayedDistance(e.meters!, { roundMeters: round, approximate: card?.approximateDistance ?? false }) : undefined;
		const onMap = mapAllowed && r.share_location === "DISTANCE_AND_MAP" && e.pos ? e.pos : null;
		const common = {
			id: Number(r.id),
			media: mediaList.map(({ hash: _h, ...m }) => ({ type: "image_v1", data: m })),
			text: r.text ?? undefined,
			...(distance != null ? { distance } : {}),
			hosting: r.hosting,
			posted: e.posted,
			expiration: e.expiration,
			...(onMap ? { lat: onMap.lat, lon: onMap.lon } : {}),
		};
		if (r.is_discreet === "TRUE") {
			// No profileId, name or photo — only what the author chose to share.
			items.push({
				type: locked ? "discreet_locked_post_v1" : "discreet_right_now_post_v1",
				data: {
					"@type": locked ? "RightNowFeedItemData$DiscreetLockedPostV1" : "RightNowFeedItemData$DiscreetRightNowPostV1",
					...common,
					...(locked ? { type: "unlimited_post_v1" } : { onlineUntil: e.onlineUntil ?? undefined }),
					profileFields: profileFields(card, r.shared_fields ?? []),
				},
			});
			continue;
		}
		items.push({
			type: locked ? "locked_post_v1" : "right_now_post_v3",
			data: {
				"@type": locked ? "RightNowFeedItemData$LockedPostV1" : "RightNowFeedItemData$RightNowPostV3",
				...common,
				profileId: Number(r.author_id),
				mediaHash: card?.primaryMediaHash ?? undefined,
				displayName: card?.displayName ?? undefined,
				mpuScore: 0,
				recentlyChatted: false,
				favorite: rel.favorites.has(r.author_id),
				...(locked ? { type: "unlimited_post_v1" } : { onlineUntil: e.onlineUntil ?? undefined, isOnPrep: false }),
			},
		});
	}

	const [viewers] = (await db.execute(sql`
		SELECT count(*)::int AS n FROM profiles
		WHERE online_until > now() AND ST_DWithin(public_location, ST_GeogFromText(${`SRID=4326;POINT(${viewer.lon} ${viewer.lat})`}), ${FEED_RADIUS_M})`)) as unknown as { n: number }[];
	return { items, viewerCount: viewers?.n ?? 0 };
}

// --- Requests ----------------------------------------------------------------------

async function requestPayloadFor(senderCard: ProfileCard | undefined) {
	return {
		title: "RIGHT_NOW_REQUEST_NOTIFICATION_TITLE",
		body: "RIGHT_NOW_REQUEST_NOTIFICATION_BODY",
		translateTitle: true,
		translateBody: true,
		imageUrl: senderCard?.primaryMediaHash ? publicImageUrl("thumb", "320x320", senderCard.primaryMediaHash) : null,
		action: "grindr://right-now-inbox",
	};
}

export async function rightNowRoutes(app: FastifyInstance): Promise<void> {
	const auth = { preHandler: app.authenticate };

	app.post("/v3/rightnow/posts", auth, (req) => createPost(req, false));
	app.post("/v4/rightnow/posts", auth, (req) => createPost(req, true));
	app.patch("/v4/rightnow/posts/:id", auth, (req) => patchPost(req, "v4"));
	app.patch("/v5/rightnow/posts/:id", auth, (req) => patchPost(req, "v5"));

	app.patch("/v1/rightnow/posts/:id/settings", auth, async (req) => {
		const me = req.auth.userId;
		const b = (req.body ?? {}) as Record<string, unknown>;
		if (!["hosting", "shareLocation", "hidden"].some((k) => k in b)) throw clientAction();
		if ("shareLocation" in b && !(SHARE_LOCATIONS as readonly unknown[]).includes(b.shareLocation)) throw internal400();
		if ("hosting" in b && typeof b.hosting !== "boolean") throw internal400();
		if ("hidden" in b && typeof b.hidden !== "boolean") throw internal400();
		const post = await ownPost(me, Number((req.params as { id: string }).id));
		if (!post) throw notFound400();
		const set: Partial<PostRow> = { updatedAt: new Date() };
		if (typeof b.hosting === "boolean") set.hosting = b.hosting;
		if (typeof b.shareLocation === "string") set.shareLocation = b.shareLocation as ShareLocation;
		if (typeof b.hidden === "boolean") Object.assign(set, setHidden(post, b.hidden));
		const [row] = await db.update(rightNowPosts).set(set).where(eq(rightNowPosts.id, post.id)).returning();
		return { post: await postDetails(row!, { own: true }) };
	});

	app.get("/v3/rightnow/active-post", auth, async (req) => {
		const post = await runningPost(req.auth.userId);
		return { post: post ? await postDetails(post, { own: true }) : null };
	});

	/** Hidden, expired, discreet and blocked posts → {"post":null} (never links a discreet post to a profile). */
	app.get("/v3/rightnow/profiles/:profileId", auth, async (req) => {
		const p = (req.params as { profileId: string }).profileId;
		if (!/^\d{1,19}$/.test(p)) return { post: null };
		const author = BigInt(p);
		if (author !== req.auth.userId && (await isBlockedEitherWay(req.auth.profileId, p))) return { post: null };
		const post = await runningPost(author);
		if (!post || post.status !== "ACTIVE" || post.isDiscreet === "TRUE") return { post: null };
		return { post: await postDetails(post, { own: author === req.auth.userId }) };
	});

	for (const v of ["v4", "v5", "v6"]) app.get(`/${v}/rightnow/feed`, auth, feed);

	app.get("/v1/rightnow/entitlements/posts", auth, async (req) => {
		const r = await peek(req.auth.userId, "rightnow.posts");
		return Number.isFinite(r.remaining) ? { type: "GRANTED", count: Math.max(0, r.remaining) } : { type: "UNLIMITED" };
	});
	app.get("/v1/entitlements", auth, async (req) => {
		const r = await peek(req.auth.userId, "rightnow.posts");
		return { rightNow: Number.isFinite(r.remaining) ? Math.max(0, r.remaining) : 2_147_483_647 };
	});

	// --- Media ------------------------------------------------------------------------

	const upload = async (req: FastifyRequest, v2: boolean) => {
		const me = req.auth.userId;
		await enforceRateLimit(`upload:rightnow:${req.auth.profileId}`, 60, 3_600_000, { ip: req.ip, userId: req.auth.profileId });
		let body = await readBodyLimited(req, UPLOAD_MAX_BYTES);
		const q = req.query as Record<string, string | undefined>;
		const int = (k: string) => (q[k] != null && /^-?\d+$/.test(q[k]!) ? Number(q[k]) : null);
		if (v2 && body.length >= 1024) {
			try {
				let img = sharp(body, { failOn: "error" }).rotate();
				const rotate = int("rotate");
				if (rotate && [90, 180, 270].includes(rotate)) img = img.rotate(rotate);
				if (q.flip_vertical === "true") img = img.flip();
				const [t, b, l, r] = [int("crop_top"), int("crop_bottom"), int("crop_left"), int("crop_right")];
				const buf = await img.jpeg({ quality: 95 }).toBuffer({ resolveWithObject: true });
				img = sharp(buf.data);
				if (t != null && b != null && l != null && r != null && b > t && r > l) {
					const left = Math.max(0, Math.min(l, buf.info.width - 1));
					const top = Math.max(0, Math.min(t, buf.info.height - 1));
					img = img.extract({ left, top, width: Math.max(1, Math.min(r - l, buf.info.width - left)), height: Math.max(1, Math.min(b - t, buf.info.height - top)) });
				}
				body = await img.jpeg({ quality: 95 }).toBuffer();
			} catch {
				throw errors.badRequest("Invalid request");
			}
		}
		const [t, b, l, r] = [int("img_1_top"), int("img_1_bottom"), int("img_1_left"), int("img_1_right")];
		const thumbCoords = t != null && b != null && l != null && r != null && b > t && r > l ? ([b, l, r, t] as [number, number, number, number]) : null;
		const row = await storeUpload(body, { ownerId: me, purpose: "rightnow", accept: ["image"], takenOnGrindr: false, thumbCoords });
		const ttl = await chatTtl();
		const [full, thumb] = await Promise.all([
			signMediaUrl({ uploaderProfileId: RIGHT_NOW_UPLOADER, mediaHash: row.hash, ttlSeconds: ttl }),
			signMediaUrl({ uploaderProfileId: RIGHT_NOW_UPLOADER, mediaHash: row.hash, variant: "thumb", ttlSeconds: ttl }),
		]);
		return { mediaId: row.mediaId, url: full.url, thumbnailUrl: thumb.url };
	};
	app.post("/v1/media/upload", { ...auth, bodyLimit: UPLOAD_MAX_BYTES }, (req) => upload(req, false));
	app.post("/v2/media/upload", { ...auth, bodyLimit: UPLOAD_MAX_BYTES }, (req) => upload(req, true));

	// --- Requests ------------------------------------------------------------------------

	app.post("/v1/rightnow/requests", auth, async (req) => {
		const me = req.auth.userId;
		const b = z.object({ postId: z.coerce.number().int() }).safeParse(req.body);
		if (!b.success) throw errors.badRequest("Invalid request");
		const [post] = await db.select().from(rightNowPosts).where(eq(rightNowPosts.id, b.data.postId)).limit(1);
		if (!post || post.authorId === me || liveStatus(post) !== "ACTIVE" || (await isBlockedEitherWay(String(me), String(post.authorId)))) throw errors.notFound();
		const [existing] = await db.select({ id: rightNowRequests.id }).from(rightNowRequests).where(and(eq(rightNowRequests.postId, post.id), eq(rightNowRequests.senderId, me))).limit(1);
		if (existing) throw problem(409, "internal_error");
		await consume(me, "rightnow.requestsPerDay");
		const inserted = await db.insert(rightNowRequests).values({ postId: post.id, senderId: me }).onConflictDoNothing().returning({ id: rightNowRequests.id });
		if (!inserted.length) throw problem(409, "internal_error");
		const card = (await getProfileCards([me])).get(String(me));
		// Our extension: a live event so the author's app refreshes its requests inbox.
		const requestPayload = await requestPayloadFor(card);
		await publishToUser(post.authorId, "rightnow.v1.request", requestPayload).catch(() => undefined);
		await notifyRightNowRequest(post.authorId, requestPayload).catch(() => undefined);
		return {};
	});

	app.get("/v1/rightnow/requests/inbox", auth, async (req) => {
		const me = req.auth.userId;
		const rows = await db
			.select({ r: rightNowRequests })
			.from(rightNowRequests)
			.innerJoin(rightNowPosts, eq(rightNowPosts.id, rightNowRequests.postId))
			.where(and(eq(rightNowPosts.authorId, me), eq(rightNowPosts.status, "ACTIVE"), sql`${rightNowPosts.expiration} > now()`))
			.orderBy(desc(rightNowRequests.createdAt))
			.limit(500);
		const rel = await getRelations(String(me));
		const list = rows.map((x) => x.r).filter((r) => !rel.blocked.has(String(r.senderId)));
		const senders = list.map((r) => r.senderId);
		const [cards, locs] = await Promise.all([getProfileCards(senders), publicLocations([me, ...senders])]);
		const mine = locs.get(String(me))?.pos ?? null;
		const round = (await getServerSetting<number>("distance.roundMeters")) ?? 100;
		return {
			requests: list.map((r) => {
				const id = String(r.senderId);
				const card = cards.get(id);
				const loc = locs.get(id);
				const meters = mine && loc?.pos && card?.showDistance ? haversineMeters(mine, loc.pos) : null;
				return {
					id: r.id,
					profileId: Number(id),
					displayName: card?.displayName ?? null,
					primaryMediaHash: card?.primaryMediaHash ?? null,
					distance: meters == null ? null : displayedDistance(meters, { roundMeters: round, approximate: card?.approximateDistance ?? false }),
					status: r.status,
					postId: r.postId,
					createdAt: r.createdAt.getTime(),
					updatedAt: r.updatedAt.getTime(),
					onlineUntil: loc?.onlineUntil ?? null,
					favorite: rel.favorites.has(id),
				};
			}),
		};
	});

	app.get("/v1/rightnow/requests/outbox", auth, async (req) => {
		const rows = await db
			.select({ r: rightNowRequests, authorId: rightNowPosts.authorId, status: rightNowPosts.status, expiration: rightNowPosts.expiration })
			.from(rightNowRequests)
			.innerJoin(rightNowPosts, eq(rightNowPosts.id, rightNowRequests.postId))
			.where(eq(rightNowRequests.senderId, req.auth.userId))
			.orderBy(desc(rightNowRequests.createdAt))
			.limit(500);
		return {
			requests: rows
				// Requests end with their session, accepted ones too (the chat stays).
				.filter((x) => liveStatus({ status: x.status, expiration: x.expiration }) !== "EXPIRED")
				.map((x) => ({
					recipientProfileId: x.r.status === "ACCEPTED" ? Number(x.authorId) : null,
					status: x.r.status,
					postId: x.r.postId,
					createdAt: x.r.createdAt.getTime(),
					updatedAt: x.r.updatedAt.getTime(),
				})),
		};
	});

	app.put("/v1/rightnow/requests/:id", auth, async (req) => {
		const me = req.auth.userId;
		const b = z.object({ status: z.enum(["ACCEPTED", "REJECTED"]) }).safeParse(req.body);
		if (!b.success) throw errors.badRequest("Invalid request");
		const id = Number((req.params as { id: string }).id);
		if (!Number.isSafeInteger(id)) throw errors.notFound();
		const [row] = await db
			.select({ r: rightNowRequests, post: rightNowPosts })
			.from(rightNowRequests)
			.innerJoin(rightNowPosts, eq(rightNowPosts.id, rightNowRequests.postId))
			.where(eq(rightNowRequests.id, id))
			.limit(1);
		if (!row || row.post.authorId !== me || liveStatus(row.post) === "EXPIRED") throw errors.notFound();
		if (row.r.status === "ACCEPTED") {
			if (b.data.status === "ACCEPTED") return {};
			throw clientAction();
		}
		if (row.r.status === b.data.status) return {};
		const [updated] = await db.update(rightNowRequests).set({ status: b.data.status, updatedAt: new Date() }).where(eq(rightNowRequests.id, id)).returning();
		if (b.data.status === "ACCEPTED" && updated) {
			const medias = (await mediaItems(row.post.mediaIds)).map((m) => ({ mediaHash: m.hash, isNsfw: false }));
			await sendSystemMessage(me, row.r.senderId, "RightNowRequest", {
				requestId: updated.id,
				requestCreatedAt: updated.createdAt.getTime(),
				requestUpdatedAt: updated.updatedAt.getTime(),
				postStatus: liveStatus(row.post),
				postId: row.post.id,
				medias,
			});
		}
		// Rejecting stays silent: the sender gets no hint.
		return {};
	});

}

/**
 * Worker: expires posts and deletes every request of the ended session,
 * whatever its status. An accepted one has already opened the chat, which stays.
 */
export async function sweepExpiredRightNowPosts(): Promise<number> {
	const expired = await db
		.update(rightNowPosts)
		.set({ status: "EXPIRED", updatedAt: new Date() })
		.where(and(inArray(rightNowPosts.status, ["ACTIVE", "HIDDEN"]), sql`${rightNowPosts.expiration} <= now()`))
		.returning({ id: rightNowPosts.id });
	if (expired.length) {
		await db.delete(rightNowRequests).where(inArray(rightNowRequests.postId, expired.map((e) => e.id)));
	}
	return expired.length;
}
