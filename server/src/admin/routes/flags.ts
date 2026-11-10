import { and, asc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { invalidate } from "../../cache/local";
import { db } from "../../db/client";
import { FLAG_TYPES, flagRules, flagUserOverrides, flags } from "../../db/schema";
import { ApiError } from "../../lib/errors";
import { bumpTokenVersion } from "../../modules/auth/sessions";
import { audit } from "../audit";
import { bumpTokenVersionForProfile } from "../tokenRefresh";

const flagKey = z.string().regex(/^[a-zA-Z0-9_.:-]{1,80}$/);

const conditions = z
	.object({
		roles: z.array(z.string()).max(10).optional(),
		userIds: z.array(z.string().regex(/^\d+$/)).max(1000).optional(),
		geohashPrefixes: z.array(z.string().regex(/^[0-9a-z]{1,12}$/)).max(200).optional(),
		platforms: z.array(z.enum(["android", "ios", "other"])).optional(),
		minAppVersion: z.string().regex(/^\d+(\.\d+){0,3}$/).optional(),
		minAccountAgeDays: z.number().int().min(0).max(36500).optional(),
		percentage: z.number().min(0).max(100).optional(),
	})
	.strict();

const rule = z.object({
	conditions,
	value: z.string().max(200).nullable().optional(),
	variants: z.array(z.object({ value: z.string().min(1).max(100), weight: z.number().min(0).max(1_000_000) })).max(20).nullable().optional(),
	payload: z.record(z.string(), z.unknown()).nullable().optional(),
});

/** Payload keys that must never be published through (public) assignments. */
const SECRET_LIKE = /secret|password|private|token|apikey_secret|certificate/i;

function secretLikeKeys(payload: unknown): string[] {
	if (!payload || typeof payload !== "object") return [];
	return Object.keys(payload as object).filter((k) => SECRET_LIKE.test(k));
}

async function afterFlagChange(): Promise<void> {
	await invalidate("flags");
	// featureFlags/experiments are JWT claims; re-issue everyone's sessions so
	// they pick it up on the next request (client refreshes transparently).
	await bumpTokenVersionForProfile("default");
}

export async function adminFlagRoutes(app: FastifyInstance): Promise<void> {
	app.get("/admin/api/flags", { preHandler: app.requireAdmin }, async () => {
		const [rows, rules] = await Promise.all([db.select().from(flags).orderBy(asc(flags.key)), db.select().from(flagRules).orderBy(asc(flagRules.flagKey), asc(flagRules.position))]);
		return { flags: rows.map((f) => ({ ...f, rules: rules.filter((r) => r.flagKey === f.key) })) };
	});

	app.post("/admin/api/flags", { preHandler: app.requireOwner }, async (req) => {
		const body = z.object({ key: flagKey, type: z.enum(FLAG_TYPES), defaultValue: z.string().max(200), description: z.string().max(500).optional(), isPublic: z.boolean().default(false), payload: z.record(z.string(), z.unknown()).nullable().optional() }).parse(req.body);
		if (body.isPublic && secretLikeKeys(body.payload).length) throw new ApiError(400, { error: "secret_in_public_payload", keys: secretLikeKeys(body.payload) });
		const inserted = await db.insert(flags).values({ ...body, payload: body.payload ?? null }).onConflictDoNothing().returning();
		if (!inserted.length) throw new ApiError(409, { error: "exists" });
		await afterFlagChange();
		await audit(req.admin, "flag.create", body.key, null, body);
		return inserted[0];
	});

	app.put("/admin/api/flags/:key", { preHandler: app.requireOwner }, async (req) => {
		const key = flagKey.parse((req.params as { key: string }).key);
		const body = z.object({ defaultValue: z.string().max(200).optional(), description: z.string().max(500).nullable().optional(), enabled: z.boolean().optional(), isPublic: z.boolean().optional(), payload: z.record(z.string(), z.unknown()).nullable().optional() }).parse(req.body);
		const [before] = await db.select().from(flags).where(eq(flags.key, key)).limit(1);
		if (!before) throw new ApiError(404, { error: "not_found" });
		if (before.locked) throw new ApiError(409, { error: "locked" });
		const isPublic = body.isPublic ?? before.isPublic;
		const payload = body.payload === undefined ? before.payload : body.payload;
		if (isPublic && secretLikeKeys(payload).length) throw new ApiError(400, { error: "secret_in_public_payload", keys: secretLikeKeys(payload) });
		await db.update(flags).set({ ...body, updatedAt: new Date() }).where(eq(flags.key, key));
		await afterFlagChange();
		await audit(req.admin, "flag.update", key, before, body);
		return { ok: true };
	});

	/** Replaces the ordered rule list of a flag. */
	app.put("/admin/api/flags/:key/rules", { preHandler: app.requireOwner }, async (req) => {
		const key = flagKey.parse((req.params as { key: string }).key);
		const body = z.object({ rules: z.array(rule).max(50) }).parse(req.body);
		const [flag] = await db.select().from(flags).where(eq(flags.key, key)).limit(1);
		if (!flag) throw new ApiError(404, { error: "not_found" });
		if (flag.locked) throw new ApiError(409, { error: "locked" });
		const before = await db.select().from(flagRules).where(eq(flagRules.flagKey, key));
		await db.transaction(async (tx) => {
			await tx.delete(flagRules).where(eq(flagRules.flagKey, key));
			if (body.rules.length) {
				await tx.insert(flagRules).values(
					body.rules.map((r, position) => ({ flagKey: key, position, conditions: r.conditions, value: r.value ?? null, variants: r.variants ?? null, payload: r.payload ?? null })),
				);
			}
		});
		await afterFlagChange();
		await audit(req.admin, "flag.rules.set", key, before, body.rules);
		return { ok: true };
	});

	app.put("/admin/api/flags/:key/users/:id", { preHandler: app.requireOwner }, async (req) => {
		const { key, id } = z.object({ key: flagKey, id: z.string().regex(/^\d+$/) }).parse(req.params);
		const body = z.object({ value: z.string().max(200).nullable(), payload: z.record(z.string(), z.unknown()).nullable().optional() }).parse(req.body);
		const userId = BigInt(id);
		if (body.value === null) {
			await db.delete(flagUserOverrides).where(and(eq(flagUserOverrides.userId, userId), eq(flagUserOverrides.flagKey, key)));
		} else {
			await db
				.insert(flagUserOverrides)
				.values({ userId, flagKey: key, value: body.value, payload: body.payload ?? null })
				.onConflictDoUpdate({ target: [flagUserOverrides.userId, flagUserOverrides.flagKey], set: { value: body.value, payload: body.payload ?? null } });
		}
		await bumpTokenVersion(userId);
		await audit(req.admin, "flag.user_override", `${key}:user:${id}`, null, body);
		return { ok: true };
	});
}
