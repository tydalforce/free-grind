import { eq, sql } from "drizzle-orm";
import { db } from "../db/client";
import { profiles } from "../db/schema";
import { getServerSetting } from "../modules/settings/settings";
import { invalidateProfileCard } from "../profiles/cards";
import { haversineMeters, type LatLon } from "./obfuscate";

/**
 * Visiting status (/v1/visiting/settings, shown as `isVisiting`). Stored in
 * profiles.is_visiting and recomputed whenever location, mode or home change,
 * so every endpoint just reads the flag. Only the yes/no ever leaves the
 * server, never the home or the distance to it.
 *
 *  - ON:   always visiting
 *  - OFF:  never visiting
 *  - AUTO: visiting while farther than `visiting.autoDistanceKm` from home.
 *          Without a home set by the user, the server learns one: the first
 *          known location, moved to wherever the user has stayed for
 *          `visiting.relocateDays` (they've moved, not travelled). A home the
 *          user set is never moved.
 */

type Row = {
	mode: "AUTO" | "OFF" | "ON";
	home: LatLon | null;
	homeAuto: boolean;
	awayAnchor: LatLon | null;
	awaySince: Date | null;
	location: LatLon | null;
	isVisiting: boolean;
};

async function settings() {
	const [km, days] = await Promise.all([getServerSetting<number>("visiting.autoDistanceKm"), getServerSetting<number>("visiting.relocateDays")]);
	return { radiusM: (km ?? 50) * 1000, relocateMs: (days ?? 30) * 86_400_000 };
}

const point = (lat: unknown, lon: unknown): LatLon | null => (lat == null || lon == null ? null : { lat: Number(lat), lon: Number(lon) });

async function load(userId: bigint): Promise<Row | null> {
	const [r] = (await db.execute(sql`
		SELECT visiting_mode AS mode, home_auto, away_since, is_visiting,
		       ST_Y(home_location::geometry) AS home_lat, ST_X(home_location::geometry) AS home_lon,
		       ST_Y(away_anchor::geometry) AS away_lat, ST_X(away_anchor::geometry) AS away_lon,
		       ST_Y(location::geometry) AS lat, ST_X(location::geometry) AS lon
		FROM profiles WHERE user_id = ${userId}`)) as unknown as Record<string, unknown>[];
	if (!r) return null;
	return {
		mode: r.mode as Row["mode"],
		home: point(r.home_lat, r.home_lon),
		homeAuto: !!r.home_auto,
		awayAnchor: point(r.away_lat, r.away_lon),
		awaySince: r.away_since ? new Date(r.away_since as string) : null,
		location: point(r.lat, r.lon),
		isVisiting: !!r.is_visiting,
	};
}

/** Pure decision for one state (exported for tests). */
export function decide(row: Row, now: number, cfg: { radiusM: number; relocateMs: number }) {
	let { home, homeAuto, awayAnchor, awaySince } = row;
	const here = row.location;
	if (here) {
		if (!home) {
			home = here;
			homeAuto = true;
		}
		if (haversineMeters(here, home) <= cfg.radiusM) {
			awayAnchor = null;
			awaySince = null;
		} else if (!awayAnchor || !awaySince || haversineMeters(here, awayAnchor) > cfg.radiusM) {
			// Arrived somewhere new: start counting the stay here.
			awayAnchor = here;
			awaySince = new Date(now);
		} else if (homeAuto && now - awaySince.getTime() >= cfg.relocateMs) {
			// Stayed long enough: this is home now.
			home = here;
			awayAnchor = null;
			awaySince = null;
		}
	}
	const far = !!(here && home && haversineMeters(here, home) > cfg.radiusM);
	const isVisiting = row.mode === "ON" || (row.mode === "AUTO" && far);
	return { home, homeAuto, awayAnchor, awaySince, isVisiting };
}

/** Recomputes and stores the status (and the learned home). */
export async function recomputeVisiting(userId: bigint): Promise<void> {
	const row = await load(userId);
	if (!row) return;
	const next = decide(row, Date.now(), await settings());
	await db
		.update(profiles)
		.set({ homeLocation: next.home, homeAuto: next.homeAuto, awayAnchor: next.awayAnchor, awaySince: next.awaySince, isVisiting: next.isVisiting })
		.where(eq(profiles.userId, userId));
	if (next.isVisiting !== row.isVisiting) await invalidateProfileCard(userId);
}

/** PUT /v1/visiting/home: a home the user chose; never moved automatically. */
export async function setHome(userId: bigint, home: LatLon): Promise<void> {
	await db
		.insert(profiles)
		.values({ userId, homeLocation: home, homeAuto: false, awayAnchor: null, awaySince: null })
		.onConflictDoUpdate({ target: profiles.userId, set: { homeLocation: home, homeAuto: false, awayAnchor: null, awaySince: null, updatedAt: new Date() } });
	await recomputeVisiting(userId);
}
