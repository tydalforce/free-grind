import { and, desc, eq, ilike, isNull, lt, or, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { invalidate } from "../../cache/local";
import { db, dbRead } from "../../db/client";
import { ROLES, devices, entitlementUserOverrides, profiles, userRoles, users } from "../../db/schema";
import { entitlementStatus } from "../../entitlements/enforce";
import { resetQuota } from "../../entitlements/quota";
import { ENTITLEMENTS } from "../../entitlements/registry";
import { validateEntitlementValue } from "../../entitlements/validate";
import { ApiError } from "../../lib/errors";
import { buildClaims, bumpTokenVersion } from "../../modules/auth/sessions";
import { audit } from "../audit";
import { BAN_REASONS, BAN_SUB_REASONS, userWarnings } from "../../db/schema";
import { banHistory, banUser, currentBan, liftBan } from "../../moderation/bans";
import { banDevices, deviceBansOfUser, devicesOfUser } from "../../moderation/accessBans";
import { getServerSetting } from "../../modules/settings/settings";

const idParam = z.object({ id: z.string().regex(/^\d{1,19}$/) });

function userId(params: unknown): bigint {
	return BigInt(idParam.parse(params).id);
}

async function afterUserEntitlementChange(id: bigint, key?: string): Promise<void> {
	await invalidate("entitlement-user", String(id));
	// Roles and feature-backed booleans are JWT claims → re-issue now.
	if (!key || ENTITLEMENTS.get(key)?.feature) await bumpTokenVersion(id);
}

export async function adminUserRoutes(app: FastifyInstance): Promise<void> {
	/** Keyset-paginated search by id / email / display name. */
	app.get("/admin/api/users", { preHandler: app.requireAdmin }, async (req) => {
		const q = z.object({ q: z.string().max(100).optional(), before: z.string().regex(/^\d+$/).optional(), limit: z.coerce.number().int().min(1).max(100).default(50) }).parse(req.query);
		const conds = [isNull(users.deletedAt)];
		if (q.before) conds.push(lt(users.id, BigInt(q.before)));
		if (q.q) {
			const term = q.q.trim();
			conds.push(
				/^\d+$/.test(term)
					? eq(users.id, BigInt(term))
					: (or(ilike(users.email, `%${term}%`), ilike(profiles.displayName, `%${term}%`)) as ReturnType<typeof eq>),
			);
		}
		const rows = await dbRead
			.select({
				id: users.id,
				email: users.email,
				displayName: profiles.displayName,
				createdAt: users.createdAt,
				lastSeenAt: profiles.lastSeenAt,
				// Computed in SQL: 'infinity' (permanent / agreement pending) would serialize as null.
				banned: sql<boolean>`(${users.bannedUntil} IS NOT NULL AND ${users.bannedUntil} > now())`,
				roles: sql<string[]>`coalesce((SELECT array_agg(r.role) FROM user_roles r WHERE r.user_id = ${users.id} AND (r.expires_at IS NULL OR r.expires_at > now())), '{}')`,
			})
			.from(users)
			.leftJoin(profiles, eq(profiles.userId, users.id))
			.where(and(...conds))
			.orderBy(desc(users.id))
			.limit(q.limit);
		return { users: rows, next: rows.length === q.limit ? String(rows[rows.length - 1]!.id) : null };
	});

	app.get("/admin/api/users/:id", { preHandler: app.requireAdmin }, async (req) => {
		const id = userId(req.params);
		const [user] = await db.select().from(users).where(eq(users.id, id)).limit(1);
		if (!user) throw new ApiError(404, { error: "not_found" });
		const [profile] = await db.select({ displayName: profiles.displayName, geohash: profiles.geohash, lastSeenAt: profiles.lastSeenAt }).from(profiles).where(eq(profiles.userId, id)).limit(1);
		const [roles, overrides, deviceRows, status] = await Promise.all([
			db.select().from(userRoles).where(eq(userRoles.userId, id)),
			db.select().from(entitlementUserOverrides).where(eq(entitlementUserOverrides.userId, id)),
			db.select({ deviceId: devices.deviceId, userAgent: devices.userAgent, lastSeenAt: devices.lastSeenAt, revokedAt: devices.revokedAt, hasPush: sql<boolean>`${devices.fcmToken} IS NOT NULL` }).from(devices).where(eq(devices.userId, id)),
			entitlementStatus(id),
		]);
		const { passwordHash: _p, locationSeed: _s, ...safeUser } = user;
		const [banState, banList, deviceBans, warnings] = await Promise.all([
			currentBan(id),
			banHistory(id),
			deviceBansOfUser(id),
			db.select().from(userWarnings).where(eq(userWarnings.userId, id)).orderBy(desc(userWarnings.createdAt)).limit(50),
		]);
		return {
			user: safeUser,
			profile: profile ?? null,
			roles,
			overrides,
			devices: deviceRows,
			entitlements: status,
			ban: banState ? { state: banState.kind, ...banState.ban } : null,
			bans: banList,
			deviceBans: deviceBans.map((d) => ({ ...d, id: String(d.id) })),
			warnings,
		};
	});

	/** Preview of the JWT claims this user would get on the next refresh. */
	app.get("/admin/api/users/:id/claims", { preHandler: app.requireAdmin }, async (req) => {
		const id = userId(req.params);
		const [user] = await db.select().from(users).where(eq(users.id, id)).limit(1);
		if (!user) throw new ApiError(404, { error: "not_found" });
		const [profile] = await db.select({ geohash: profiles.geohash }).from(profiles).where(eq(profiles.userId, id)).limit(1);
		const fakeClient = {
			ua: { appVersion: "0", buildNumber: "0", tier: "Free", os: "Android", deviceModel: "-", manufacturer: "-", platform: "android" as const },
			device: { deviceId: "0000000000000000", deviceType: 2 as const, totalRam: 0, screenResolution: "0x0", advertisingId: "00000000-0000-0000-0000-000000000000" },
			locale: { language: "en", region: "US", tag: "en_US" },
			timeZone: "UTC",
			rolesHeader: null,
		};
		const { did: _d, ...claims } = await buildClaims(user, fakeClient, profile?.geohash ?? null);
		return { claims };
	});

	app.post("/admin/api/users/:id/roles", { preHandler: app.requireOwner }, async (req) => {
		const id = userId(req.params);
		const body = z.object({ role: z.enum(ROLES), expiresAt: z.string().datetime().nullable().optional() }).parse(req.body);
		const expiresAt = body.expiresAt ? new Date(body.expiresAt) : null;
		await db
			.insert(userRoles)
			.values({ userId: id, role: body.role, grantedBy: req.admin.username, expiresAt })
			.onConflictDoUpdate({ target: [userRoles.userId, userRoles.role], set: { expiresAt, grantedBy: req.admin.username, grantedAt: new Date() } });
		await afterUserEntitlementChange(id);
		await audit(req.admin, "user.role.grant", `user:${id}`, null, body);
		return { ok: true };
	});

	app.delete("/admin/api/users/:id/roles/:role", { preHandler: app.requireOwner }, async (req) => {
		const id = userId(req.params);
		const role = z.enum(ROLES).parse((req.params as { role: string }).role);
		await db.delete(userRoles).where(and(eq(userRoles.userId, id), eq(userRoles.role, role)));
		await afterUserEntitlementChange(id);
		await audit(req.admin, "user.role.revoke", `user:${id}`, { role }, null);
		return { ok: true };
	});

	/** Override one entitlement for one user (value null → remove override). */
	app.put("/admin/api/users/:id/entitlements/:key", { preHandler: app.requireOwner }, async (req) => {
		const id = userId(req.params);
		const { key } = req.params as { key: string };
		const body = z.object({ value: z.unknown(), expiresAt: z.string().datetime().nullable().optional() }).parse(req.body);
		const [before] = await db.select().from(entitlementUserOverrides).where(and(eq(entitlementUserOverrides.userId, id), eq(entitlementUserOverrides.key, key))).limit(1);
		if (body.value === null || body.value === undefined) {
			await db.delete(entitlementUserOverrides).where(and(eq(entitlementUserOverrides.userId, id), eq(entitlementUserOverrides.key, key)));
		} else {
			const v = validateEntitlementValue(key, body.value);
			if (!v.ok) throw new ApiError(400, { error: "invalid_value", detail: v.error });
			const expiresAt = body.expiresAt ? new Date(body.expiresAt) : null;
			await db
				.insert(entitlementUserOverrides)
				.values({ userId: id, key, value: v.value, expiresAt, updatedBy: req.admin.username })
				.onConflictDoUpdate({
					target: [entitlementUserOverrides.userId, entitlementUserOverrides.key],
					set: { value: v.value, expiresAt, updatedBy: req.admin.username, updatedAt: new Date() },
				});
		}
		await afterUserEntitlementChange(id, key);
		await audit(req.admin, "user.entitlement.override", `user:${id}:${key}`, before?.value ?? null, body.value ?? null);
		return { ok: true };
	});

	app.post("/admin/api/users/:id/entitlements/:key/reset", { preHandler: app.requireOwner }, async (req) => {
		const id = userId(req.params);
		const { key } = req.params as { key: string };
		if (!ENTITLEMENTS.has(key)) throw new ApiError(404, { error: "unknown_entitlement" });
		await resetQuota(String(id), key);
		await audit(req.admin, "user.entitlement.reset_usage", `user:${id}:${key}`, null, null);
		return { ok: true };
	});

	/** Bulk override for several users (selection). */
	app.post("/admin/api/users/bulk/entitlements/:key", { preHandler: app.requireOwner }, async (req) => {
		const { key } = req.params as { key: string };
		const body = z.object({ userIds: z.array(z.string().regex(/^\d+$/)).min(1).max(1000), value: z.unknown(), expiresAt: z.string().datetime().nullable().optional() }).parse(req.body);
		const v = validateEntitlementValue(key, body.value);
		if (!v.ok) throw new ApiError(400, { error: "invalid_value", detail: v.error });
		const expiresAt = body.expiresAt ? new Date(body.expiresAt) : null;
		const ids = body.userIds.map((x) => BigInt(x));
		await db
			.insert(entitlementUserOverrides)
			.values(ids.map((userId) => ({ userId, key, value: v.value, expiresAt, updatedBy: req.admin.username })))
			.onConflictDoUpdate({
				target: [entitlementUserOverrides.userId, entitlementUserOverrides.key],
				set: { value: v.value, expiresAt, updatedBy: req.admin.username, updatedAt: new Date() },
			});
		for (const id of ids) await afterUserEntitlementChange(id, key);
		await audit(req.admin, "user.entitlement.bulk_override", key, null, { count: ids.length, value: v.value, expiresAt });
		return { updated: ids.length };
	});

	app.post("/admin/api/users/:id/reissue", { preHandler: app.requireAdmin }, async (req) => {
		const id = userId(req.params);
		await bumpTokenVersion(id);
		await audit(req.admin, "user.sessions.reissue", `user:${id}`, null, null);
		return { ok: true };
	});

	/** Reason / sub-reason lists for the ban dialog (upstream values the client knows). */
	app.get("/admin/api/bans/meta", { preHandler: app.requireAdmin }, async () => ({
		reasons: BAN_REASONS,
		subReasons: BAN_SUB_REASONS,
		requireAgreementDefault: (await getServerSetting<boolean>("bans.requireAgreementDefault")) ?? true,
	}));

	/**
	 * Timed or permanent ban. Timed: `durationHours` or `expiresAt`; with
	 * `requireAgreement` the account stays restricted after the end until the
	 * user reads and accepts the ban agreement in the app.
	 */
	app.post("/admin/api/users/:id/ban", { preHandler: app.requireAdmin }, async (req) => {
		const id = userId(req.params);
		const body = z
			.object({
				type: z.enum(["timed", "permanent"]),
				reason: z.enum(BAN_REASONS).nullable().optional(),
				subReason: z.enum(BAN_SUB_REASONS).nullable().optional(),
				durationHours: z.number().positive().max(24 * 3650).optional(),
				expiresAt: z.string().datetime().optional(),
				requireAgreement: z.boolean().optional(),
				note: z.string().max(2000).nullable().optional(),
				/** Also ban every device the account used (sign-in/sign-up there → code 28). */
				banDevices: z.boolean().optional(),
			})
			.safeParse(req.body);
		if (!body.success) throw new ApiError(400, { error: "invalid", detail: body.error.issues[0]?.message });
		const b = body.data;
		const expiresAt = b.type === "timed" ? (b.expiresAt ? new Date(b.expiresAt) : b.durationHours ? new Date(Date.now() + b.durationHours * 3_600_000) : null) : null;
		const requireAgreement = b.requireAgreement ?? ((await getServerSetting<boolean>("bans.requireAgreementDefault")) ?? true);
		const ban = await banUser(id, { type: b.type, reason: b.reason ?? null, subReason: b.subReason ?? null, requireAgreement, expiresAt, note: b.note ?? null, createdBy: req.admin.username });
		const linked = b.banDevices ? await banDevices(await devicesOfUser(id), { userId: id, note: b.note ?? null, createdBy: req.admin.username }) : { devices: 0, accounts: 0 };
		await audit(req.admin, "user.ban", `user:${id}`, null, { ...ban, devicesBanned: linked.devices, linkedAccountsBanned: linked.accounts });
		return { ban, devicesBanned: linked.devices, linkedAccountsBanned: linked.accounts };
	});

	/** Community-guideline warning; the app shows it until the user acknowledges it. */
	app.post("/admin/api/users/:id/warnings", { preHandler: app.requireAdmin }, async (req) => {
		const id = userId(req.params);
		const body = z.object({ warning: z.enum(BAN_SUB_REASONS), note: z.string().max(2000).nullable().optional() }).safeParse(req.body);
		if (!body.success) throw new ApiError(400, { error: "invalid", detail: body.error.issues[0]?.message });
		const [row] = await db.insert(userWarnings).values({ userId: id, warning: body.data.warning, note: body.data.note ?? null, createdBy: req.admin.username }).returning();
		await audit(req.admin, "user.warn", `user:${id}`, null, row);
		return { warning: row };
	});

	app.delete("/admin/api/users/:id/ban", { preHandler: app.requireAdmin }, async (req) => {
		const id = userId(req.params);
		const lifted = await liftBan(id, req.admin.username);
		await audit(req.admin, "user.unban", `user:${id}`, null, { lifted });
		return { ok: true, lifted };
	});
}
