import { createHash } from "node:crypto";
import { sql, type SQL } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { redis } from "../cache/redis";
import { dbRead } from "../db/client";
import { capValue, isFeatureEnabled } from "../entitlements/enforce";
import { decodeGeohash, displayedDistance, encodeGeohash, haversineMeters, type LatLon } from "../geo/obfuscate";
import { touchOnline, updateLocation } from "../geo/location";
import { errors } from "../lib/errors";
import { publicImageUrl } from "../media/routes";
import { getServerSetting } from "../modules/settings/settings";
import { getProfileCards } from "../profiles/cards";
import { getRelations } from "../profiles/relations";
import { MEDIA_STATE_CODE, MEDIA_TYPE_CODE } from "../media/service";

const CANDIDATE_LIMIT = 1000;
const CANDIDATE_TTL_SECONDS = 20;
/** "Hot" / isPopular: this many distinct viewers in the last 24 hours. */
const POPULAR_MIN_VIEWERS = 10;
/** notRecentlyChatted: no chat activity with the viewer in this window. */
const RECENT_CHAT_HOURS = 24;

const geohash = z.string().regex(/^[0-9bcdefghjkmnpqrstuvwxyz]{1,12}$/);
const bool = z.enum(["true", "false"]).transform((v) => v === "true");
const csvInts = z
	.string()
	.regex(/^-?\d+(,-?\d+)*$/)
	.transform((v) => v.split(",").map(Number));

const filterSchema = z.object({
	onlineOnly: bool.optional(),
	online: bool.optional(),
	photoOnly: bool.optional(),
	faceOnly: bool.optional(),
	fresh: bool.optional(),
	favorites: bool.optional(),
	ageMin: z.coerce.number().int().min(18).max(120).optional(),
	ageMax: z.coerce.number().int().min(18).max(120).optional(),
	ageMinimum: z.coerce.number().int().min(18).max(120).optional(),
	ageMaximum: z.coerce.number().int().min(18).max(120).optional(),
	heightCmMin: z.coerce.number().min(0).max(300).optional(),
	heightCmMax: z.coerce.number().min(0).max(300).optional(),
	weightGramsMin: z.coerce.number().min(0).max(500_000).optional(),
	weightGramsMax: z.coerce.number().min(0).max(500_000).optional(),
	genders: csvInts.optional(),
	tribes: csvInts.optional(),
	tribesImInto: csvInts.optional(),
	lookingFor: csvInts.optional(),
	relationshipStatuses: csvInts.optional(),
	bodyTypes: csvInts.optional(),
	sexualPositions: csvInts.optional(),
	meetAt: csvInts.optional(),
	nsfwPics: csvInts.optional(),
	tags: z.string().max(200).optional(),
	shuffle: bool.optional(),
	hasAlbum: bool.optional(),
	rightNow: bool.optional(),
	hot: bool.optional(),
	notRecentlyChatted: bool.optional(),
});

const cascadeSchema = filterSchema.extend({
	nearbyGeoHash: geohash.optional(),
	exploreGeoHash: geohash.optional(),
	pageNumber: z.coerce.number().int().min(1).max(10_000).default(1),
});

const searchSchema = filterSchema.extend({
	nearbyGeoHash: geohash.optional(),
	exploreGeoHash: geohash.optional(),
	searchAfterDistance: z.coerce.number().min(0).optional(),
	searchAfterProfileId: z.coerce.number().int().optional(),
});

type Filters = z.infer<typeof filterSchema>;

/** `-1` = "not specified": matches profiles without a value. */
function scalarIn(column: SQL, values: number[] | undefined): SQL | null {
	if (!values?.length) return null;
	const real = values.filter((v) => v >= 0);
	const parts: SQL[] = [];
	if (real.length) parts.push(sql`${column} IN (${sql.join(real.map((v) => sql`${v}`), sql`, `)})`);
	if (values.includes(-1)) parts.push(sql`${column} IS NULL`);
	return sql`(${sql.join(parts, sql` OR `)})`;
}

function arrayOverlap(column: SQL, values: number[] | undefined): SQL | null {
	if (!values?.length) return null;
	const real = values.filter((v) => v >= 0);
	const parts: SQL[] = [];
	if (real.length) parts.push(sql`${column} && ARRAY[${sql.join(real.map((v) => sql`${v}`), sql`, `)}]::smallint[]`);
	if (values.includes(-1)) parts.push(sql`cardinality(${column}) = 0`);
	return sql`(${sql.join(parts, sql` OR `)})`;
}

/** Active, non-discreet Right Now posts (subquery). */
const ACTIVE_RIGHT_NOW = sql.raw(`(SELECT author_id, hosting FROM rightnow_posts WHERE status = 'ACTIVE' AND (expiration IS NULL OR expiration > now()) AND is_discreet <> 'TRUE')`);

/** Viewer-independent WHERE clauses (cacheable). */
function filterSql(f: Filters, advanced: boolean): SQL[] {
	const w: SQL[] = [];
	if (f.onlineOnly || f.online) w.push(sql`p.online_until > now() AND p.incognito = false`);
	if (f.photoOnly || f.faceOnly) w.push(sql`p.primary_media_hash IS NOT NULL`);
	if (!advanced) return w;
	const ageMin = f.ageMin ?? f.ageMinimum;
	const ageMax = f.ageMax ?? f.ageMaximum;
	if (ageMin) w.push(sql`u.birthday <= now() - make_interval(years => ${ageMin})`);
	if (ageMax) w.push(sql`u.birthday > now() - make_interval(years => ${ageMax + 1})`);
	if (f.heightCmMin != null) w.push(sql`p.height_cm >= ${f.heightCmMin}`);
	if (f.heightCmMax != null) w.push(sql`p.height_cm <= ${f.heightCmMax + 1}`);
	if (f.weightGramsMin != null) w.push(sql`p.weight_grams >= ${f.weightGramsMin}`);
	if (f.weightGramsMax != null) w.push(sql`p.weight_grams <= ${f.weightGramsMax + 500}`);
	if (f.fresh) w.push(sql`p.created_at > now() - interval '7 days'`);
	// At least one album with content.
	if (f.hasAlbum) w.push(sql`EXISTS (SELECT 1 FROM albums a JOIN album_content ac ON ac.album_id = a.id WHERE a.owner_id = p.user_id)`);
	// An active Right Now post. Discreet posts never point back to the profile.
	if (f.rightNow) w.push(sql`EXISTS (SELECT 1 FROM ${ACTIVE_RIGHT_NOW} r WHERE r.author_id = p.user_id)`);
	if (f.hot) w.push(sql`(SELECT count(*) FROM profile_views v WHERE v.viewed_id = p.user_id AND v.last_viewed_at > now() - interval '24 hours') >= ${POPULAR_MIN_VIEWERS}`);
	for (const clause of [
		arrayOverlap(sql`p.genders`, f.genders),
		arrayOverlap(sql`p.tribes`, f.tribes),
		arrayOverlap(sql`p.tribes_im_into`, f.tribesImInto),
		arrayOverlap(sql`p.looking_for`, f.lookingFor),
		arrayOverlap(sql`p.meet_at`, f.meetAt),
		scalarIn(sql`p.relationship_status`, f.relationshipStatuses),
		scalarIn(sql`p.body_type`, f.bodyTypes),
		scalarIn(sql`p.sexual_position`, f.sexualPositions),
		scalarIn(sql`p.nsfw`, f.nsfwPics),
	]) {
		if (clause) w.push(clause);
	}
	if (f.tags) {
		const tags = f.tags.split(",").map((t) => t.trim()).filter(Boolean).slice(0, 10);
		if (tags.length) w.push(sql`p.profile_tags && ARRAY[${sql.join(tags.map((t) => sql`${t}`), sql`, `)}]::text[]`);
	}
	return w;
}

/**
 * `lat`/`lon` are the obfuscated public position. The fuzz radius is never part
 * of a candidate or a response: knowing it would narrow down where the real
 * position can be.
 */
/** Online state and map opt-in are loaded fresh per page (pageExtras), never from this cache. */
type Candidate = { id: string; lat: number; lon: number; visiting: boolean };

/**
 * Nearest matching profiles around `center` (KNN on the public_location GiST
 * index). Shared by everyone in the same ~150 m cell with the same filters
 * for 20 s; viewer-specific filtering happens afterwards.
 */
async function candidates(center: LatLon, f: Filters, advanced: boolean): Promise<Candidate[]> {
	const cell = encodeGeohash(center, 7);
	const filterKey = createHash("sha1").update(JSON.stringify({ ...f, shuffle: undefined, advanced })).digest("hex").slice(0, 16);
	const key = `cas:${cell}:${filterKey}`;
	const cached = await redis.get(key);
	if (cached) return JSON.parse(cached) as Candidate[];

	const c = decodeGeohash(cell);
	const point = sql`ST_SetSRID(ST_MakePoint(${c.lon}, ${c.lat}), 4326)::geography`;
	const where = [
		sql`p.public_location IS NOT NULL`,
		sql`u.deleted_at IS NULL`,
		sql`(u.banned_until IS NULL OR u.banned_until <= now())`,
		sql`p.location_search_opt_out = false`,
		...filterSql(f, advanced),
	];
	const rows = (await dbRead.execute(sql`
		SELECT p.user_id::text AS id,
		       ST_Y(p.public_location::geometry) AS lat,
		       ST_X(p.public_location::geometry) AS lon,
		       p.is_visiting AS visiting
		FROM profiles p
		JOIN users u ON u.id = p.user_id
		WHERE ${sql.join(where, sql` AND `)}
		ORDER BY p.public_location <-> ${point}
		LIMIT ${CANDIDATE_LIMIT}
	`)) as unknown as { id: string; lat: number; lon: number; visiting: boolean }[];
	const list: Candidate[] = rows.map((r) => ({
		id: r.id,
		lat: Number(r.lat),
		lon: Number(r.lon),
		visiting: !!r.visiting,
	}));
	await redis.set(key, JSON.stringify(list), "EX", CANDIDATE_TTL_SECONDS);
	return list;
}

/**
 * Favorites cascade: the viewer's own favorites wherever they are (not just the
 * nearest N), with the same filters. Per viewer, so not shared-cached.
 */
async function favoriteCandidates(viewer: bigint, f: Filters, advanced: boolean): Promise<Candidate[]> {
	const where = [
		sql`p.public_location IS NOT NULL`,
		sql`u.deleted_at IS NULL`,
		sql`(u.banned_until IS NULL OR u.banned_until <= now())`,
		...filterSql({ ...f, favorites: undefined }, advanced),
	];
	const rows = (await dbRead.execute(sql`
		SELECT p.user_id::text AS id,
		       ST_Y(p.public_location::geometry) AS lat,
		       ST_X(p.public_location::geometry) AS lon,
		       p.is_visiting AS visiting
		FROM favorites fav
		JOIN profiles p ON p.user_id = fav.target_id
		JOIN users u ON u.id = p.user_id
		WHERE fav.owner_id = ${viewer} AND ${sql.join(where, sql` AND `)}
		LIMIT ${CANDIDATE_LIMIT}
	`)) as unknown as { id: string; lat: number; lon: number; visiting: boolean }[];
	return rows.map((r) => ({
		id: r.id,
		lat: Number(r.lat),
		lon: Number(r.lon),
		visiting: !!r.visiting,
	}));
}

async function viewerPublicPoint(userId: bigint): Promise<LatLon | null> {
	const [row] = (await dbRead.execute(sql`SELECT ST_Y(public_location::geometry) AS lat, ST_X(public_location::geometry) AS lon FROM profiles WHERE user_id = ${userId} AND public_location IS NOT NULL`)) as unknown as { lat: number; lon: number }[];
	return row ? { lat: Number(row.lat), lon: Number(row.lon) } : null;
}

/** Stable per-viewer shuffle (seeded by viewer + day) so pages don't repeat. */
function shuffleSeeded<T>(list: T[], seed: string): T[] {
	const out = [...list];
	let h = createHash("sha256").update(seed).digest().readUInt32BE(0);
	for (let i = out.length - 1; i > 0; i--) {
		h = (Math.imul(h ^ (h >>> 15), 2246822507) ^ Math.imul(h ^ (h >>> 13), 3266489909)) >>> 0;
		const j = h % (i + 1);
		[out[i], out[j]] = [out[j]!, out[i]!];
	}
	return out;
}

type Prepared = { list: (Candidate & { distance: number | null })[]; pageSize: number; maxPages: number; mapAllowed: boolean; round: number };

async function prepare(req: FastifyRequest, q: { nearbyGeoHash?: string; exploreGeoHash?: string } & Filters): Promise<Prepared> {
	const viewer = req.auth.userId;
	const [advanced, pageSizeCap, maxPages, round] = await Promise.all([
		isFeatureEnabled(viewer, "grid.filters"),
		capValue(viewer, "grid.pageSize"),
		capValue(viewer, "grid.maxPages"),
		getServerSetting<number>("distance.roundMeters"),
	]);
	// Upstream: every non-favorites cascade moves us to nearbyGeoHash and marks us online.
	if (q.nearbyGeoHash && !q.favorites) await updateLocation(viewer, decodeGeohash(q.nearbyGeoHash));
	await touchOnline(viewer);

	const viewerPoint = await viewerPublicPoint(viewer);
	const center = q.exploreGeoHash ? decodeGeohash(q.exploreGeoHash) : viewerPoint ?? (q.nearbyGeoHash ? decodeGeohash(q.nearbyGeoHash) : null);
	if (!center) throw errors.parameter("nearbyGeoHash");

	const mapAllowed = req.auth.featureFlags.has("browse-maps-v1_5");

	const [list, rel] = await Promise.all([q.favorites ? favoriteCandidates(viewer, q, advanced) : candidates(center, q, advanced), getRelations(String(viewer))]);
	const self = String(viewer);
	const recentChats = advanced && q.notRecentlyChatted ? await recentChatPartners(viewer) : null;
	const onlineNow = q.onlineOnly || q.online ? await onlineNowAmong(list.map((c) => c.id)) : null;
	const filtered = list.filter(
		(c) => c.id !== self && !rel.blocked.has(c.id) && !rel.hidden.has(c.id) && (!q.favorites || rel.favorites.has(c.id)) && !recentChats?.has(c.id) && (!onlineNow || onlineNow.has(c.id)),
	);
	const from = viewerPoint ?? center;
	let withDistance = filtered.map((c) => ({ ...c, distance: haversineMeters(from, c) }));
	withDistance.sort((a, b) => a.distance - b.distance || Number(a.id) - Number(b.id));
	if (q.shuffle) withDistance = shuffleSeeded(withDistance, `${self}:${new Date().toISOString().slice(0, 10)}`);
	return { list: withDistance, pageSize: Math.min(100, pageSizeCap), maxPages, mapAllowed, round: round ?? 100 };
}

/** Which of these profiles are online right now (and not incognito). */
async function onlineNowAmong(ids: string[]): Promise<Set<string>> {
	if (!ids.length) return new Set();
	const list = sql`ARRAY[${sql.join(ids.map((id) => sql`${id}`), sql`, `)}]::bigint[]`;
	const rows = (await dbRead.execute(sql`SELECT user_id::text AS id FROM profiles WHERE user_id = ANY(${list}) AND online_until > now() AND incognito = false`)) as unknown as { id: string }[];
	return new Set(rows.map((r) => r.id));
}

/** Profiles the viewer had chat activity with in the last RECENT_CHAT_HOURS. */
async function recentChatPartners(viewer: bigint): Promise<Set<string>> {
	const rows = (await dbRead.execute(sql`
		SELECT other_id::text AS id FROM conversation_members
		WHERE user_id = ${viewer} AND last_activity_at > now() - make_interval(hours => ${RECENT_CHAT_HOURS})
	`)) as unknown as { id: string }[];
	return new Set(rows.map((r) => r.id));
}

type PageExtras = {
	/** Fresh online state (never from the 20 s candidate cache, so incognito applies at once). */
	presence: Map<string, { onlineUntil: number | null; lastSeen: number | null }>;
	/**
	 * Obfuscated public position, only for profiles that opted in to the map
	 * (showOnMap) and aren't incognito. Fresh, so switching it off hides you at once.
	 */
	map: Map<string, { lat: number; lon: number }>;
	chat: Map<string, { unread: number; lastChat: number }>;
	viewed: Map<string, number>;
	rightNow: Map<string, "HOSTING" | "NOT_HOSTING">;
	popular: Set<string>;
	hasAlbum: Set<string>;
};

/** Per-viewer card fields for one page of results, in one round of batch queries. */
async function pageExtras(viewer: bigint, ids: string[]): Promise<PageExtras> {
	const out: PageExtras = { presence: new Map(), map: new Map(), chat: new Map(), viewed: new Map(), rightNow: new Map(), popular: new Set(), hasAlbum: new Set() };
	if (!ids.length) return out;
	const list = sql`ARRAY[${sql.join(ids.map((id) => sql`${id}`), sql`, `)}]::bigint[]`;
	const [presence, chat, viewed, rightNow, popular, albums] = (await Promise.all([
		dbRead.execute(sql`
			SELECT user_id::text AS id,
			       CASE WHEN incognito THEN NULL ELSE (extract(epoch FROM online_until) * 1000)::bigint END AS online_until,
			       CASE WHEN incognito THEN NULL ELSE (extract(epoch FROM last_seen_at) * 1000)::bigint END AS last_seen,
			       CASE WHEN show_on_map AND NOT incognito THEN ST_Y(public_location::geometry) END AS map_lat,
			       CASE WHEN show_on_map AND NOT incognito THEN ST_X(public_location::geometry) END AS map_lon
			FROM profiles WHERE user_id = ANY(${list})`),
		dbRead.execute(sql`
			SELECT other_id::text AS id, unread_count AS unread, (extract(epoch FROM last_activity_at) * 1000)::bigint AS last_chat
			FROM conversation_members WHERE user_id = ${viewer} AND other_id = ANY(${list}) AND last_activity_at IS NOT NULL`),
		dbRead.execute(sql`
			SELECT viewed_id::text AS id, (extract(epoch FROM last_viewed_at) * 1000)::bigint AS at
			FROM profile_views WHERE viewer_id = ${viewer} AND viewed_id = ANY(${list})`),
		dbRead.execute(sql`SELECT author_id::text AS id, bool_or(hosting) AS hosting FROM ${ACTIVE_RIGHT_NOW} r WHERE author_id = ANY(${list}) GROUP BY author_id`),
		dbRead.execute(sql`
			SELECT viewed_id::text AS id FROM profile_views
			WHERE viewed_id = ANY(${list}) AND last_viewed_at > now() - interval '24 hours'
			GROUP BY viewed_id HAVING count(*) >= ${POPULAR_MIN_VIEWERS}`),
		dbRead.execute(sql`SELECT DISTINCT a.owner_id::text AS id FROM albums a JOIN album_content ac ON ac.album_id = a.id WHERE a.owner_id = ANY(${list})`),
	])) as unknown as [
		{ id: string; online_until: string | null; last_seen: string | null; map_lat: number | null; map_lon: number | null }[],
		{ id: string; unread: number; last_chat: string }[],
		{ id: string; at: string }[],
		{ id: string; hosting: boolean }[],
		{ id: string }[],
		{ id: string }[],
	];
	for (const r of presence) {
		out.presence.set(r.id, { onlineUntil: r.online_until == null ? null : Number(r.online_until), lastSeen: r.last_seen == null ? null : Number(r.last_seen) });
		if (r.map_lat != null && r.map_lon != null) out.map.set(r.id, { lat: Number(r.map_lat), lon: Number(r.map_lon) });
	}
	for (const r of chat) out.chat.set(r.id, { unread: Number(r.unread), lastChat: Number(r.last_chat) });
	for (const r of viewed) out.viewed.set(r.id, Number(r.at));
	for (const r of rightNow) out.rightNow.set(r.id, r.hosting ? "HOSTING" : "NOT_HOSTING");
	for (const r of popular) out.popular.add(r.id);
	for (const r of albums) out.hasAlbum.add(r.id);
	return out;
}

export async function browseRoutes(app: FastifyInstance): Promise<void> {
	app.get("/v4/cascade", { preHandler: app.authenticate }, async (req) => {
		const parsed = cascadeSchema.safeParse(req.query);
		if (!parsed.success) throw errors.parameter(parsed.error.issues[0]?.path.join("."));
		const q = parsed.data;
		const prep = await prepare(req, q);
		if (q.pageNumber > prep.maxPages) return { items: [], nextPage: null, shuffled: !!q.shuffle, hiddenProfiles: [], hiddenProfileInfo: [] };
		const start = (q.pageNumber - 1) * prep.pageSize;
		const page = prep.list.slice(start, start + prep.pageSize);
		const [cards, rel, extra] = await Promise.all([getProfileCards(page.map((c) => c.id)), getRelations(req.auth.profileId), pageExtras(req.auth.userId, page.map((c) => c.id))]);
		const items = page.flatMap((c) => {
			const card = cards.get(c.id);
			if (!card || card.deleted || card.banned) return [];
			const distanceMeters = card.showDistance && c.distance != null ? displayedDistance(c.distance, { roundMeters: prep.round, approximate: card.approximateDistance }) : null;
			// Coordinates only for profiles that opted in to the map (showOnMap), and
			// only to viewers with the map flag; everyone else gets none at all.
			const pin = prep.mapAllowed ? extra.map.get(c.id) : undefined;
			const mapFields = pin ? { fuzzedLat: pin.lat, fuzzedLon: pin.lon } : {};
			return [
				{
					type: "full_profile_v1",
					data: {
						profileId: Number(c.id),
						onlineUntil: extra.presence.get(c.id)?.onlineUntil ?? null,
						displayName: card.displayName,
						distanceMeters,
						lastOnline: extra.presence.get(c.id)?.lastSeen ?? null,
						rightNow: extra.rightNow.get(c.id) ?? "NOT_ACTIVE",
						unreadCount: extra.chat.get(c.id)?.unread ?? 0,
						isVisiting: c.visiting,
						isPopular: extra.popular.has(c.id),
						isOnPrep: false,
						primaryImageUrl: card.primaryMediaHash ? publicImageUrl("thumb", "320x320", card.primaryMediaHash) : null,
						favorite: rel.favorites.has(c.id),
						viewed: extra.viewed.has(c.id),
						chatted: extra.chat.has(c.id),
						roaming: false,
						age: card.showAge ? card.age : null,
						heightCm: card.heightCm,
						weightGrams: card.weightGrams,
						bodyType: card.bodyType,
						sexualPosition: card.showPosition ? card.sexualPosition : null,
						medias: card.medias.map((m) => ({ mediaHash: m.mediaHash, type: MEDIA_TYPE_CODE[m.kind], state: MEDIA_STATE_CODE[m.state as keyof typeof MEDIA_STATE_CODE] ?? 0 })),
						...mapFields,
					},
				},
			];
		});
		const hasMore = start + prep.pageSize < prep.list.length && q.pageNumber < prep.maxPages;
		return { items, nextPage: hasMore ? q.pageNumber + 1 : null, shuffled: !!q.shuffle, hiddenProfiles: [], hiddenProfileInfo: [] };
	});

	app.get("/v7/search", { preHandler: app.authenticate }, async (req) => {
		const parsed = searchSchema.safeParse(req.query);
		if (!parsed.success) throw errors.parameter(parsed.error.issues[0]?.path.join("."));
		const q = parsed.data;
		const prep = await prepare(req, q);
		const afterM = q.searchAfterDistance != null ? q.searchAfterDistance * 1000 : null;
		const afterId = q.searchAfterProfileId ?? null;
		// Keyset: continue strictly after (distance, id) of the last result.
		const rest = afterM == null ? prep.list : prep.list.filter((c) => c.distance! > afterM || (Math.abs(c.distance! - afterM) < 0.5 && afterId != null && Number(c.id) > afterId));
		const page = rest.slice(0, Math.min(600, prep.pageSize * 6));
		const [cards, rel, extra] = await Promise.all([getProfileCards(page.map((c) => c.id)), getRelations(req.auth.profileId), pageExtras(req.auth.userId, page.map((c) => c.id))]);
		const profilesOut = page.flatMap((c) => {
			const card = cards.get(c.id);
			if (!card || card.deleted || card.banned) return [];
			return [
				{
					age: card.showAge ? card.age : 0,
					displayName: card.displayName ?? "",
					distance: card.showDistance && c.distance != null ? displayedDistance(c.distance, { roundMeters: prep.round, approximate: card.approximateDistance }) : null,
					hasFaceRecognition: false,
					isFavorite: rel.favorites.has(c.id),
					new: Date.now() - card.createdAt < 7 * 86_400_000,
					lastChatTimestamp: extra.chat.get(c.id)?.lastChat ?? 0,
					lastViewed: extra.viewed.get(c.id) ?? null,
					lastUpdatedTime: card.lastUpdatedTime,
					medias: card.medias.map((m) => ({ mediaHash: m.mediaHash, type: MEDIA_TYPE_CODE[m.kind], state: MEDIA_STATE_CODE[m.state as keyof typeof MEDIA_STATE_CODE] ?? 0, reason: null, takenOnGrindr: m.takenOnGrindr, createdAt: m.createdAt })),
					profileId: Number(c.id),
					profileImageMediaHash: card.primaryMediaHash,
					profileTags: card.profileTags,
					seen: extra.presence.get(c.id)?.lastSeen ?? null,
					showAge: card.showAge,
					showDistance: card.showDistance,
					approximateDistance: card.approximateDistance,
					boosting: false,
					hasAlbum: extra.hasAlbum.has(c.id),
					gender: card.genders.length ? card.genders : [-1],
				},
			];
		});
		const last = page[page.length - 1];
		return {
			profiles: profilesOut,
			// Cursor stays on the raw (unrounded) public distance so pages never skip or repeat.
			lastDistanceInKm: last?.distance != null ? last.distance / 1000 : 0,
			lastProfileId: last ? Number(last.id) : 0,
		};
	});
}
