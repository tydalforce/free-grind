import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { redis } from "../../cache/redis";
import { rawSql } from "../../db/client";
import { getActiveRoles } from "../../entitlements/resolve";
import { evaluateFlags } from "../../flags/engine";
import { extractBearer, authenticateRequest } from "../../plugins/auth";
import { publicJwks } from "../../lib/jwt";
import { db } from "../../db/client";
import { users } from "../../db/schema";
import { eq } from "drizzle-orm";

const geohashQuery = z.object({ geohash: z.string().regex(/^[0-9a-z]{1,12}$/).optional() });

async function publicAssignments(req: FastifyRequest) {
	const assignments = await evaluateFlags(
		{ userId: null, roles: [], geohash: null, platform: req.client.ua.platform, appVersion: req.client.ua.appVersion, accountCreatedAt: null },
		{ publicOnly: true },
	);
	return { assignments: assignments.map(({ key, value, payload, type }) => ({ key, value, payload: payload ?? {}, type })) };
}

export async function systemRoutes(app: FastifyInstance): Promise<void> {
	app.get("/healthz", { config: { clientHeaders: "none" } }, async () => {
		await Promise.all([rawSql`select 1`, redis.ping()]);
		return { ok: true };
	});

	app.get("/.well-known/jwks.json", { config: { clientHeaders: "none" } }, async (_req, reply) => {
		reply.header("cache-control", "public, max-age=300");
		return publicJwks();
	});

	app.get("/public/v1/assignments", publicAssignments);
	app.get("/public/v1/public-features", publicAssignments);

	app.get("/v3/assignment", { preHandler: app.authenticate, config: { allowRestricted: true } }, async (req) => {
		const { geohash } = geohashQuery.parse(req.query);
		const [user] = await db.select({ createdAt: users.createdAt }).from(users).where(eq(users.id, req.auth.userId)).limit(1);
		const roles = await getActiveRoles(req.auth.userId);
		const assignments = await evaluateFlags({
			userId: req.auth.profileId,
			roles: roles.length ? roles : ["free"],
			geohash: geohash ?? null,
			platform: req.client.ua.platform,
			appVersion: req.client.ua.appVersion,
			accountCreatedAt: user?.createdAt ?? null,
		});
		return { assignments: assignments.map(({ key, value, payload, type }) => ({ key, value, payload: payload ?? {}, type })) };
	});

	/**
	 * Upstream returns an empty body when `Accept: application/json` is sent
	 * (security-headers.md), so we answer 204 then; otherwise a small object.
	 * Auth is optional here.
	 */
	app.get("/v3/bootstrap", async (req, reply) => {
		const token = extractBearer(req.headers.authorization);
		if (token) await authenticateRequest(req, token).catch(() => undefined);
		if ((req.headers.accept ?? "").includes("application/json")) return reply.code(204).send();
		return { serverTime: Date.now() };
	});
}
