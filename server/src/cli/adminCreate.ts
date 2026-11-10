/**
 * Bootstrap an admin account:
 *   bun run admin:create <username> [owner|moderator]
 * The password is read from ADMIN_PASSWORD or prompted (not echoed in shell history).
 */
import { eq } from "drizzle-orm";
import { adminPasswordOpts } from "../admin/auth";
import { closeRedis } from "../cache/redis";
import { closeDb, db } from "../db/client";
import { admins } from "../db/schema";

const [username, roleArg] = process.argv.slice(2);
const role = roleArg === "moderator" ? "moderator" : "owner";
if (!username || !/^[a-zA-Z0-9_.-]{3,64}$/.test(username)) {
	console.error("usage: bun run admin:create <username> [owner|moderator]");
	process.exit(1);
}

let password = process.env.ADMIN_PASSWORD ?? "";
if (!password) password = prompt("Password (min. 12 characters):") ?? "";
if (password.length < 12) {
	console.error("password must have at least 12 characters");
	process.exit(1);
}

const passwordHash = await Bun.password.hash(password, adminPasswordOpts);
const [existing] = await db.select({ id: admins.id }).from(admins).where(eq(admins.username, username)).limit(1);
if (existing) {
	await db.update(admins).set({ passwordHash, role, disabled: false }).where(eq(admins.id, existing.id));
	console.log(`updated admin ${username} (${role})`);
} else {
	await db.insert(admins).values({ username, passwordHash, role });
	console.log(`created admin ${username} (${role})`);
}
await Promise.all([closeDb(), closeRedis()]);
