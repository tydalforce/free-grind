import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { invalidate } from "../../cache/local";
import { db } from "../../db/client";
import { ROLES, entitlementProfiles } from "../../db/schema";
import { ENTITLEMENTS, type EntitlementValue } from "../../entitlements/registry";
import { validateEntitlementValue } from "../../entitlements/validate";
import { ApiError } from "../../lib/errors";
import { audit } from "../audit";
import { bumpTokenVersionForProfile } from "../tokenRefresh";

export const ENTITLEMENT_PROFILES = ["default", "free", ...ROLES] as const;
type ProfileName = (typeof ENTITLEMENT_PROFILES)[number];

/**
 * Templates. "unlimited" clears every role/free value so the registry
 * defaults (unlimited) apply. "restricted-free" is an editable example of a
 * limited free tier — not an exact copy of upstream values.
 */
const TEMPLATES: Record<string, Partial<Record<ProfileName, Record<string, EntitlementValue>>>> = {
	unlimited: {},
	"restricted-free": {
		free: {
			"albums.maxCount": { max: 1 },
			"albums.maxItemsPerAlbum": { max: 10 },
			"albums.maxVideosPerAlbum": { max: 0 },
			"albums.expiringShares": false,
			"albums.maxShareableAlbums": { max: 1 },
			"chat.expiringImages.perDay": { windows: [{ count: 1, window: "day" }] },
			"chat.expiringVideos.enabled": false,
			"chat.unsend": false,
			"chat.readReceipts": false,
			"rightnow.posts": { windows: [{ count: 1, window: "week" }] },
			"rightnow.postDuration": { seconds: 3600 },
			"rightnow.discreet": false,
			"videocall.dailySeconds": { windows: [{ count: 300, window: "day" }] },
			"viewedMe.visibleCount": { max: 3 },
			"incognito": false,
			"grid.maxPages": { max: 1 },
		},
	},
};

async function loadMatrix(): Promise<Record<string, Record<string, EntitlementValue>>> {
	const rows = await db.select().from(entitlementProfiles);
	const matrix: Record<string, Record<string, EntitlementValue>> = {};
	for (const r of rows) (matrix[r.profile] ??= {})[r.key] = r.value as EntitlementValue;
	return matrix;
}

function templateChanges(name: string, matrix: Record<string, Record<string, EntitlementValue>>) {
	const tpl = TEMPLATES[name];
	if (!tpl) throw new ApiError(404, { error: "unknown_template" });
	const changes: { profile: ProfileName; key: string; before: EntitlementValue | null; after: EntitlementValue | null }[] = [];
	for (const profile of ENTITLEMENT_PROFILES) {
		if (profile === "default") continue;
		const target = tpl[profile] ?? {};
		const current = matrix[profile] ?? {};
		for (const key of new Set([...Object.keys(current), ...Object.keys(target)])) {
			const before = current[key] ?? null;
			const after = target[key] ?? null;
			if (JSON.stringify(before) !== JSON.stringify(after)) changes.push({ profile, key, before, after });
		}
	}
	return changes;
}

export async function adminEntitlementRoutes(app: FastifyInstance): Promise<void> {
	app.get("/admin/api/entitlements", { preHandler: app.requireAdmin }, async () => ({
		registry: [...ENTITLEMENTS.values()],
		profiles: ENTITLEMENT_PROFILES,
		matrix: await loadMatrix(),
		templates: Object.keys(TEMPLATES),
	}));

	/** Set (value) or clear (null → falls back along the resolution chain). */
	app.put("/admin/api/entitlements/:profile/:key", { preHandler: app.requireOwner }, async (req) => {
		const { profile, key } = req.params as { profile: string; key: string };
		if (!(ENTITLEMENT_PROFILES as readonly string[]).includes(profile)) throw new ApiError(400, { error: "unknown_profile" });
		const body = z.object({ value: z.unknown() }).parse(req.body);
		const [existing] = await db
			.select()
			.from(entitlementProfiles)
			.where(and(eq(entitlementProfiles.profile, profile), eq(entitlementProfiles.key, key)))
			.limit(1);
		if (body.value === null || body.value === undefined) {
			await db.delete(entitlementProfiles).where(and(eq(entitlementProfiles.profile, profile), eq(entitlementProfiles.key, key)));
		} else {
			const v = validateEntitlementValue(key, body.value);
			if (!v.ok) throw new ApiError(400, { error: "invalid_value", detail: v.error });
			await db
				.insert(entitlementProfiles)
				.values({ profile, key, value: v.value, updatedBy: req.admin.username })
				.onConflictDoUpdate({
					target: [entitlementProfiles.profile, entitlementProfiles.key],
					set: { value: v.value, updatedBy: req.admin.username, updatedAt: new Date() },
				});
		}
		await invalidate("entitlement-profiles");
		await audit(req.admin, "entitlement.profile.set", `${profile}:${key}`, existing?.value ?? null, body.value ?? null);
		// Feature-backed booleans live in the JWT: re-issue affected sessions.
		if (ENTITLEMENTS.get(key)?.feature) await bumpTokenVersionForProfile(profile);
		return { ok: true };
	});

	app.get("/admin/api/entitlements/templates/:name/preview", { preHandler: app.requireAdmin }, async (req) => {
		const { name } = req.params as { name: string };
		return { changes: templateChanges(name, await loadMatrix()) };
	});

	app.post("/admin/api/entitlements/templates/:name/apply", { preHandler: app.requireOwner }, async (req) => {
		const { name } = req.params as { name: string };
		const changes = templateChanges(name, await loadMatrix());
		await db.transaction(async (tx) => {
			for (const c of changes) {
				if (c.after === null) {
					await tx.delete(entitlementProfiles).where(and(eq(entitlementProfiles.profile, c.profile), eq(entitlementProfiles.key, c.key)));
				} else {
					await tx
						.insert(entitlementProfiles)
						.values({ profile: c.profile, key: c.key, value: c.after, updatedBy: req.admin.username })
						.onConflictDoUpdate({
							target: [entitlementProfiles.profile, entitlementProfiles.key],
							set: { value: c.after, updatedBy: req.admin.username, updatedAt: new Date() },
						});
				}
			}
		});
		await invalidate("entitlement-profiles");
		await audit(req.admin, "entitlement.template.apply", name, null, changes);
		if (changes.some((c) => ENTITLEMENTS.get(c.key)?.feature)) {
			for (const p of new Set(changes.map((c) => c.profile))) await bumpTokenVersionForProfile(p);
		}
		return { applied: changes.length };
	});
}
