import { and, asc, eq, gt, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { db } from "../db/client";
import { profiles, travelPlans } from "../db/schema";
import { checkCap } from "../entitlements/enforce";
import { decodeGeohash, encodeGeohash } from "../geo/obfuscate";
import { errors } from "../lib/errors";
import { isBlockedEitherWay } from "./relations";

const idParam = z.string().regex(/^\d{1,19}$/);
const geohashSchema = z.string().regex(/^[0-9bcdefghjkmnpqrstuvwxyz]{1,12}$/);
/** Spotify track ids are 22 base62 characters. */
const spotifyTrackId = z.string().regex(/^[0-9A-Za-z]{22}$/);
const MAX_SPOTIFY_SONGS = 5;
const MAX_TRAVEL_SPAN_MS = 366 * 86_400_000;
const MAX_TRAVEL_AHEAD_MS = 2 * 366 * 86_400_000;

/**
 * Other profiles see a travel destination only to a ~5 km cell (its center,
 * re-encoded to the 12 characters upstream uses): enough for the city name,
 * not enough to pin down a hotel. The owner sees their exact geohash.
 */
const PUBLIC_TRAVEL_PRECISION = 5;
export function coarsenTravelGeohash(geohash: string): string {
	return encodeGeohash(decodeGeohash(geohash.slice(0, PUBLIC_TRAVEL_PRECISION)), 12);
}

const travelSchema = z.object({
	travelPlanId: z.union([z.number().int(), z.string().regex(/^\d+$/)]).optional(),
	profileId: z.unknown().optional(),
	geohash: geohashSchema,
	startDate: z.number().int(),
	endDate: z.number().int(),
	showOnProfile: z.boolean().optional().default(false),
	notes: z.string().max(500).nullable().optional(),
});

function validateDates(start: number, end: number): void {
	if (end <= start) throw errors.parameter("endDate");
	if (end - start > MAX_TRAVEL_SPAN_MS) throw errors.parameter("endDate");
	if (end < Date.now()) throw errors.parameter("endDate");
	if (start > Date.now() + MAX_TRAVEL_AHEAD_MS) throw errors.parameter("startDate");
}

type TravelRow = typeof travelPlans.$inferSelect;

function serializeTravel(row: TravelRow, opts: { own: boolean }) {
	return {
		travelPlanId: Number(row.id),
		profileId: Number(row.userId),
		geohash: opts.own ? row.geohash : coarsenTravelGeohash(row.geohash),
		startDate: row.startDate.getTime(),
		endDate: row.endDate.getTime(),
		showOnProfile: row.showOnProfile,
		// Private notes stay private.
		notes: opts.own ? row.notes : null,
	};
}

export async function profileExtraRoutes(app: FastifyInstance): Promise<void> {
	// --- Travel plans -------------------------------------------------------------

	app.get("/v6/profiles/travel/:profileId", { preHandler: app.authenticate }, async (req) => {
		const target = BigInt(idParam.parse((req.params as { profileId: string }).profileId));
		const own = target === req.auth.userId;
		if (!own && (await isBlockedEitherWay(req.auth.profileId, String(target)))) return { travelPlans: [] };
		const rows = await db
			.select()
			.from(travelPlans)
			.where(
				own
					? eq(travelPlans.userId, target)
					: and(eq(travelPlans.userId, target), eq(travelPlans.showOnProfile, true), gt(travelPlans.endDate, new Date())),
			)
			.orderBy(asc(travelPlans.startDate))
			.limit(50);
		return { travelPlans: rows.map((r) => serializeTravel(r, { own })) };
	});

	app.post("/v6/profiles/travel", { preHandler: app.authenticate }, async (req) => {
		const body = travelSchema.safeParse(req.body);
		if (!body.success) throw errors.parameter(body.error.issues[0]?.path.join("."));
		const b = body.data;
		validateDates(b.startDate, b.endDate);
		const [active] = await db
			.select({ n: sql<number>`count(*)::int` })
			.from(travelPlans)
			.where(and(eq(travelPlans.userId, req.auth.userId), gt(travelPlans.endDate, new Date())));
		await checkCap(req.auth.userId, "travel.plans.max", active?.n ?? 0);
		await db.insert(travelPlans).values({
			userId: req.auth.userId,
			geohash: b.geohash,
			startDate: new Date(b.startDate),
			endDate: new Date(b.endDate),
			showOnProfile: b.showOnProfile,
			notes: b.notes ?? null,
		});
		return {};
	});

	app.post("/v6/profiles/travel/update", { preHandler: app.authenticate }, async (req) => {
		const body = travelSchema.safeParse(req.body);
		if (!body.success || body.data.travelPlanId == null) throw errors.parameter("travelPlanId");
		const b = body.data;
		validateDates(b.startDate, b.endDate);
		const updated = await db
			.update(travelPlans)
			.set({ geohash: b.geohash, startDate: new Date(b.startDate), endDate: new Date(b.endDate), showOnProfile: b.showOnProfile, notes: b.notes ?? null, updatedAt: new Date() })
			.where(and(eq(travelPlans.id, BigInt(b.travelPlanId!)), eq(travelPlans.userId, req.auth.userId)))
			.returning({ id: travelPlans.id });
		if (!updated.length) throw errors.notFound();
		return {};
	});

	app.delete("/v6/profiles/travel/:travelPlanId", { preHandler: app.authenticate }, async (req) => {
		const id = BigInt(idParam.parse((req.params as { travelPlanId: string }).travelPlanId));
		const deleted = await db
			.delete(travelPlans)
			.where(and(eq(travelPlans.id, id), eq(travelPlans.userId, req.auth.userId)))
			.returning({ id: travelPlans.id });
		if (!deleted.length) throw errors.notFound();
		return {};
	});

	// --- Spotify favorite songs ---------------------------------------------------

	app.get("/v4/spotify/favorites/:profileId", { preHandler: app.authenticate }, async (req) => {
		const target = BigInt(idParam.parse((req.params as { profileId: string }).profileId));
		if (target !== req.auth.userId && (await isBlockedEitherWay(req.auth.profileId, String(target)))) return { songIds: [] };
		const [row] = await db.select({ songIds: profiles.spotifySongIds }).from(profiles).where(eq(profiles.userId, target)).limit(1);
		return { songIds: row?.songIds ?? [] };
	});

	app.post("/v4/spotify/favorites", { preHandler: app.authenticate }, async (req) => {
		const body = z.object({ songIds: z.array(spotifyTrackId).max(MAX_SPOTIFY_SONGS) }).safeParse(req.body);
		if (!body.success) throw errors.parameter("songIds");
		const songIds = [...new Set(body.data.songIds)];
		await db
			.insert(profiles)
			.values({ userId: req.auth.userId, spotifySongIds: songIds })
			.onConflictDoUpdate({ target: profiles.userId, set: { spotifySongIds: songIds, updatedAt: new Date() } });
		return { songIds };
	});
}
