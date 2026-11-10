import { asc, eq } from "drizzle-orm";
import { createHash } from "node:crypto";
import { localCache } from "../cache/local";
import { db } from "../db/client";
import { type FlagType, flagRules, flagUserOverrides, flags } from "../db/schema";
import { compareVersions } from "../lib/clientHeaders";

export type FlagConditions = {
	roles?: string[];
	userIds?: string[];
	geohashPrefixes?: string[];
	platforms?: string[];
	minAppVersion?: string;
	minAccountAgeDays?: number;
	/** 0–100, stable per (user, flag). */
	percentage?: number;
};

export type FlagDefinition = {
	key: string;
	type: FlagType;
	defaultValue: string;
	payload: unknown;
	enabled: boolean;
	isPublic: boolean;
	rules: { conditions: FlagConditions; value: string | null; variants: { value: string; weight: number }[] | null; payload: unknown }[];
};

export type EvalContext = {
	/** null for anonymous (public assignments). */
	userId: string | null;
	/** "free" or role names. */
	roles: string[];
	geohash: string | null;
	platform: string | null;
	appVersion: string | null;
	accountCreatedAt: Date | null;
};

export type Assignment = { key: string; value: string; payload: unknown; type: FlagType };

const defsCache = localCache<FlagDefinition[]>("flags", { ttlMs: 30_000, max: 1 });

export async function loadFlagDefinitions(): Promise<FlagDefinition[]> {
	return defsCache.getOrLoad("all", async () => {
		const [rows, rules] = await Promise.all([
			db.select().from(flags),
			db.select().from(flagRules).orderBy(asc(flagRules.flagKey), asc(flagRules.position)),
		]);
		const byKey = new Map<string, FlagDefinition["rules"]>();
		for (const r of rules) {
			const list = byKey.get(r.flagKey) ?? [];
			list.push({
				conditions: (r.conditions ?? {}) as FlagConditions,
				value: r.value,
				variants: (r.variants as FlagDefinition["rules"][number]["variants"]) ?? null,
				payload: r.payload ?? null,
			});
			byKey.set(r.flagKey, list);
		}
		return rows.map((f) => ({
			key: f.key,
			type: f.type,
			defaultValue: f.defaultValue,
			payload: f.payload ?? null,
			enabled: f.enabled,
			isPublic: f.isPublic,
			rules: byKey.get(f.key) ?? [],
		}));
	});
}

/** Stable bucket 0..9999 for (seed, user). */
export function bucket(seed: string, userId: string): number {
	const h = createHash("sha256").update(`${seed}:${userId}`).digest();
	return h.readUInt32BE(0) % 10_000;
}

function matches(c: FlagConditions, ctx: EvalContext, flagKey: string): boolean {
	if (c.userIds?.length && !(ctx.userId && c.userIds.includes(ctx.userId))) return false;
	if (c.roles?.length && !c.roles.some((r) => ctx.roles.includes(r))) return false;
	if (c.geohashPrefixes?.length && !(ctx.geohash && c.geohashPrefixes.some((p) => ctx.geohash!.startsWith(p)))) return false;
	if (c.platforms?.length && !(ctx.platform && c.platforms.includes(ctx.platform))) return false;
	if (c.minAppVersion && !(ctx.appVersion && compareVersions(ctx.appVersion, c.minAppVersion) >= 0)) return false;
	if (c.minAccountAgeDays != null) {
		if (!ctx.accountCreatedAt) return false;
		if ((Date.now() - ctx.accountCreatedAt.getTime()) / 86_400_000 < c.minAccountAgeDays) return false;
	}
	if (c.percentage != null) {
		if (!ctx.userId) return false;
		if (bucket(`pct:${flagKey}`, ctx.userId) >= Math.round(c.percentage * 100)) return false;
	}
	return true;
}

function pickVariant(variants: { value: string; weight: number }[], flagKey: string, userId: string | null): string {
	const total = variants.reduce((s, v) => s + Math.max(0, v.weight), 0);
	if (total <= 0 || !userId) return variants[0]?.value ?? "control";
	let point = (bucket(`exp:${flagKey}`, userId) / 10_000) * total;
	for (const v of variants) {
		point -= Math.max(0, v.weight);
		if (point < 0) return v.value;
	}
	return variants[variants.length - 1]!.value;
}

async function loadUserOverrides(userId: string): Promise<Map<string, { value: string; payload: unknown }>> {
	const rows = await db.select().from(flagUserOverrides).where(eq(flagUserOverrides.userId, BigInt(userId)));
	return new Map(rows.map((r) => [r.flagKey, { value: r.value, payload: r.payload ?? null }]));
}

export async function evaluateFlags(ctx: EvalContext, opts: { publicOnly?: boolean } = {}): Promise<Assignment[]> {
	const defs = await loadFlagDefinitions();
	const overrides = ctx.userId && !opts.publicOnly ? await loadUserOverrides(ctx.userId) : new Map();
	const out: Assignment[] = [];
	for (const def of defs) {
		if (!def.enabled) continue;
		if (opts.publicOnly && !def.isPublic) continue;
		const override = overrides.get(def.key);
		if (override) {
			out.push({ key: def.key, value: override.value, payload: override.payload ?? def.payload, type: def.type });
			continue;
		}
		let value = def.defaultValue;
		let payload = def.payload;
		for (const rule of def.rules) {
			if (!matches(rule.conditions, ctx, def.key)) continue;
			value = rule.variants?.length ? pickVariant(rule.variants, def.key, ctx.userId) : (rule.value ?? value);
			payload = rule.payload ?? payload;
			break;
		}
		out.push({ key: def.key, value, payload, type: def.type });
	}
	return out.sort((a, b) => a.key.localeCompare(b.key));
}

export function isOn(value: string): boolean {
	const v = value.toLowerCase();
	return v === "on" || v === "true" || v === "enabled";
}
