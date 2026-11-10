import { bigint, bigserial, boolean, index, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

export const ADMIN_ROLES = ["owner", "moderator"] as const;
export type AdminRole = (typeof ADMIN_ROLES)[number];

/** Admin-UI accounts; separate from app users. */
export const admins = pgTable(
	"admins",
	{
		id: bigserial("id", { mode: "bigint" }).primaryKey(),
		username: text("username").notNull(),
		passwordHash: text("password_hash").notNull(),
		role: text("role", { enum: ADMIN_ROLES }).notNull().default("moderator"),
		/** Base32 TOTP secret, encrypted with APP_SECRET; null = TOTP off. */
		totpSecret: text("totp_secret"),
		disabled: boolean("disabled").notNull().default(false),
		lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [uniqueIndex("admins_username_uq").on(t.username)],
);

export const adminSessions = pgTable(
	"admin_sessions",
	{
		/** sha256(cookie token) hex. */
		id: text("id").primaryKey(),
		adminId: bigint("admin_id", { mode: "bigint" })
			.notNull()
			.references(() => admins.id, { onDelete: "cascade" }),
		ip: text("ip"),
		userAgent: text("user_agent"),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
		expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
	},
	(t) => [index("admin_sessions_admin_idx").on(t.adminId), index("admin_sessions_expires_idx").on(t.expiresAt)],
);
