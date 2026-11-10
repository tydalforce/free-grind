import { sql } from "drizzle-orm";
import {
	bigint,
	bigserial,
	boolean,
	index,
	integer,
	jsonb,
	pgTable,
	primaryKey,
	text,
	timestamp,
	uniqueIndex,
} from "drizzle-orm/pg-core";
import { users } from "./users";

// ---------------------------------------------------------------------------
// Roles (6c): plus | xtra | unlimited | premium; Free == no row.
// ---------------------------------------------------------------------------
export const ROLES = ["plus", "xtra", "unlimited", "premium"] as const;
export type Role = (typeof ROLES)[number];
/** Higher index wins when resolving entitlements. */
export const ROLE_RANK: Record<Role | "free", number> = { free: 0, plus: 1, xtra: 2, unlimited: 3, premium: 4 };

export const userRoles = pgTable(
	"user_roles",
	{
		userId: bigint("user_id", { mode: "bigint" })
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		role: text("role", { enum: ROLES }).notNull(),
		grantedBy: text("granted_by"),
		grantedAt: timestamp("granted_at", { withTimezone: true }).notNull().defaultNow(),
		expiresAt: timestamp("expires_at", { withTimezone: true }),
	},
	(t) => [
		primaryKey({ columns: [t.userId, t.role] }),
		index("user_roles_expires_idx").on(t.expiresAt).where(sql`${t.expiresAt} IS NOT NULL`),
	],
);

// ---------------------------------------------------------------------------
// Feature flags / assignments / experiments (6c)
// ---------------------------------------------------------------------------
export const FLAG_TYPES = ["FEATURE_FLAG", "EXPERIMENT", "FEATURE"] as const;
export type FlagType = (typeof FLAG_TYPES)[number];

export const flags = pgTable("flags", {
	key: text("key").primaryKey(),
	type: text("type", { enum: FLAG_TYPES }).notNull(),
	/** Value when no rule matches; "off"/"on" for flags, a variant for experiments. */
	defaultValue: text("default_value").notNull().default("off"),
	payload: jsonb("payload"),
	description: text("description"),
	enabled: boolean("enabled").notNull().default(true),
	/** Visible without a session via /public/v1/assignments. */
	isPublic: boolean("is_public").notNull().default(false),
	/** Locked flags can't be edited in the admin UI (e.g. recaptcha_* = off). */
	locked: boolean("locked").notNull().default(false),
	updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Ordered targeting rules. `conditions` is a JSON object, all keys must match:
 * { roles?: string[], userIds?: string[], geohashPrefixes?: string[],
 *   platforms?: string[], minAppVersion?: string, minAccountAgeDays?: number,
 *   percentage?: number }
 * `variants` (experiments): [{ value, weight }] — stable per user.
 */
export const flagRules = pgTable(
	"flag_rules",
	{
		id: bigserial("id", { mode: "number" }).primaryKey(),
		flagKey: text("flag_key")
			.notNull()
			.references(() => flags.key, { onDelete: "cascade", onUpdate: "cascade" }),
		position: integer("position").notNull().default(0),
		conditions: jsonb("conditions").notNull().default({}),
		value: text("value"),
		variants: jsonb("variants"),
		payload: jsonb("payload"),
	},
	(t) => [index("flag_rules_flag_idx").on(t.flagKey, t.position)],
);

export const flagUserOverrides = pgTable(
	"flag_user_overrides",
	{
		userId: bigint("user_id", { mode: "bigint" })
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		flagKey: text("flag_key")
			.notNull()
			.references(() => flags.key, { onDelete: "cascade", onUpdate: "cascade" }),
		value: text("value").notNull(),
		payload: jsonb("payload"),
	},
	(t) => [primaryKey({ columns: [t.userId, t.flagKey] })],
);

// ---------------------------------------------------------------------------
// Entitlements (6a)
// ---------------------------------------------------------------------------
/** profile = "default" | "free" | role */
export const entitlementProfiles = pgTable(
	"entitlement_profiles",
	{
		profile: text("profile").notNull(),
		key: text("key").notNull(),
		value: jsonb("value").notNull(),
		updatedBy: text("updated_by"),
		updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [primaryKey({ columns: [t.profile, t.key] })],
);

export const entitlementUserOverrides = pgTable(
	"entitlement_user_overrides",
	{
		userId: bigint("user_id", { mode: "bigint" })
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		key: text("key").notNull(),
		value: jsonb("value").notNull(),
		expiresAt: timestamp("expires_at", { withTimezone: true }),
		updatedBy: text("updated_by"),
		updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [
		primaryKey({ columns: [t.userId, t.key] }),
		index("eo_expires_idx").on(t.expiresAt).where(sql`${t.expiresAt} IS NOT NULL`),
	],
);

/** Durable copy of quota usage; Redis holds the hot counters (write-behind). */
export const entitlementUsage = pgTable(
	"entitlement_usage",
	{
		userId: bigint("user_id", { mode: "bigint" }).notNull(),
		key: text("key").notNull(),
		/** Window identifier, e.g. "day:2026-11-09", "week:2026-W45", "refill". */
		window: text("window").notNull(),
		used: integer("used").notNull().default(0),
		updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [primaryKey({ columns: [t.userId, t.key, t.window] })],
);

// ---------------------------------------------------------------------------
// Settings, audit, outbox
// ---------------------------------------------------------------------------
export const serverSettings = pgTable("server_settings", {
	key: text("key").primaryKey(),
	value: jsonb("value").notNull(),
	/** Values of secret settings are AES-GCM encrypted with APP_SECRET. */
	secret: boolean("secret").notNull().default(false),
	updatedBy: text("updated_by"),
	updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Partitioned by month on created_at (native partitioning, see
 * db/partitions.ts); the partition key must be part of the primary key.
 */
export const adminAuditLog = pgTable(
	"admin_audit_log",
	{
		id: bigserial("id", { mode: "bigint" }).notNull(),
		actor: text("actor").notNull(),
		action: text("action").notNull(),
		target: text("target"),
		before: jsonb("before"),
		after: jsonb("after"),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [primaryKey({ columns: [t.id, t.createdAt] }), index("audit_created_idx").on(t.createdAt), index("audit_target_idx").on(t.target)],
);

/** Transactional outbox: written with the business change, drained by workers. */
export const outbox = pgTable(
	"outbox",
	{
		id: bigserial("id", { mode: "bigint" }).primaryKey(),
		topic: text("topic").notNull(),
		payload: jsonb("payload").notNull(),
		attempts: integer("attempts").notNull().default(0),
		availableAt: timestamp("available_at", { withTimezone: true }).notNull().defaultNow(),
		processedAt: timestamp("processed_at", { withTimezone: true }),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [index("outbox_pending_idx").on(t.availableAt).where(sql`${t.processedAt} IS NULL`)],
);

/** Partitioned by month like admin_audit_log. */
export const securityEvents = pgTable(
	"security_events",
	{
		id: bigserial("id", { mode: "bigint" }).notNull(),
		kind: text("kind").notNull(),
		userId: bigint("user_id", { mode: "bigint" }),
		deviceId: text("device_id"),
		ip: text("ip"),
		detail: jsonb("detail"),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [primaryKey({ columns: [t.id, t.createdAt] }), index("security_events_created_idx").on(t.createdAt), index("security_events_user_idx").on(t.userId)],
);
