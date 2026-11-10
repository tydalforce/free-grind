import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { config } from "../config";

/** Runs against the direct (non-PgBouncer) URL; extensions need a real session. */
export async function runMigrations(): Promise<void> {
	const sql = postgres(config.databaseMigrationUrl, { max: 1 });
	try {
		await sql`CREATE EXTENSION IF NOT EXISTS postgis`;
		await sql`CREATE EXTENSION IF NOT EXISTS pgcrypto`;
		await sql`CREATE EXTENSION IF NOT EXISTS pg_stat_statements`.catch(() => undefined);
		await migrate(drizzle(sql), { migrationsFolder: new URL("./migrations", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1") });
	} finally {
		await sql.end({ timeout: 5 });
	}
}

if (import.meta.main) {
	await runMigrations();
	console.log("migrations applied");
}
