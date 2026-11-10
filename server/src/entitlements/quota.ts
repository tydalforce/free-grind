import { redis } from "../cache/redis";
import type { QuotaWindow } from "./registry";

/**
 * Atomic multi-window quota (plan 6a). Every window of one entitlement is
 * checked first and only then all are charged, inside one Lua script, so
 * concurrent requests can never double-spend.
 *
 * Window kinds:
 *  - fixed  (day/week/month): counter key per period, TTL to period end
 *  - rolling: sorted set of timestamps within the last `seconds`
 *  - refill: token bucket {tokens, ts}; +1 every `everySeconds`, capped at `max`
 */

// KEYS[i]  = redis key for window i
// ARGV[1]  = now (ms), ARGV[2] = n (amount; 0 = peek), ARGV[3] = number of windows
// then per window: kind, limit, a, b
//   fixed:   a = periodEndMs
//   rolling: a = windowMs
//   refill:  a = everyMs, b = max
// returns { allowed(0/1), remaining, resetAtMs }
const LUA = `
local now = tonumber(ARGV[1])
local n = tonumber(ARGV[2])
local count = tonumber(ARGV[3])
local allowed = 1
local remaining = -1
local resetAt = 0
local state = {}
for i = 1, count do
	local base = 3 + (i - 1) * 4
	local kind = ARGV[base + 1]
	local limit = tonumber(ARGV[base + 2])
	local a = tonumber(ARGV[base + 3])
	local b = tonumber(ARGV[base + 4])
	local key = KEYS[i]
	local left, reset
	if kind == "fixed" then
		local used = tonumber(redis.call("GET", key) or "0")
		left = limit - used
		reset = a
	elseif kind == "rolling" then
		redis.call("ZREMRANGEBYSCORE", key, "-inf", now - a)
		local used = redis.call("ZCARD", key)
		left = limit - used
		local oldest = redis.call("ZRANGE", key, 0, 0, "WITHSCORES")
		if oldest[2] then reset = tonumber(oldest[2]) + a else reset = now end
	else
		local h = redis.call("HMGET", key, "tokens", "ts")
		local tokens = tonumber(h[1])
		local ts = tonumber(h[2])
		if tokens == nil then tokens = b; ts = now end
		if tokens < b then
			local gained = math.floor((now - ts) / a)
			if gained > 0 then
				tokens = math.min(b, tokens + gained)
				ts = ts + gained * a
			end
		end
		if tokens >= b then ts = now end
		state[i] = { tokens, ts }
		left = tokens
		if tokens >= b then reset = now else reset = ts + a end
	end
	if left < n then allowed = 0 end
	if remaining == -1 or left < remaining then remaining = left end
	if left <= 0 or (n > 0 and left < n) then
		if reset > resetAt then resetAt = reset end
	elseif resetAt == 0 then
		resetAt = reset
	end
end
if allowed == 1 and n > 0 then
	for i = 1, count do
		local base = 3 + (i - 1) * 4
		local kind = ARGV[base + 1]
		local a = tonumber(ARGV[base + 3])
		local key = KEYS[i]
		if kind == "fixed" then
			redis.call("INCRBY", key, n)
			redis.call("PEXPIREAT", key, a + 60000)
		elseif kind == "rolling" then
			for j = 1, n do
				redis.call("ZADD", key, now, tostring(now) .. ":" .. tostring(j) .. ":" .. tostring(redis.call("INCR", key .. ":seq")))
			end
			redis.call("PEXPIRE", key, a + 60000)
			redis.call("PEXPIRE", key .. ":seq", a + 60000)
		else
			local st = state[i]
			redis.call("HSET", key, "tokens", st[1] - n, "ts", st[2])
			redis.call("PEXPIRE", key, a * tonumber(ARGV[base + 4]) + 86400000)
		end
	end
	remaining = remaining - n
end
return { allowed, remaining, resetAt }
`;

let scriptSha: string | null = null;

async function evalQuota(keys: string[], args: (string | number)[]): Promise<[number, number, number]> {
	if (!scriptSha) scriptSha = (await redis.script("LOAD", LUA)) as string;
	try {
		return (await redis.evalsha(scriptSha, keys.length, ...keys, ...args)) as [number, number, number];
	} catch (e) {
		if (String((e as Error).message).includes("NOSCRIPT")) {
			scriptSha = null;
			return evalQuota(keys, args);
		}
		throw e;
	}
}

/** Period boundaries in a fixed time zone (server setting; default UTC). */
export function periodOf(window: "day" | "week" | "month", nowMs: number, timeZone: string, weekStartsOn: 0 | 1 = 1): { id: string; endMs: number } {
	const parts = Object.fromEntries(
		new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23", weekday: "short" })
			.formatToParts(new Date(nowMs))
			.map((p) => [p.type, p.value]),
	) as Record<string, string>;
	const y = Number(parts.year);
	const m = Number(parts.month);
	const d = Number(parts.day);
	// Offset of the zone at `now` (local wall time − UTC).
	const localAsUtc = Date.UTC(y, m - 1, d, Number(parts.hour), Number(parts.minute), Number(parts.second));
	const offset = localAsUtc - Math.floor(nowMs / 1000) * 1000;
	const startOfLocalDay = Date.UTC(y, m - 1, d);
	if (window === "day") return { id: `d${y}-${m}-${d}`, endMs: startOfLocalDay + 86_400_000 - offset };
	if (window === "month") {
		const end = Date.UTC(m === 12 ? y + 1 : y, m === 12 ? 0 : m, 1);
		return { id: `m${y}-${m}`, endMs: end - offset };
	}
	const dow = new Date(startOfLocalDay).getUTCDay();
	const sinceStart = (dow - weekStartsOn + 7) % 7;
	const weekStart = startOfLocalDay - sinceStart * 86_400_000;
	return { id: `w${new Date(weekStart).toISOString().slice(0, 10)}`, endMs: weekStart + 7 * 86_400_000 - offset };
}

export type QuotaResult = { allowed: boolean; remaining: number; resetsAt: number | null };

export type QuotaOptions = { timeZone: string; weekStartsOn: 0 | 1; nowMs?: number };

function buildArgs(userId: string, key: string, windows: QuotaWindow[], opts: QuotaOptions) {
	const now = opts.nowMs ?? Date.now();
	const keys: string[] = [];
	const args: (string | number)[] = [];
	windows.forEach((w, i) => {
		const base = `q:${userId}:${key}:${i}`;
		if (w.window === "rolling") {
			keys.push(`${base}:r${w.seconds}`);
			args.push("rolling", w.count, w.seconds * 1000, 0);
		} else if (w.window === "refill") {
			keys.push(`${base}:t${w.everySeconds}:${w.max}`);
			args.push("refill", w.count, w.everySeconds * 1000, w.max);
		} else {
			const p = periodOf(w.window, now, opts.timeZone, opts.weekStartsOn);
			keys.push(`${base}:${p.id}`);
			args.push("fixed", w.count, p.endMs, 0);
		}
	});
	return { now, keys, args };
}

/** Checks and (n > 0) charges all windows atomically. */
export async function consumeQuota(userId: string, key: string, windows: QuotaWindow[], n: number, opts: QuotaOptions): Promise<QuotaResult> {
	if (windows.length === 0) return { allowed: true, remaining: Number.POSITIVE_INFINITY, resetsAt: null };
	const { now, keys, args } = buildArgs(userId, key, windows, opts);
	const [allowed, remaining, resetAt] = await evalQuota(keys, [now, n, windows.length, ...args]);
	return { allowed: allowed === 1, remaining: Math.max(0, remaining), resetsAt: resetAt > 0 ? resetAt : null };
}

export function peekQuota(userId: string, key: string, windows: QuotaWindow[], opts: QuotaOptions): Promise<QuotaResult> {
	return consumeQuota(userId, key, windows, 0, opts);
}

/** Gives back `n` (e.g. an upload that failed after being charged). Best effort. */
export async function releaseQuota(userId: string, key: string, windows: QuotaWindow[], n: number, opts: QuotaOptions): Promise<void> {
	const { keys } = buildArgs(userId, key, windows, opts);
	const pipeline = redis.pipeline();
	windows.forEach((w, i) => {
		const k = keys[i]!;
		if (w.window === "rolling") pipeline.zpopmax(k, n);
		else if (w.window === "refill") pipeline.hincrby(k, "tokens", n);
		else pipeline.decrby(k, n);
	});
	await pipeline.exec();
}

/** Admin "reset usage": drops every window counter of `key` for the user. */
export async function resetQuota(userId: string, key: string): Promise<void> {
	let cursor = "0";
	do {
		const [next, found] = await redis.scan(cursor, "MATCH", `q:${userId}:${key}:*`, "COUNT", 200);
		cursor = next;
		if (found.length) await redis.del(...found);
	} while (cursor !== "0");
}
