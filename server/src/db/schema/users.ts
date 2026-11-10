import { sql } from "drizzle-orm";
import {
	bigint,
	bigserial,
	boolean,
	index,
	integer,
	pgTable,
	primaryKey,
	text,
	timestamp,
	uniqueIndex,
	uuid,
} from "drizzle-orm/pg-core";

/** profileId == users.id (numeric, like upstream). */
export const users = pgTable(
	"users",
	{
		id: bigserial("id", { mode: "bigint" }).primaryKey(),
		email: text("email"),
		emailVerifiedAt: timestamp("email_verified_at", { withTimezone: true }),
		passwordHash: text("password_hash"),
		birthday: timestamp("birthday", { withTimezone: true }).notNull(),
		optIn: boolean("opt_in").notNull().default(false),
		/** Bumped to invalidate every session JWT of this user immediately. */
		tokenVersion: integer("token_version").notNull().default(0),
		/** Per-user secret for the stable location offset (6d). */
		locationSeed: text("location_seed").notNull().default(sql`encode(gen_random_bytes(32), 'hex')`),
		/**
		 * Denormalized from `bans` for cheap grid filtering: hidden while
		 * banned_until > now(). Permanent bans and timed bans awaiting the ban
		 * agreement use 'infinity'; a timed ban without agreement its end time.
		 */
		bannedUntil: timestamp("banned_until", { withTimezone: true }),
		deletedAt: timestamp("deleted_at", { withTimezone: true }),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [
		uniqueIndex("users_email_lower_uq").on(sql`lower(${t.email})`).where(sql`${t.email} IS NOT NULL AND ${t.deletedAt} IS NULL`),
		index("users_created_at_idx").on(t.createdAt),
	],
);

export const thirdPartyIdentities = pgTable(
	"third_party_identities",
	{
		id: bigserial("id", { mode: "bigint" }).primaryKey(),
		userId: bigint("user_id", { mode: "bigint" })
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		provider: text("provider", { enum: ["google", "facebook"] }).notNull(),
		providerUserId: text("provider_user_id").notNull(),
		/** Upstream format, e.g. `facebook122104356681457161`. */
		prefixedId: text("prefixed_id").notNull(),
		email: text("email"),
		emailVerified: boolean("email_verified").notNull().default(false),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [
		uniqueIndex("tpi_provider_user_uq").on(t.provider, t.providerUserId),
		uniqueIndex("tpi_prefixed_uq").on(t.prefixedId),
		index("tpi_user_idx").on(t.userId),
	],
);

/** One row per (user, device) the user signed in from. */
export const devices = pgTable(
	"devices",
	{
		userId: bigint("user_id", { mode: "bigint" })
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		/** 16-hex androidId, first field of L-Device-Info. */
		deviceId: text("device_id").notNull(),
		userAgent: text("user_agent"),
		fcmToken: text("fcm_token"),
		lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
		revokedAt: timestamp("revoked_at", { withTimezone: true }),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [
		primaryKey({ columns: [t.userId, t.deviceId] }),
		uniqueIndex("devices_fcm_token_uq").on(t.fcmToken).where(sql`${t.fcmToken} IS NOT NULL`),
	],
);

/**
 * Rotating refresh tokens (`authToken`). Each sign-in starts a family; every
 * refresh consumes the current token and issues the next. Presenting an
 * already-consumed token revokes the whole family (reuse detection).
 */
export const authTokens = pgTable(
	"auth_tokens",
	{
		id: bigserial("id", { mode: "bigint" }).primaryKey(),
		familyId: uuid("family_id").notNull(),
		userId: bigint("user_id", { mode: "bigint" })
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		deviceId: text("device_id").notNull(),
		/** sha256(token) hex; the token itself is never stored. */
		tokenHash: text("token_hash").notNull(),
		consumedAt: timestamp("consumed_at", { withTimezone: true }),
		revokedAt: timestamp("revoked_at", { withTimezone: true }),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [
		uniqueIndex("auth_tokens_hash_uq").on(t.tokenHash),
		index("auth_tokens_family_idx").on(t.familyId),
		index("auth_tokens_user_idx").on(t.userId),
	],
);

/** P-256 upload-signing keys (security-headers.md "Device-key upload signing"). */
export const deviceKeys = pgTable(
	"device_keys",
	{
		keyId: text("key_id").primaryKey(),
		userId: bigint("user_id", { mode: "bigint" })
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		deviceId: text("device_id").notNull(),
		publicKey: text("public_key").notNull(),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [index("device_keys_user_idx").on(t.userId)],
);

/** RS256 signing keys for session JWTs; active + previous stay valid. */
export const jwtKeys = pgTable("jwt_keys", {
	kid: text("kid").primaryKey(),
	privateJwk: text("private_jwk").notNull(),
	publicJwk: text("public_jwk").notNull(),
	active: boolean("active").notNull().default(false),
	createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
	retiredAt: timestamp("retired_at", { withTimezone: true }),
});
