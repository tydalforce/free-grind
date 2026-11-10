import { sql } from "drizzle-orm";
import { bigint, bigserial, boolean, cidr, index, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { users } from "./users";

/** Upstream BanReason values (authentication.md); shown by the client as the ban reason. */
export const BAN_REASONS = [
	"Harassment",
	"Impersonation",
	"Underage User",
	"Seeking Underage / Child Endangerment",
	"Underage Impersonation / Vigilante Account",
	"Commercial Use / Advertising / Promotion",
	"Sexual Solicitation",
	"Illegal Drug Related Content",
	"Drug Selling",
	"Hate Speech / Discrimination / Hateful Content",
	"Serious Offline Incident",
	"Scam / Spam",
	"Underage - 12 and under",
	"Safety & Privacy",
] as const;

/** Upstream BanSubReason values. */
export const BAN_SUB_REASONS = [
	"UNDERAGE_ACCESS",
	"UNDERAGE_IMPERSONATION",
	"CHILD_ENDANGERMENT",
	"UNWANTED_MESSAGING",
	"PROFILE_SPAM",
	"PHISHING_AND_FRAUD",
	"BOT_ACTIVITY",
	"DRUG_SALES",
	"FREQUENT_DRUG_SOLICITATION",
	"OCCASIONAL_DRUG_SOLICITATION",
	"DRUG_PROMOTION",
	"NON_ILLICIT_SUBSTANCES",
	"PAID_SEXUAL_SERVICES",
	"MILD_SOLICITATION",
	"SALE_OF_SEXUAL_CONTENT",
	"MILD_INSULTS",
	"BULLYING",
	"HATE_SPEECH",
	"BLACKMAIL_AND_THREATS",
	"PRIVACY_VIOLATIONS",
	"IMPERSONATION",
	"CONSENT_VIOLATIONS",
	"OFFLINE_INCIDENTS",
	"GENERAL_ADVERTISING",
	"BUSINESS_SOLICITATION",
	"TRANSACTIONAL_SERVICES",
	"SCAMS_AND_PROMOTIONS",
	"DRUG_SEEKING",
	"DRUG_FACILITATION",
	"NON_CONSENSUAL_INTIMATE_IMAGERY",
	"SEXTORTION",
	"BLOCK_DECISION",
	"Other",
] as const;

export const BAN_TYPES = ["timed", "permanent"] as const;

/**
 * Ban history. The current ban of a user is the newest row without
 * `lifted_at`. A timed ban with `require_agreement` keeps restricting the
 * account after `expires_at` until the user accepts the ban agreement
 * (POST /v1/agreements/ban).
 */
export const bans = pgTable(
	"bans",
	{
		id: bigserial("id", { mode: "bigint" }).primaryKey(),
		userId: bigint("user_id", { mode: "bigint" })
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		type: text("type", { enum: BAN_TYPES }).notNull(),
		reason: text("reason"),
		subReason: text("sub_reason"),
		automated: boolean("automated").notNull().default(false),
		requireAgreement: boolean("require_agreement").notNull().default(true),
		/** Null for permanent bans. */
		expiresAt: timestamp("expires_at", { withTimezone: true }),
		agreementCompletedAt: timestamp("agreement_completed_at", { withTimezone: true }),
		/** Internal note, never sent to the user. */
		note: text("note"),
		createdBy: text("created_by"),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
		liftedAt: timestamp("lifted_at", { withTimezone: true }),
		liftedBy: text("lifted_by"),
	},
	(t) => [
		index("bans_user_open_idx").on(t.userId, t.createdAt.desc()).where(sql`${t.liftedAt} IS NULL`),
		index("bans_expires_idx").on(t.expiresAt).where(sql`${t.liftedAt} IS NULL AND ${t.type} = 'timed'`),
	],
);

/**
 * Device bans (upstream code 28 ACCOUNT_BANNED): sign-up, sign-in and session
 * refresh from this L-Device-Info device id are refused. `user_id` is the
 * account the ban came from ("ban device too"), if any.
 */
export const deviceBans = pgTable(
	"device_bans",
	{
		id: bigserial("id", { mode: "bigint" }).primaryKey(),
		deviceId: text("device_id").notNull(),
		userId: bigint("user_id", { mode: "bigint" }).references(() => users.id, { onDelete: "set null" }),
		note: text("note"),
		createdBy: text("created_by"),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
		liftedAt: timestamp("lifted_at", { withTimezone: true }),
		liftedBy: text("lifted_by"),
	},
	(t) => [uniqueIndex("device_bans_open_uq").on(t.deviceId).where(sql`${t.liftedAt} IS NULL`)],
);

/**
 * Network bans (upstream code 31 SUSPICIOUS_NETWORK): sign-up, sign-in and
 * refresh from an address inside `cidr` are refused, optionally until `expires_at`.
 */
export const networkBans = pgTable(
	"network_bans",
	{
		id: bigserial("id", { mode: "bigint" }).primaryKey(),
		cidr: cidr("cidr").notNull(),
		note: text("note"),
		createdBy: text("created_by"),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
		expiresAt: timestamp("expires_at", { withTimezone: true }),
		liftedAt: timestamp("lifted_at", { withTimezone: true }),
		liftedBy: text("lifted_by"),
	},
	(t) => [index("network_bans_open_idx").using("gist", t.cidr.op("inet_ops")).where(sql`${t.liftedAt} IS NULL`)],
);

export const APPEAL_STATUSES = ["PENDING", "GRANTED", "REJECTED"] as const;

/**
 * Ban appeals: POST /v1|v2/decision-appeal (signed-in, timed bans) and the
 * ban-appeal web page (permanent bans, which can't sign in). GRANTED lifts the ban.
 */
export const banAppeals = pgTable(
	"ban_appeals",
	{
		id: bigserial("id", { mode: "bigint" }).primaryKey(),
		userId: bigint("user_id", { mode: "bigint" })
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		banId: bigint("ban_id", { mode: "bigint" }).references(() => bans.id, { onDelete: "set null" }),
		source: text("source", { enum: ["app", "web"] }).notNull(),
		userEmail: text("user_email"),
		userDevice: text("user_device"),
		userLocation: text("user_location"),
		countryCode: text("country_code"),
		userVpn: boolean("user_vpn"),
		description: text("description"),
		status: text("status", { enum: APPEAL_STATUSES }).notNull().default("PENDING"),
		/** Internal note on the decision, never sent to the user. */
		decisionNote: text("decision_note"),
		decidedBy: text("decided_by"),
		decidedAt: timestamp("decided_at", { withTimezone: true }),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [index("ban_appeals_status_idx").on(t.status, t.id.desc()), index("ban_appeals_user_idx").on(t.userId, t.createdAt.desc())],
);
