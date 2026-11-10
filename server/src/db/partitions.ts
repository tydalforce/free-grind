import { sql } from "drizzle-orm";
import { db } from "./client";

/**
 * Native monthly range partitions for append-heavy tables (no pg_partman
 * dependency). `ensureMonthlyPartitions` is idempotent and safe to run from
 * several processes; `dropExpiredPartitions` removes whole months at once
 * (instant, no table-bloating DELETE).
 */
export const PARTITIONED_TABLES = ["admin_audit_log", "security_events", "messages"] as const;
export type PartitionedTable = (typeof PARTITIONED_TABLES)[number];

const NAME_RE = /^[a-z_]+$/;

function monthStart(d: Date, offset = 0): Date {
	return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + offset, 1));
}

function partitionName(table: string, from: Date): string {
	return `${table}_y${from.getUTCFullYear()}m${String(from.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** Creates partitions for this month and `monthsAhead` following months. */
export async function ensureMonthlyPartitions(table: PartitionedTable, monthsAhead = 3, now = new Date()): Promise<string[]> {
	if (!NAME_RE.test(table)) throw new Error("bad table name");
	const created: string[] = [];
	for (let i = 0; i <= monthsAhead; i++) {
		const from = monthStart(now, i);
		const to = monthStart(now, i + 1);
		const name = partitionName(table, from);
		const fromIso = from.toISOString();
		const toIso = to.toISOString();
		await db.transaction(async (tx) => {
			// Serialize concurrent runs for this table.
			await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`partition:${table}`}))`);
			const [exists] = (await tx.execute(sql`SELECT 1 FROM pg_class WHERE relname = ${name}`)) as unknown as unknown[];
			if (exists) return;
			// Rows of this month already in DEFAULT would make CREATE ... PARTITION OF
			// fail: move them out first, then back into the new partition.
			await tx.execute(sql.raw(`CREATE TEMP TABLE _moving ON COMMIT DROP AS SELECT * FROM "${table}_default" WHERE created_at >= '${fromIso}' AND created_at < '${toIso}'`));
			await tx.execute(sql.raw(`DELETE FROM "${table}_default" WHERE created_at >= '${fromIso}' AND created_at < '${toIso}'`));
			await tx.execute(sql.raw(`CREATE TABLE "${name}" PARTITION OF "${table}" FOR VALUES FROM ('${fromIso}') TO ('${toIso}')`));
			await tx.execute(sql.raw(`INSERT INTO "${table}" SELECT * FROM _moving`));
			created.push(name);
		});
	}
	return created;
}

/** Drops month partitions that ended more than `retentionMonths` ago. */
export async function dropExpiredPartitions(table: PartitionedTable, retentionMonths: number, now = new Date()): Promise<string[]> {
	if (!NAME_RE.test(table) || retentionMonths < 1) return [];
	const cutoff = monthStart(now, -retentionMonths);
	const rows = (await db.execute(sql`
		SELECT c.relname AS name
		FROM pg_inherits i
		JOIN pg_class c ON c.oid = i.inhrelid
		JOIN pg_class p ON p.oid = i.inhparent
		WHERE p.relname = ${table} AND c.relname ~ ${`^${table}_y\\d{4}m\\d{2}$`}
	`)) as unknown as { name: string }[];
	const dropped: string[] = [];
	for (const { name } of rows) {
		const m = /_y(\d{4})m(\d{2})$/.exec(name);
		if (!m) continue;
		const end = new Date(Date.UTC(Number(m[1]), Number(m[2]), 1));
		if (end <= cutoff) {
			await db.execute(sql.raw(`DROP TABLE IF EXISTS "${name}"`));
			dropped.push(name);
		}
	}
	return dropped;
}
