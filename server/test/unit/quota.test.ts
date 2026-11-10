import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { consumeQuota, peekQuota, periodOf, releaseQuota, resetQuota } from "../../src/entitlements/quota";
import type { QuotaWindow } from "../../src/entitlements/registry";

const OPTS = { timeZone: "UTC", weekStartsOn: 1 as const };
const uid = () => `t${randomUUID()}`;
const T0 = Date.UTC(2026, 10, 9, 12, 0, 0); // Monday 2026-11-09 12:00 UTC (pure period math only)

/**
 * Redis-backed tests need windows that end in the future (keys get
 * PEXPIREAT their period end): the next Monday 12:00 UTC from now.
 */
const T1 = (() => {
	const d = new Date();
	const daysToMonday = ((8 - d.getUTCDay()) % 7) || 7;
	return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + daysToMonday, 12);
})();
const WEEK_END = T1 - 12 * 3_600_000 + 7 * 86_400_000;

describe("periodOf", () => {
	test("day/week/month boundaries in UTC (week starts Monday)", () => {
		expect(periodOf("day", T0, "UTC").endMs).toBe(Date.UTC(2026, 10, 10));
		expect(periodOf("week", T0, "UTC").endMs).toBe(Date.UTC(2026, 10, 16));
		expect(periodOf("month", T0, "UTC").endMs).toBe(Date.UTC(2026, 11, 1));
	});
	test("time zone shifts the day boundary", () => {
		// 23:30 UTC is already the next day in Berlin (UTC+1 in November).
		const t = Date.UTC(2026, 10, 9, 23, 30);
		expect(periodOf("day", t, "Europe/Berlin").endMs).toBe(Date.UTC(2026, 10, 10, 23, 0));
	});
	test("Sunday week start", () => {
		expect(periodOf("week", T0, "UTC", 0).endMs).toBe(Date.UTC(2026, 10, 15));
	});
});

describe("consumeQuota", () => {
	test("1 per week: second charge in the same week is refused, next week allowed", async () => {
		const u = uid();
		const w: QuotaWindow[] = [{ count: 1, window: "week" }];
		expect((await consumeQuota(u, "rightnow.posts", w, 1, { ...OPTS, nowMs: T1 })).allowed).toBe(true);
		const second = await consumeQuota(u, "rightnow.posts", w, 1, { ...OPTS, nowMs: T1 + 86_400_000 });
		expect(second.allowed).toBe(false);
		expect(second.resetsAt).toBe(WEEK_END);
		expect((await consumeQuota(u, "rightnow.posts", w, 1, { ...OPTS, nowMs: WEEK_END + 3_600_000 })).allowed).toBe(true);
	});

	test("1/day AND 3/week combined", async () => {
		const u = uid();
		const w: QuotaWindow[] = [
			{ count: 1, window: "day" },
			{ count: 3, window: "week" },
		];
		const at = (day: number) => ({ ...OPTS, nowMs: T1 + day * 86_400_000 });
		expect((await consumeQuota(u, "k", w, 1, at(0))).allowed).toBe(true);
		expect((await consumeQuota(u, "k", w, 1, at(0))).allowed).toBe(false); // day limit
		expect((await consumeQuota(u, "k", w, 1, at(1))).allowed).toBe(true);
		expect((await consumeQuota(u, "k", w, 1, at(2))).allowed).toBe(true);
		const fourth = await consumeQuota(u, "k", w, 1, at(3));
		expect(fourth.allowed).toBe(false); // week limit, although the day is fresh
		expect(fourth.resetsAt).toBe(WEEK_END);
	});

	test("refused charge books nothing in any window", async () => {
		const u = uid();
		const w: QuotaWindow[] = [
			{ count: 5, window: "day" },
			{ count: 1, window: "week" },
		];
		await consumeQuota(u, "k", w, 1, { ...OPTS, nowMs: T1 });
		await consumeQuota(u, "k", w, 1, { ...OPTS, nowMs: T1 });
		expect((await peekQuota(u, "k", [{ count: 5, window: "day" }], { ...OPTS, nowMs: T1 })).remaining).toBe(4);
	});

	test("rolling window", async () => {
		const u = uid();
		const w: QuotaWindow[] = [{ count: 2, window: "rolling", seconds: 60 }];
		expect((await consumeQuota(u, "k", w, 1, { ...OPTS, nowMs: T1 })).allowed).toBe(true);
		expect((await consumeQuota(u, "k", w, 1, { ...OPTS, nowMs: T1 + 1000 })).allowed).toBe(true);
		const third = await consumeQuota(u, "k", w, 1, { ...OPTS, nowMs: T1 + 2000 });
		expect(third.allowed).toBe(false);
		expect(third.resetsAt).toBe(T1 + 60_000);
		expect((await consumeQuota(u, "k", w, 1, { ...OPTS, nowMs: T1 + 60_001 })).allowed).toBe(true);
	});

	test("refill: +1 every hour up to max 2", async () => {
		const u = uid();
		const w: QuotaWindow[] = [{ count: 2, window: "refill", everySeconds: 3600, max: 2 }];
		const at = (ms: number) => ({ ...OPTS, nowMs: T1 + ms });
		expect((await consumeQuota(u, "k", w, 1, at(0))).allowed).toBe(true);
		expect((await consumeQuota(u, "k", w, 1, at(1))).allowed).toBe(true);
		const empty = await consumeQuota(u, "k", w, 1, at(2));
		expect(empty.allowed).toBe(false);
		expect(empty.resetsAt).toBe(T1 + 3_600_000);
		expect((await consumeQuota(u, "k", w, 1, at(3_600_000))).allowed).toBe(true);
		expect((await consumeQuota(u, "k", w, 1, at(3_600_001))).allowed).toBe(false);
	});

	test("release and reset give quota back", async () => {
		const u = uid();
		const w: QuotaWindow[] = [{ count: 1, window: "day" }];
		await consumeQuota(u, "k", w, 1, { ...OPTS, nowMs: T1 });
		await releaseQuota(u, "k", w, 1, { ...OPTS, nowMs: T1 });
		expect((await consumeQuota(u, "k", w, 1, { ...OPTS, nowMs: T1 })).allowed).toBe(true);
		await resetQuota(u, "k");
		expect((await consumeQuota(u, "k", w, 1, { ...OPTS, nowMs: T1 })).allowed).toBe(true);
	});

	test("50 concurrent charges against a limit of 10 book exactly 10", async () => {
		const u = uid();
		const w: QuotaWindow[] = [{ count: 10, window: "day" }];
		const results = await Promise.all(Array.from({ length: 50 }, () => consumeQuota(u, "k", w, 1, { ...OPTS, nowMs: T1 })));
		expect(results.filter((r) => r.allowed).length).toBe(10);
		expect((await peekQuota(u, "k", w, { ...OPTS, nowMs: T1 })).remaining).toBe(0);
	});
});
