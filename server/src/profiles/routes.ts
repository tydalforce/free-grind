import { eq, sql } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { db, dbRead } from "../db/client";
import { profiles } from "../db/schema";
import { isFeatureEnabled, requireEnabled } from "../entitlements/enforce";
import { decodeGeohash } from "../geo/obfuscate";
import { refreshPublicLocation, setIncognito, updateLocation } from "../geo/location";
import { ApiError, errors } from "../lib/errors";
import { getServerSetting } from "../modules/settings/settings";
import { getProfileCards, invalidateProfileCard } from "./cards";
import { activeCatalogIds } from "../catalogs/service";
import { getRelations } from "./relations";
import { bannedTermsHits } from "../moderation/bannedTerms";
import { profileStub, serializeProfileDetail } from "./serialize";

type Dynamic = {
	distance: number | null;
	onlineUntil: number | null;
	seen: number | null;
	visiting: boolean;
	/** My tap to them within the last day (upstream `tapped`/`tapType`). */
	tapType: number | null;
	/** Their latest tap to me. */
	lastReceivedTapTimestamp: number | null;
};

/** Distances between public positions + presence for many targets in one query. */
export async function dynamicFor(viewerId: bigint, targetIds: bigint[]): Promise<Map<string, Dynamic>> {
	if (!targetIds.length) return new Map();
	const rows = (await dbRead.execute(sql`
		SELECT t.user_id::text AS id,
		       CASE WHEN v.public_location IS NULL OR t.public_location IS NULL THEN NULL
		            ELSE ST_Distance(v.public_location, t.public_location) END AS distance,
		       (extract(epoch FROM t.online_until) * 1000)::bigint AS online_until,
		       (extract(epoch FROM t.last_seen_at) * 1000)::bigint AS seen,
		       t.incognito,
		       (SELECT tp.tap_type FROM taps tp WHERE tp.sender_id = ${viewerId} AND tp.recipient_id = t.user_id AND tp.created_at > now() - interval '1 day') AS my_tap,
		       (SELECT (extract(epoch FROM tr.created_at) * 1000)::bigint FROM taps tr WHERE tr.sender_id = t.user_id AND tr.recipient_id = ${viewerId}) AS their_tap,
		       t.is_visiting AS visiting
		FROM profiles t
		LEFT JOIN profiles v ON v.user_id = ${viewerId}
		WHERE t.user_id IN (${sql.join(targetIds.map((id) => sql`${id}`), sql`, `)})
	`)) as unknown as { id: string; distance: number | null; online_until: string | null; seen: string | null; incognito: boolean; visiting: boolean; my_tap: number | null; their_tap: string | null }[];
	return new Map(
		rows.map((r) => [
			r.id,
			{
				distance: r.distance == null ? null : Number(r.distance),
				// Incognito profiles never expose presence.
				onlineUntil: r.incognito || r.online_until == null ? null : Number(r.online_until),
				seen: r.incognito || r.seen == null ? null : Number(r.seen),
				// Only the yes/no leaves the server, never home or distance.
				visiting: !!r.visiting,
				tapType: r.my_tap == null ? null : Number(r.my_tap),
				lastReceivedTapTimestamp: r.their_tap == null ? null : Number(r.their_tap),
			},
		]),
	);
}

async function roundMeters(): Promise<number> {
	return (await getServerSetting<number>("distance.roundMeters")) ?? 100;
}

/** Shared by /v7/profiles/{id} and POST /v3/profiles. */
async function detailsFor(req: FastifyRequest, ids: bigint[], opts: { stubBlocked: boolean }) {
	const viewer = req.auth.userId;
	const [cards, rel, dyn, round] = await Promise.all([getProfileCards(ids), getRelations(String(viewer)), dynamicFor(viewer, ids), roundMeters()]);
	return ids.map((id) => {
		const key = String(id);
		const card = cards.get(key);
		if (!card || card.deleted || card.banned) return profileStub(key, "gone");
		if (opts.stubBlocked && rel.blocked.has(key)) return profileStub(key, "blocked");
		const d = dyn.get(key);
		return serializeProfileDetail(card, {
			isSelf: id === viewer,
			distanceMeters: d?.distance ?? null,
			isFavorite: rel.favorites.has(key),
			onlineUntil: d?.onlineUntil ?? null,
			seen: d?.seen ?? null,
			isVisiting: d?.visiting ?? false,
			roundMeters: round,
			tapType: d?.tapType ?? null,
			lastReceivedTapTimestamp: d?.lastReceivedTapTimestamp ?? null,
		});
	});
}

// --- Validation ------------------------------------------------------------------

const smallInt = z.number().int().min(-1).max(32767);
const intList = z.array(smallInt).max(20);
const nullableInt = smallInt.nullable();
const socialNetworks = z.record(z.string(), z.object({ userId: z.string().max(100) }).nullable()).optional();

const structuredFields = {
	nsfw: nullableInt.optional(),
	bodyType: nullableInt.optional(),
	ethnicity: nullableInt.optional(),
	hivStatus: nullableInt.optional(),
	lastTestedDate: z.number().int().nullable().optional(),
	relationshipStatus: nullableInt.optional(),
	sexualPosition: nullableInt.optional(),
	height: z.number().min(0).max(300).nullable().optional(),
	weight: z.number().min(0).max(500_000).nullable().optional(),
	genders: intList.optional(),
	pronouns: intList.optional(),
	grindrTribes: intList.optional(),
	tribesImInto: intList.optional(),
	lookingFor: intList.optional(),
	meetAt: intList.optional(),
	vaccines: intList.optional(),
	sexualHealth: intList.optional(),
	profileTags: z.array(z.string().min(1).max(60)).max(30).optional(),
	showAge: z.boolean().optional(),
	showDistance: z.boolean().optional(),
	showPosition: z.boolean().optional(),
	showTribes: z.boolean().optional(),
	socialNetworks,
};

const patchSchema = z.object({ ...structuredFields, displayName: z.unknown().optional(), aboutMe: z.unknown().optional() }).passthrough();
const fullSchema = z
	.object({
		...structuredFields,
		displayName: z.string().max(30).nullable().optional(),
		aboutMe: z.string().max(1000).nullable().optional(),
		approximateDistance: z.boolean().optional(),
		showOnMap: z.boolean().optional(),
		age: z.unknown().optional(),
	})
	.passthrough();

/**
 * Managed fields only accept active catalog entries (genders, pronouns, tag
 * keys); unknown ones are dropped rather than failing the whole save.
 */
async function sanitizeCatalogFields<T extends { genders?: number[]; pronouns?: number[]; profileTags?: string[] }>(body: T): Promise<T> {
	const active = await activeCatalogIds();
	return {
		...body,
		...(body.genders ? { genders: body.genders.filter((g) => active.genders.has(g)) } : {}),
		...(body.pronouns ? { pronouns: body.pronouns.filter((p) => active.pronouns.has(p)) } : {}),
		...(body.profileTags ? { profileTags: body.profileTags.filter((t) => active.tagKeys.has(t)) } : {}),
	};
}

function columnsFrom(body: z.infer<typeof patchSchema>): Partial<typeof profiles.$inferInsert> {
	const c: Partial<typeof profiles.$inferInsert> = {};
	const set = <K extends keyof typeof c>(k: K, v: (typeof c)[K] | undefined) => {
		if (v !== undefined) c[k] = v;
	};
	set("nsfw", body.nsfw);
	set("bodyType", body.bodyType);
	set("ethnicity", body.ethnicity);
	set("hivStatus", body.hivStatus);
	set("lastTestedDate", body.lastTestedDate);
	set("relationshipStatus", body.relationshipStatus);
	set("sexualPosition", body.sexualPosition);
	set("heightCm", body.height);
	set("weightGrams", body.weight);
	set("genders", body.genders);
	set("pronouns", body.pronouns);
	set("tribes", body.grindrTribes);
	set("tribesImInto", body.tribesImInto);
	set("lookingFor", body.lookingFor);
	set("meetAt", body.meetAt);
	set("vaccines", body.vaccines);
	set("sexualHealth", body.sexualHealth);
	set("profileTags", body.profileTags);
	set("showAge", body.showAge);
	set("showDistance", body.showDistance);
	set("showPosition", body.showPosition);
	set("showTribes", body.showTribes);
	return c;
}

/** Upstream 400 hit_banned_terms: the whole update is rejected, offending fields named. */
async function checkBannedTerms(fields: { display_name?: string | null; about_me?: string | null }): Promise<void> {
	const hits = await bannedTermsHits(fields);
	if (hits) throw new ApiError(400, { type: "urn:gr:err:hit_banned_terms", title: "Banned terms", status: 400, ...hits });
}

async function upsertProfile(userId: bigint, values: Partial<typeof profiles.$inferInsert>): Promise<void> {
	await db
		.insert(profiles)
		.values({ userId, ...values })
		.onConflictDoUpdate({ target: profiles.userId, set: { ...values, updatedAt: new Date() } });
	await invalidateProfileCard(userId);
}

export async function profileRoutes(app: FastifyInstance): Promise<void> {
	app.get("/v4/me/profile", { preHandler: app.authenticate, config: { allowUnverified: true } }, async (req) => ({ profiles: await detailsFor(req, [req.auth.userId], { stubBlocked: false }) }));

	app.get("/v7/profiles/:id", { preHandler: app.authenticate }, async (req) => {
		const { id } = z.object({ id: z.string().regex(/^\d{1,19}$/) }).parse(req.params);
		// Always 200, blocked/deleted profiles come back as upstream-style stubs.
		return { profiles: await detailsFor(req, [BigInt(id)], { stubBlocked: true }) };
	});

	app.post("/v3/profiles", { preHandler: app.authenticate }, async (req) => {
		const body = z.object({ targetProfileIds: z.array(z.union([z.string().regex(/^\d{1,19}$/), z.number().int()])).max(150) }).safeParse(req.body);
		if (!body.success) throw errors.badRequest();
		const ids = [...new Set(body.data.targetProfileIds.map((v) => BigInt(v)))];
		// Batch lookup works for blocked profiles too (upstream), so no stubbing here.
		return { profiles: (await detailsFor(req, ids, { stubBlocked: false })).filter((p) => p.lastUpdatedTime != null) };
	});

	app.patch("/v4/me/profile", { preHandler: app.authenticate }, async (req) => {
		const parsed = patchSchema.safeParse(req.body);
		if (!parsed.success) throw errors.parameter(parsed.error.issues[0]?.path.join("."));
		const body = { ...parsed, data: await sanitizeCatalogFields(parsed.data) };
		// PATCH ignores displayName/aboutMe silently (upstream).
		await upsertProfile(req.auth.userId, { ...columnsFrom(body.data), ...(body.data.socialNetworks ? { extra: sql`profiles.extra || ${JSON.stringify({ socialNetworks: body.data.socialNetworks })}::jsonb` as unknown as Record<string, unknown> } : {}) });
		return {};
	});

	app.put("/v3.1/me/profile", { preHandler: app.authenticate }, async (req) => {
		const parsed = fullSchema.safeParse(req.body);
		if (!parsed.success) throw errors.parameter(parsed.error.issues[0]?.path.join("."));
		const body = { ...parsed, data: await sanitizeCatalogFields(parsed.data) };
		const displayName = body.data.displayName?.trim() || null;
		const aboutMe = body.data.aboutMe?.trim() || null;
		await checkBannedTerms({ display_name: displayName, about_me: aboutMe });
		await upsertProfile(req.auth.userId, {
			...columnsFrom(body.data),
			displayName,
			aboutMe,
			...(body.data.approximateDistance !== undefined ? { approximateDistance: body.data.approximateDistance } : {}),
			...(body.data.showOnMap !== undefined ? { showOnMap: body.data.showOnMap } : {}),
			extra: { socialNetworks: body.data.socialNetworks ?? {} },
		});
		return {};
	});

	// --- Account preferences ------------------------------------------------------

	app.get("/v3/me/prefs/settings", { preHandler: app.authenticate }, async (req) => {
		const [p] = await db.select().from(profiles).where(eq(profiles.userId, req.auth.userId)).limit(1);
		// Incognito needs the entitlement (paid upstream, per role here); without it, it's off.
		let incognito = p?.incognito ?? false;
		if (incognito && !(await isFeatureEnabled(req.auth.userId, "incognito"))) {
			await setIncognito(req.auth.userId, false);
			incognito = false;
		}
		return {
			profileId: Number(req.auth.profileId),
			locationSearchOptOut: p?.locationSearchOptOut ?? false,
			incognito,
			hideViewedMe: p?.hideViewedMe ?? false,
			approximateDistance: p?.approximateDistance ?? false,
			viewRightNowNsfw: p?.viewRightNowNsfw ?? false,
			mapLocationFuzzRadius: p?.mapFuzzRadius ?? null,
			showOnMap: p?.showOnMap ?? false,
			prepReminderEnabled: p?.prepReminderEnabled ?? false,
			prepReminderTime: p?.prepReminderTime ?? null,
		};
	});

	app.put("/v3/me/prefs/settings", { preHandler: app.authenticate }, async (req) => {
		const body = z
			.object({
				settings: z.object({
					locationSearchOptOut: z.boolean().optional(),
					incognito: z.boolean().optional(),
					hideViewedMe: z.boolean().optional(),
					approximateDistance: z.boolean().optional(),
					viewRightNowNsfw: z.boolean().optional(),
					showOnMap: z.boolean().optional(),
					mapLocationFuzzRadius: z.number().int().min(0).max(100_000).nullable().optional(),
					// Pre-26.10 name of the same field.
					mapLocationRadius: z.number().int().min(0).max(100_000).nullable().optional(),
					prepReminderEnabled: z.boolean().optional(),
					prepReminderTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).nullable().optional(),
				}),
			})
			.safeParse(req.body);
		if (!body.success) throw errors.parameter(body.error.issues[0]?.path.join("."));
		const s = body.data.settings;
		if (s.incognito === true) await requireEnabled(req.auth.userId, "incognito");
		const radius = s.mapLocationFuzzRadius !== undefined ? s.mapLocationFuzzRadius : s.mapLocationRadius;
		const values: Partial<typeof profiles.$inferInsert> = {};
		if (s.locationSearchOptOut !== undefined) values.locationSearchOptOut = s.locationSearchOptOut;
		if (s.hideViewedMe !== undefined) values.hideViewedMe = s.hideViewedMe;
		if (s.approximateDistance !== undefined) values.approximateDistance = s.approximateDistance;
		if (s.viewRightNowNsfw !== undefined) values.viewRightNowNsfw = s.viewRightNowNsfw;
		if (s.showOnMap !== undefined) values.showOnMap = s.showOnMap;
		if (radius !== undefined) values.mapFuzzRadius = radius;
		if (s.prepReminderEnabled !== undefined) values.prepReminderEnabled = s.prepReminderEnabled;
		if (s.prepReminderTime !== undefined) values.prepReminderTime = s.prepReminderTime;
		await upsertProfile(req.auth.userId, values);
		// Separately: switching it also flips the online state at once.
		if (s.incognito !== undefined) await setIncognito(req.auth.userId, s.incognito);
		// A new radius must move the public point now, not on the next location update.
		if (radius !== undefined) await refreshPublicLocation(req.auth.userId);
		return {};
	});

	// --- Location -----------------------------------------------------------------

	/** Accepts {geohash} (upstream) and the variants the client falls back to (useLocateProfile.tsx). */
	app.put("/v4/location", { preHandler: app.authenticate }, async (req) => {
		const b = (req.body ?? {}) as Record<string, unknown>;
		const geohash = typeof b.geohash === "string" ? b.geohash : typeof b.nearbyGeoHash === "string" ? b.nearbyGeoHash : null;
		let point: { lat: number; lon: number } | null = null;
		if (geohash && /^[0-9bcdefghjkmnpqrstuvwxyz]{4,12}$/.test(geohash)) point = decodeGeohash(geohash);
		else {
			const lat = Number(b.lat ?? b.latitude);
			const lon = Number(b.lon ?? b.longitude);
			if (Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) point = { lat, lon };
		}
		if (!point) throw errors.parameter("geohash");
		await updateLocation(req.auth.userId, point);
		return {};
	});

}
