import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { config } from "../config";
import * as schema from "./schema";

/**
 * Two pools: writes and read-after-write paths use `db`, heavy read paths
 * (grid, feeds, heatmap, admin stats) may use `dbRead` (replica when set).
 * `prepare: false` keeps us compatible with PgBouncer transaction pooling.
 */
const writeSql = postgres(config.DATABASE_URL, { max: 20, prepare: false, idle_timeout: 30 });
const readSql =
	config.databaseReadUrl === config.DATABASE_URL
		? writeSql
		: postgres(config.databaseReadUrl, { max: 20, prepare: false, idle_timeout: 30 });

export const db = drizzle(writeSql, { schema });
export const dbRead = drizzle(readSql, { schema });
export type Db = typeof db;
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export const rawSql = writeSql;

export async function closeDb(): Promise<void> {
	await writeSql.end({ timeout: 5 });
	if (readSql !== writeSql) await readSql.end({ timeout: 5 });
}
