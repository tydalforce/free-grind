import { eq, sql } from "drizzle-orm";
import { db } from "../db/client";
import { profiles, users } from "../db/schema";
import { getServerSetting } from "../modules/settings/settings";
import { redis } from "../cache/redis";
import { notifyQueue } from "../jobs/queues";
import { isFeatureEnabled } from "../entitlements/enforce";
import { invalidateProfileCard } from "../profiles/cards";
import { recomputeVisiting } from "./visiting";
import { clampRadius, decodeGeohash, encodeGeohash, fuzzEpoch, obfuscatedPoint, type LatLon } from "./obfuscate";

async function fuzzOptions() {
	const [min, max, fallback, rotateHours] = await Promise.all([
		getServerSetting<number>("map.fuzzRadius.min"),
		getServerSetting<number>("map.fuzzRadius.max"),
		getServerSetting<number>("map.fuzzRadius.default"),
		getServerSetting<number>("map.fuzz.rotateHours"),
	]);
	return { min: min ?? 50, max: max ?? 1500, fallback: fallback ?? 300, rotateHours: rotateHours ?? 168 };
}

/**
 * Stores the real position and its obfuscated public twin in one write.
 * Called by PUT /v4/location, every non-favorites cascade (upstream moves the
 * profile to `nearbyGeoHash`) and sign-in with a geohash.
 */
export async function updateLocation(userId: bigint, real: LatLon): Promise<void> {
	const opts = await fuzzOptions();
	const [row] = await db
		.select({ seed: users.locationSeed, radius: profiles.mapFuzzRadius })
		.from(users)
		.leftJoin(profiles, eq(profiles.userId, users.id))
		.where(eq(users.id, userId))
		.limit(1);
	if (!row) return;
	const radius = clampRadius(row.radius, opts);
	const epoch = fuzzEpoch(Date.now(), opts.rotateHours);
	const { point, cell } = obfuscatedPoint(real, row.seed, radius, epoch);
	const geohash = encodeGeohash(real, 12);
	const values = {
		location: real,
		publicLocation: point,
		geohash,
		fuzzCell: `${cell}|${epoch}|${radius}`,
		fuzzRolledAt: new Date(),
		locationUpdatedAt: new Date(),
		updatedAt: new Date(),
	};
	await db
		.insert(profiles)
		.values({ userId, ...values })
		.onConflictDoUpdate({ target: profiles.userId, set: values });
	await recomputeVisiting(userId);
}

export async function updateLocationFromGeohash(userId: bigint, geohash: string): Promise<void> {
	await updateLocation(userId, decodeGeohash(geohash));
}

/** Re-derives the public point after the user changed their fuzz radius. */
export async function refreshPublicLocation(userId: bigint): Promise<void> {
	const [row] = await db
		.select({ lat: sql<number>`ST_Y(${profiles.location}::geometry)`, lon: sql<number>`ST_X(${profiles.location}::geometry)` })
		.from(profiles)
		.where(eq(profiles.userId, userId))
		.limit(1);
	if (row?.lat != null && row.lon != null) await updateLocation(userId, { lat: row.lat, lon: row.lon });
}

/**
 * Marks the user online for 600 s (upstream: every cascade fetch). Incognito
 * users are never marked online and their "last seen" stays where it was, so
 * every endpoint shows them offline without filtering on its own. Incognito
 * ends by itself once the account loses the `incognito` entitlement.
 */
export async function touchOnline(userId: bigint): Promise<void> {
	const [row] = (await db.execute(sql`
		WITH old AS (SELECT online_until, incognito FROM profiles WHERE user_id = ${userId})
		UPDATE profiles SET
			online_until = CASE WHEN incognito THEN NULL ELSE now() + interval '600 seconds' END,
			last_seen_at = CASE WHEN incognito THEN last_seen_at ELSE now() END
		WHERE user_id = ${userId}
		RETURNING (SELECT online_until FROM old) AS was_until, (SELECT incognito FROM old) AS incognito`)) as unknown as { was_until: Date | string | null; incognito: boolean }[];
	if (!row) return;
	if (row.incognito) {
		if (!(await isFeatureEnabled(userId, "incognito"))) {
			await setIncognito(userId, false);
			await touchOnline(userId);
		}
		return;
	}
	const wasOnline = row.was_until != null && new Date(row.was_until).getTime() > Date.now();
	// Just came online: favorites/taps/media "is online" pushes (worker decides who).
	// The 30 min guard keeps a flapping session from re-triggering.
	if (!wasOnline && (await redis.set(`online:came:${userId}`, "1", "EX", 1800, "NX")) === "OK") {
		await notifyQueue.add("came_online", { kind: "came_online", userId: String(userId) }).catch(() => undefined);
	}
}

/**
 * Switches incognito. On: offline at once (online_until cleared), so nobody
 * keeps seeing the green dot until it times out. Off: online again right away.
 */
export async function setIncognito(userId: bigint, on: boolean): Promise<void> {
	await db.execute(sql`
		UPDATE profiles SET incognito = ${on}${on ? sql`, online_until = NULL` : sql``}
		WHERE user_id = ${userId}`);
	await invalidateProfileCard(userId);
	if (!on) await touchOnline(userId);
}
