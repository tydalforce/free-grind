import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { redis } from "../../src/cache/redis";
import { db } from "../../src/db/client";
import { dropExpiredPartitions, ensureMonthlyPartitions } from "../../src/db/partitions";
import { drainSecurityEvents } from "../../src/jobs/securityEventsDrain";
import { recordSecurityEvent } from "../../src/lib/securityEvents";

async function partitionOf(table: string, marker: string): Promise<string | null> {
	const rows = (await db.execute(sql.raw(`SELECT tableoid::regclass::text AS part FROM "${table}" WHERE ${table === "admin_audit_log" ? "actor" : "kind"} = '${marker}'`))) as unknown as { part: string }[];
	return rows[0]?.part ?? null;
}

describe("monthly partitions", () => {
	test("rows already in DEFAULT move into the new month partition; idempotent", async () => {
		// A month far in the future so this test owns it.
		const future = new Date(Date.UTC(2035, 5, 15));
		const marker = `part-test-${randomUUID()}`;
		await db.execute(sql`INSERT INTO admin_audit_log (actor, action, created_at) VALUES (${marker}, 'test', ${future.toISOString()})`);
		expect(await partitionOf("admin_audit_log", marker)).toBe("admin_audit_log_default");

		const created = await ensureMonthlyPartitions("admin_audit_log", 0, future);
		expect(created).toEqual(["admin_audit_log_y2035m06"]);
		expect(await partitionOf("admin_audit_log", marker)).toBe("admin_audit_log_y2035m06");
		expect(await ensureMonthlyPartitions("admin_audit_log", 0, future)).toEqual([]);

		// Retention: 1 month, "now" two months later → the June 2035 partition goes.
		const dropped = await dropExpiredPartitions("admin_audit_log", 1, new Date(Date.UTC(2035, 7, 15)));
		expect(dropped).toContain("admin_audit_log_y2035m06");
		expect(await partitionOf("admin_audit_log", marker)).toBeNull();
	});

	test("current and upcoming months exist after ensure", async () => {
		await ensureMonthlyPartitions("security_events", 3);
		const now = new Date();
		const name = `security_events_y${now.getUTCFullYear()}m${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
		const [row] = (await db.execute(sql`SELECT 1 AS ok FROM pg_class WHERE relname = ${name}`)) as unknown as { ok: number }[];
		expect(row?.ok).toBe(1);
	});
});

describe("security event drain", () => {
	test("events go from the Redis stream into Postgres and leave the stream", async () => {
		await ensureMonthlyPartitions("security_events", 1);
		const marker = `drain-${randomUUID()}`;
		await recordSecurityEvent("login_failed", { ip: "10.1.2.3", detail: { marker } });
		await recordSecurityEvent("rate_limited", { userId: "42", detail: { marker } });
		const stored = await drainSecurityEvents("test-consumer");
		expect(stored).toBeGreaterThanOrEqual(2);
		const rows = (await db.execute(sql`SELECT kind, ip, user_id::text AS user_id FROM security_events WHERE detail->>'marker' = ${marker} ORDER BY kind`)) as unknown as { kind: string; ip: string | null; user_id: string | null }[];
		expect(rows).toEqual([
			{ kind: "login_failed", ip: "10.1.2.3", user_id: null },
			{ kind: "rate_limited", ip: null, user_id: "42" },
		]);
		// Nothing pending left for the group.
		const pending = (await redis.xpending("stream:security_events", "drain")) as [number, ...unknown[]];
		expect(pending[0]).toBe(0);
	});
});
