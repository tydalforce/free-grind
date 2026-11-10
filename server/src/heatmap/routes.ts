import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { redis } from "../cache/redis";
import { db } from "../db/client";
import { errors } from "../lib/errors";

/**
 * Explore heatmap (/v1/explore_heatmaps). Aggregates only public (obfuscated)
 * positions of recently active profiles into a grid; cells with fewer than
 * MIN_PER_CELL profiles are left out so nobody shows up alone. Results are
 * cached briefly per rounded area.
 */
const GRID = 12;
const MIN_PER_CELL = 3;
const ACTIVE_WINDOW = "2 hours";
const CACHE_TTL_S = 60;

const bodySchema = z.object({
	coordinates: z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) }),
	searchSquareSide: z.number().positive().max(5).optional(),
	includeHeatmaps: z.boolean().optional(),
});

export async function heatmapRoutes(app: FastifyInstance): Promise<void> {
	const auth = { preHandler: app.authenticate };

	// Curated cities/neighbourhoods are not maintained on our server (yet).
	app.get("/v1/explore_heatmaps/all_locations", auth, async () => ({ locations: [] }));

	app.post("/v1/explore_heatmaps", auth, async (req) => {
		const b = bodySchema.safeParse(req.body);
		if (!b.success) throw errors.badRequest("Invalid request");
		if (b.data.includeHeatmaps === false) return { locations: [], heatmaps: [] };
		const side = b.data.searchSquareSide ?? 0.25;
		const cell = side / GRID;
		// Snap the square to the grid so nearby requests share a cache entry.
		const minLat = Math.floor((b.data.coordinates.lat - side / 2) / cell) * cell;
		const minLng = Math.floor((b.data.coordinates.lng - side / 2) / cell) * cell;
		const key = `heatmap:${side}:${minLat.toFixed(5)}:${minLng.toFixed(5)}`;
		const cached = await redis.get(key);
		if (cached) return JSON.parse(cached);

		const rows = (await db.execute(sql`
			SELECT floor((ST_Y(public_location::geometry) - ${minLat}) / ${cell})::int AS gy,
			       floor((ST_X(public_location::geometry) - ${minLng}) / ${cell})::int AS gx,
			       count(*)::int AS n
			FROM profiles
			WHERE public_location IS NOT NULL AND incognito = false AND last_seen_at > now() - ${ACTIVE_WINDOW}::interval
			  AND public_location && ST_MakeEnvelope(${minLng}, ${minLat}, ${minLng + side + cell}, ${minLat + side + cell}, 4326)::geography
			GROUP BY 1, 2
			HAVING count(*) >= ${MIN_PER_CELL}`)) as unknown as { gy: number; gx: number; n: number }[];
		const max = Math.max(1, ...rows.map((r) => r.n));
		const heatmaps = rows.map((r) => ({
			heatmapId: r.gy * 1000 + r.gx,
			coordinates: { lat: minLat + (r.gy + 0.5) * cell, lng: minLng + (r.gx + 0.5) * cell },
			intensity: Math.max(1, Math.ceil((r.n / max) * 5)),
		}));
		const result = { locations: [], heatmaps };
		await redis.set(key, JSON.stringify(result), "EX", CACHE_TTL_S);
		return result;
	});
}
