import type { FastifyInstance } from "fastify";
import { entitlementStatus } from "../../entitlements/enforce";

/**
 * Our extension (not upstream): every entitlement with limit, usage and reset
 * time, so the app can show "limit reached – resets at …" instead of a
 * paywall, and future features can read their limits.
 */
export async function entitlementRoutes(app: FastifyInstance): Promise<void> {
	app.get("/v1/me/entitlements", { preHandler: app.authenticate }, async (req) => {
		const status = await entitlementStatus(req.auth.userId);
		return {
			entitlements: status.map(({ source: _s, ...rest }) => ({
				...rest,
				// JSON has no Infinity.
				limit: rest.limit,
				remaining: rest.remaining != null && Number.isFinite(rest.remaining) ? rest.remaining : null,
			})),
		};
	});
}
