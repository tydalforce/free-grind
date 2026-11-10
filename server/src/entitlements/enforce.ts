import { errors } from "../lib/errors";
import { getServerSetting } from "../modules/settings/settings";
import { type QuotaOptions, type QuotaResult, consumeQuota, peekQuota, releaseQuota } from "./quota";
import { ENTITLEMENTS, type EntitlementValue, type QuotaWindow } from "./registry";
import { capOf, isEnabled, isUnlimited, resolveEntitlement, secondsOf, type Resolved } from "./resolve";

/**
 * What route handlers call. Errors use the upstream shapes the client already
 * understands: a disabled feature → 402 urn:gr:err:tiered_feature, an
 * exhausted quota/cap → 402 urn:gr:err:entitlement_limit.
 */

async function quotaOptions(): Promise<QuotaOptions> {
	return {
		timeZone: (await getServerSetting<string>("quota.timeZone")) || "UTC",
		weekStartsOn: ((await getServerSetting<number>("quota.weekStartsOn")) ?? 1) === 0 ? 0 : 1,
	};
}

function windowsOf(v: EntitlementValue): QuotaWindow[] | null {
	if (isUnlimited(v)) return null;
	if (typeof v === "object" && v && "windows" in v) return v.windows;
	return null;
}

export async function requireEnabled(userId: bigint, key: string): Promise<void> {
	const { value } = await resolveEntitlement(userId, key);
	if (!isEnabled(value)) throw errors.tieredFeature(key);
}

export async function isFeatureEnabled(userId: bigint, key: string): Promise<boolean> {
	return isEnabled((await resolveEntitlement(userId, key)).value);
}

/** Charges `n` against a quota entitlement; throws when any window is exhausted. */
export async function consume(userId: bigint, key: string, n = 1): Promise<QuotaResult> {
	const { value } = await resolveEntitlement(userId, key);
	const windows = windowsOf(value);
	if (!windows) return { allowed: true, remaining: Number.POSITIVE_INFINITY, resetsAt: null };
	const result = await consumeQuota(String(userId), key, windows, n, await quotaOptions());
	if (!result.allowed) throw errors.entitlementLimit(key);
	return result;
}

/** Refund after a charged action failed. */
export async function release(userId: bigint, key: string, n = 1): Promise<void> {
	const { value } = await resolveEntitlement(userId, key);
	const windows = windowsOf(value);
	if (windows) await releaseQuota(String(userId), key, windows, n, await quotaOptions());
}

export async function peek(userId: bigint, key: string): Promise<QuotaResult> {
	const { value } = await resolveEntitlement(userId, key);
	const windows = windowsOf(value);
	if (!windows) return { allowed: true, remaining: Number.POSITIVE_INFINITY, resetsAt: null };
	return peekQuota(String(userId), key, windows, await quotaOptions());
}

/** Cap check: `current` already used, `adding` about to be added. */
export async function checkCap(userId: bigint, key: string, current: number, adding = 1): Promise<number> {
	const max = capOf((await resolveEntitlement(userId, key)).value);
	if (current + adding > max) throw errors.entitlementLimit(key);
	return max;
}

export async function capValue(userId: bigint, key: string): Promise<number> {
	return capOf((await resolveEntitlement(userId, key)).value);
}

export async function durationSeconds(userId: bigint, key: string): Promise<number> {
	return secondsOf((await resolveEntitlement(userId, key)).value);
}

/** List entitlement: allowed values, or null = all allowed. */
export async function allowedValues(userId: bigint, key: string): Promise<string[] | null> {
	const { value } = await resolveEntitlement(userId, key);
	if (isUnlimited(value)) return null;
	if (typeof value === "object" && value && "values" in value) return value.values;
	return null;
}

export type EntitlementStatus = {
	key: string;
	type: string;
	unlimited: boolean;
	enabled?: boolean;
	limit: number | null;
	used: number | null;
	remaining: number | null;
	resetsAt: number | null;
	values?: string[] | null;
	source: Resolved["source"];
};

/** GET /v1/me/entitlements (our extension) and the admin user view. */
export async function entitlementStatus(userId: bigint): Promise<EntitlementStatus[]> {
	const opts = await quotaOptions();
	const out: EntitlementStatus[] = [];
	for (const def of ENTITLEMENTS.values()) {
		const r = await resolveEntitlement(userId, def.key);
		const unlimited = isUnlimited(r.value);
		const base = { key: def.key, type: def.type, unlimited, source: r.source };
		if (def.type === "boolean") {
			out.push({ ...base, unlimited: false, enabled: isEnabled(r.value), limit: null, used: null, remaining: null, resetsAt: null });
		} else if (def.type === "quota") {
			const windows = windowsOf(r.value);
			if (!windows) {
				out.push({ ...base, limit: null, used: null, remaining: null, resetsAt: null });
				continue;
			}
			const q = await peekQuota(String(userId), def.key, windows, opts);
			const limit = Math.min(...windows.map((w) => (w.window === "refill" ? w.max : w.count)));
			out.push({ ...base, limit, used: Math.max(0, limit - q.remaining), remaining: q.remaining, resetsAt: q.resetsAt });
		} else if (def.type === "list") {
			const values = isUnlimited(r.value) ? null : typeof r.value === "object" && r.value && "values" in r.value ? r.value.values : null;
			out.push({ ...base, limit: null, used: null, remaining: null, resetsAt: null, values });
		} else {
			const n = def.type === "duration" ? secondsOf(r.value) : capOf(r.value);
			out.push({ ...base, limit: Number.isFinite(n) ? n : null, used: null, remaining: null, resetsAt: null });
		}
	}
	return out;
}
