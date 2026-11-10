import { sql } from "drizzle-orm";
import { invalidate } from "../cache/local";
import { bumpTokenVersionWhere } from "../modules/auth/sessions";

/**
 * Re-issues the sessions of every user an entitlement profile applies to, so
 * changed `features` land in their JWT right away (the client refreshes on 401).
 *  - "default": everyone
 *  - "free":    users without an active role
 *  - role:      users holding that role
 */
export async function bumpTokenVersionForProfile(profile: string): Promise<number> {
	let where;
	if (profile === "default") where = sql`deleted_at IS NULL`;
	else if (profile === "free")
		where = sql`deleted_at IS NULL AND NOT EXISTS (SELECT 1 FROM user_roles r WHERE r.user_id = users.id AND (r.expires_at IS NULL OR r.expires_at > now()))`;
	else
		where = sql`deleted_at IS NULL AND EXISTS (SELECT 1 FROM user_roles r WHERE r.user_id = users.id AND r.role = ${profile} AND (r.expires_at IS NULL OR r.expires_at > now()))`;
	const n = await bumpTokenVersionWhere(where);
	await invalidate("entitlement-user");
	return n;
}
