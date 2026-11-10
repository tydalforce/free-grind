import { and, desc, eq, gt, isNull, lt, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { db, dbRead } from "../../db/client";
import { authTokens, devices, securityEvents, users } from "../../db/schema";
import { ApiError } from "../../lib/errors";
import { rotateJwtKey } from "../../lib/jwt";
import { rotateMediaSigningKey } from "../../lib/mediaUrls";
import { bumpTokenVersion } from "../../modules/auth/sessions";
import { audit } from "../audit";

const KINDS = ["header_rejected", "device_mismatch", "token_reuse", "signature_rejected", "rate_limited", "login_failed"] as const;

/** Admin "Sicherheit": security events, device/session revocation, key rotation. */
export async function adminSecurityRoutes(app: FastifyInstance): Promise<void> {
	app.get("/admin/api/security/events", { preHandler: app.requireAdmin }, async (req) => {
		const q = z
			.object({
				kind: z.enum(KINDS).optional(),
				userId: z.string().regex(/^\d{1,19}$/).optional(),
				ip: z.string().max(64).optional(),
				before: z.string().regex(/^\d+$/).optional(),
				limit: z.coerce.number().int().min(1).max(200).default(100),
			})
			.parse(req.query);
		const conds = [];
		if (q.kind) conds.push(eq(securityEvents.kind, q.kind));
		if (q.userId) conds.push(eq(securityEvents.userId, BigInt(q.userId)));
		if (q.ip) conds.push(eq(securityEvents.ip, q.ip));
		if (q.before) conds.push(lt(securityEvents.id, BigInt(q.before)));
		const rows = await dbRead
			.select()
			.from(securityEvents)
			.where(conds.length ? and(...conds) : undefined)
			.orderBy(desc(securityEvents.id))
			.limit(q.limit);
		return {
			events: rows.map((r) => ({ ...r, id: String(r.id), userId: r.userId != null ? String(r.userId) : null })),
			next: rows.length === q.limit ? String(rows[rows.length - 1]!.id) : null,
		};
	});

	/** Counts per kind over the last 24 h (the partition index keeps this cheap). */
	app.get("/admin/api/security/summary", { preHandler: app.requireAdmin }, async () => {
		const rows = await dbRead
			.select({ kind: securityEvents.kind, n: sql<number>`count(*)::int` })
			.from(securityEvents)
			.where(gt(securityEvents.createdAt, new Date(Date.now() - 86_400_000)))
			.groupBy(securityEvents.kind);
		return { last24h: Object.fromEntries(KINDS.map((k) => [k, rows.find((r) => r.kind === k)?.n ?? 0])) };
	});

	/** Signs one device out: its refresh tokens die and the current session token is invalidated. */
	app.post("/admin/api/users/:id/devices/:deviceId/revoke", { preHandler: app.requireAdmin }, async (req) => {
		const { id, deviceId } = z.object({ id: z.string().regex(/^\d{1,19}$/), deviceId: z.string().max(64) }).parse(req.params);
		const userId = BigInt(id);
		const now = new Date();
		const updated = await db.update(devices).set({ revokedAt: now, fcmToken: null }).where(and(eq(devices.userId, userId), eq(devices.deviceId, deviceId))).returning({ d: devices.deviceId });
		if (!updated.length) throw new ApiError(404, { error: "not_found" });
		await db.update(authTokens).set({ revokedAt: now }).where(and(eq(authTokens.userId, userId), eq(authTokens.deviceId, deviceId), isNull(authTokens.revokedAt)));
		await bumpTokenVersion(userId);
		await audit(req.admin, "user.device.revoke", `user:${id}`, null, { deviceId });
		return { ok: true };
	});

	/** Signs the account out everywhere. */
	app.post("/admin/api/users/:id/sessions/revoke-all", { preHandler: app.requireAdmin }, async (req) => {
		const { id } = z.object({ id: z.string().regex(/^\d{1,19}$/) }).parse(req.params);
		const userId = BigInt(id);
		const [exists] = await db.select({ id: users.id }).from(users).where(eq(users.id, userId)).limit(1);
		if (!exists) throw new ApiError(404, { error: "not_found" });
		const now = new Date();
		await db.update(authTokens).set({ revokedAt: now }).where(and(eq(authTokens.userId, userId), isNull(authTokens.revokedAt)));
		await db.update(devices).set({ revokedAt: now, fcmToken: null }).where(and(eq(devices.userId, userId), isNull(devices.revokedAt)));
		await bumpTokenVersion(userId);
		await audit(req.admin, "user.sessions.revoke_all", `user:${id}`, null, null);
		return { ok: true };
	});

	/**
	 * New signing keys. JWT: the previous key keeps verifying until its tokens
	 * expire, so nobody is signed out. Media: URLs signed with the previous key
	 * stay valid until they expire.
	 */
	app.post("/admin/api/security/rotate/:what", { preHandler: app.requireOwner }, async (req) => {
		const { what } = z.object({ what: z.enum(["jwt", "media"]) }).parse(req.params);
		const kid = what === "jwt" ? await rotateJwtKey() : (await rotateMediaSigningKey()).active;
		await audit(req.admin, `security.rotate.${what}`, null, null, { kid });
		return { kid };
	});
}
