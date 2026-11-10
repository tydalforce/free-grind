/**
 * drizzle-kit quotes custom PostGIS types (`"geography(Point, 4326)"`), which
 * Postgres then can't resolve. Runs after `drizzle-kit generate`.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = join(import.meta.dir, "..", "src", "db", "migrations");
for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql"))) {
	const path = join(dir, file);
	const before = readFileSync(path, "utf8");
	const after = before.replace(/"(geography\([^)]*\))"/g, "$1");
	if (after !== before) {
		writeFileSync(path, after);
		console.log(`fixed PostGIS types in ${file}`);
	}
}
