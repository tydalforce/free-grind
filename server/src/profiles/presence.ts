import { sql } from "drizzle-orm";
import { db } from "../db/client";
import { displayedDistance } from "../geo/obfuscate";
import { getServerSetting } from "../modules/settings/settings";

/**
 * Viewer-dependent bits of other profiles in one query: online state, public
 * distance (rounded, from the obfuscated positions) and Right Now status.
 */
export type Presence = {
	onlineUntil: number | null;
	lastSeen: number | null;
	/** Rounded meters, or null when the profile hides its distance / has no position. */
	distance: number | null;
	sexualPosition: number | null;
	/** RightNowStatus of a public (non-discreet) active post. */
	rightNow: "HOSTING" | "NOT_HOSTING" | "NOT_ACTIVE";
};

export async function presenceOf(viewer: bigint, ids: (bigint | string)[]): Promise<Map<string, Presence>> {
	const unique = [...new Set(ids.map(String))];
	if (!unique.length) return new Map();
	const round = (await getServerSetting<number>("distance.roundMeters")) ?? 100;
	const rows = (await db.execute(sql`
		SELECT p.user_id::text AS id,
		       (extract(epoch FROM p.online_until) * 1000)::bigint AS online_until,
		       (extract(epoch FROM p.last_seen_at) * 1000)::bigint AS last_seen,
		       CASE WHEN p.show_distance THEN ST_Distance(p.public_location, me.public_location) END AS distance,
		       p.approximate_distance AS approx,
		       CASE WHEN p.show_position THEN p.sexual_position END AS position,
		       rn.hosting AS rn_hosting
		FROM profiles p
		LEFT JOIN profiles me ON me.user_id = ${viewer}
		LEFT JOIN LATERAL (
			SELECT r.hosting FROM rightnow_posts r
			WHERE r.author_id = p.user_id AND r.status = 'ACTIVE' AND r.is_discreet <> 'TRUE' AND r.expiration > now()
			LIMIT 1
		) rn ON true
		WHERE p.user_id = ANY(${`{${unique.join(",")}}`}::bigint[])`)) as unknown as {
		id: string;
		online_until: string | null;
		last_seen: string | null;
		distance: number | null;
		approx: boolean;
		position: number | null;
		rn_hosting: boolean | null;
	}[];
	return new Map(
		rows.map((r) => [
			r.id,
			{
				onlineUntil: r.online_until == null ? null : Number(r.online_until),
				lastSeen: r.last_seen == null ? null : Number(r.last_seen),
				distance: r.distance == null ? null : displayedDistance(Number(r.distance), { roundMeters: round, approximate: r.approx }),
				sexualPosition: r.position,
				rightNow: r.rn_hosting == null ? "NOT_ACTIVE" : r.rn_hosting ? "HOSTING" : "NOT_HOSTING",
			},
		]),
	);
}
