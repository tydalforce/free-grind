import { sql } from "drizzle-orm";
import { invalidate } from "../cache/local";
import { db } from "../db/client";
import { bumpTokenVersion } from "../modules/auth/sessions";

/**
 * Worker: removes roles and user entitlement overrides whose `expires_at` has
 * passed, and re-issues the affected users' session tokens right away —
 * roles and feature entitlements are JWT claims, so an expired "unlimited"
 * must not linger until the next regular refresh.
 */
export async function sweepExpiredGrants(batch = 1000): Promise<number> {
	const roles = (await db.execute(sql`
		DELETE FROM user_roles WHERE ctid IN (SELECT ctid FROM user_roles WHERE expires_at IS NOT NULL AND expires_at <= now() LIMIT ${batch})
		RETURNING user_id::text AS id`)) as unknown as { id: string }[];
	const overrides = (await db.execute(sql`
		DELETE FROM entitlement_user_overrides WHERE ctid IN (SELECT ctid FROM entitlement_user_overrides WHERE expires_at IS NOT NULL AND expires_at <= now() LIMIT ${batch})
		RETURNING user_id::text AS id`)) as unknown as { id: string }[];
	const affected = [...new Set([...roles, ...overrides].map((r) => r.id))];
	for (const id of affected) {
		await invalidate("entitlement-user", id);
		await bumpTokenVersion(BigInt(id));
	}
	return affected.length;
}
