import { and, eq, gt, isNull, or } from "drizzle-orm";
import { localCache } from "../cache/local";
import { db } from "../db/client";
import { ROLE_RANK, type Role, entitlementProfiles, entitlementUserOverrides, userRoles } from "../db/schema";
import { ENTITLEMENTS, type EntitlementValue } from "./registry";

export type EntitlementSource = { kind: "override" } | { kind: "role"; role: string } | { kind: "default" } | { kind: "registry" };
export type Resolved = { key: string; value: EntitlementValue; source: EntitlementSource };

/** profile name → key → value. Profiles: "default", "free", plus role names. */
const profilesCache = localCache<Map<string, Map<string, EntitlementValue>>>("entitlement-profiles", { ttlMs: 30_000, max: 1 });
const userCache = localCache<{ roles: Role[]; overrides: Map<string, EntitlementValue> }>("entitlement-user", { ttlMs: 10_000, max: 50_000 });

async function loadProfiles() {
	return profilesCache.getOrLoad("all", async () => {
		const rows = await db.select().from(entitlementProfiles);
		const map = new Map<string, Map<string, EntitlementValue>>();
		for (const r of rows) {
			const m = map.get(r.profile) ?? new Map();
			m.set(r.key, r.value as EntitlementValue);
			map.set(r.profile, m);
		}
		return map;
	});
}

export async function loadUserRolesAndOverrides(userId: bigint) {
	return userCache.getOrLoad(String(userId), async () => {
		const now = new Date();
		const [roles, overrides] = await Promise.all([
			db
				.select({ role: userRoles.role })
				.from(userRoles)
				.where(and(eq(userRoles.userId, userId), or(isNull(userRoles.expiresAt), gt(userRoles.expiresAt, now)))),
			db
				.select({ key: entitlementUserOverrides.key, value: entitlementUserOverrides.value })
				.from(entitlementUserOverrides)
				.where(
					and(
						eq(entitlementUserOverrides.userId, userId),
						or(isNull(entitlementUserOverrides.expiresAt), gt(entitlementUserOverrides.expiresAt, now)),
					),
				),
		]);
		return {
			roles: roles.map((r) => r.role).sort((a, b) => ROLE_RANK[b] - ROLE_RANK[a]),
			overrides: new Map(overrides.map((o) => [o.key, o.value as EntitlementValue])),
		};
	});
}

/** Highest role first; empty array = Free. */
export async function getActiveRoles(userId: bigint): Promise<Role[]> {
	return (await loadUserRolesAndOverrides(userId)).roles;
}

/**
 * Resolution order (plan 6a): user override → highest active role
 * (Free when none) → "default" profile → registry default.
 */
export async function resolveEntitlement(userId: bigint, key: string): Promise<Resolved> {
	const def = ENTITLEMENTS.get(key);
	if (!def) throw new Error(`unknown entitlement ${key}`);
	const [{ roles, overrides }, profiles] = await Promise.all([loadUserRolesAndOverrides(userId), loadProfiles()]);
	const override = overrides.get(key);
	if (override !== undefined) return { key, value: override, source: { kind: "override" } };
	const tierProfiles = roles.length ? roles : ["free"];
	for (const role of tierProfiles) {
		const v = profiles.get(role)?.get(key);
		if (v !== undefined) return { key, value: v, source: { kind: "role", role } };
	}
	const d = profiles.get("default")?.get(key);
	if (d !== undefined) return { key, value: d, source: { kind: "default" } };
	return { key, value: def.default, source: { kind: "registry" } };
}

export async function resolveAll(userId: bigint): Promise<Resolved[]> {
	return Promise.all([...ENTITLEMENTS.keys()].map((k) => resolveEntitlement(userId, k)));
}

export function isUnlimited(v: EntitlementValue): boolean {
	return typeof v === "object" && v !== null && "unlimited" in v && v.unlimited === true;
}

/** Boolean entitlement → on/off (non-boolean values count as on). */
export function isEnabled(v: EntitlementValue): boolean {
	return typeof v === "boolean" ? v : true;
}

/** cap → number or Infinity. */
export function capOf(v: EntitlementValue): number {
	if (isUnlimited(v)) return Number.POSITIVE_INFINITY;
	if (typeof v === "object" && v && "max" in v) return v.max;
	return Number.POSITIVE_INFINITY;
}

/** duration → seconds or Infinity. */
export function secondsOf(v: EntitlementValue): number {
	if (isUnlimited(v)) return Number.POSITIVE_INFINITY;
	if (typeof v === "object" && v && "seconds" in v) return v.seconds;
	return Number.POSITIVE_INFINITY;
}

/** Features claim: boolean entitlements with a `feature` name that resolve to true. */
export async function resolveFeatures(userId: bigint): Promise<string[]> {
	const out: string[] = [];
	for (const def of ENTITLEMENTS.values()) {
		if (def.type !== "boolean" || !def.feature) continue;
		const { value } = await resolveEntitlement(userId, def.key);
		if (isEnabled(value)) out.push(def.feature);
	}
	return out;
}
