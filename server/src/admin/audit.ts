import { db } from "../db/client";
import { adminAuditLog } from "../db/schema";
import type { AdminContext } from "./auth";

/**
 * JSONB-safe copy: BigInt ids become strings, Dates ISO strings (or null for
 * Postgres 'infinity'), so any row can be logged as before/after.
 */
export function toJsonSafe(value: unknown): unknown {
	if (value === undefined) return null;
	return JSON.parse(
		JSON.stringify(value, (_k, v) => {
			if (typeof v === "bigint") return v.toString();
			return v;
		}),
	);
}

/** Every admin change is logged: who, what, before/after. */
export async function audit(admin: AdminContext | string, action: string, target: string | null, before: unknown, after: unknown): Promise<void> {
	await db.insert(adminAuditLog).values({
		actor: typeof admin === "string" ? admin : admin.username,
		action,
		target,
		before: toJsonSafe(before) as object | null,
		after: toJsonSafe(after) as object | null,
	});
}
