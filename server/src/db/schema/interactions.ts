import { sql } from "drizzle-orm";
import { bigint, boolean, doublePrecision, index, integer, jsonb, pgTable, primaryKey, smallint, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { geographyPoint } from "./types";
import { users } from "./users";

/** Taps (/v2/taps/add). One per sender → recipient; re-tapping replaces the type. */
export const taps = pgTable(
	"taps",
	{
		senderId: bigint("sender_id", { mode: "bigint" })
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		recipientId: bigint("recipient_id", { mode: "bigint" })
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		tapType: smallint("tap_type").notNull(),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [primaryKey({ columns: [t.senderId, t.recipientId] }), index("taps_recipient_idx").on(t.recipientId, t.createdAt.desc())],
);

/** Profile views ("Viewed me"); one row per viewer → viewed, latest time kept. */
export const profileViews = pgTable(
	"profile_views",
	{
		viewerId: bigint("viewer_id", { mode: "bigint" })
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		viewedId: bigint("viewed_id", { mode: "bigint" })
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		count: integer("count").notNull().default(1),
		lastViewedAt: timestamp("last_viewed_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [primaryKey({ columns: [t.viewerId, t.viewedId] }), index("profile_views_viewed_idx").on(t.viewedId, t.lastViewedAt.desc())],
);

/** Profile reports (/v3.1|v5/flags/{profileId}); reviewed in the admin UI. */
export const reports = pgTable(
	"reports",
	{
		id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
		reporterId: bigint("reporter_id", { mode: "bigint" })
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		profileId: bigint("profile_id", { mode: "bigint" })
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		reason: text("reason"),
		comment: text("comment"),
		locations: jsonb("locations"),
		context: jsonb("context"),
		status: text("status").notNull().default("PENDING"),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [uniqueIndex("reports_reporter_profile_uq").on(t.reporterId, t.profileId), index("reports_status_idx").on(t.status, t.createdAt.desc())],
);

export const RIGHT_NOW_POST_STATUSES = ["ACTIVE", "HIDDEN", "EXPIRED", "AWAITING_PAYMENT"] as const;

/**
 * Right Now posts. `publicLocation` is the author's obfuscated position plus
 * the post's own displacement (re-rolled on a new locationRadius); the real
 * location never leaves the server.
 */
export const rightNowPosts = pgTable(
	"rightnow_posts",
	{
		id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
		authorId: bigint("author_id", { mode: "bigint" })
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		status: text("status", { enum: RIGHT_NOW_POST_STATUSES }).notNull(),
		text: text("text"),
		hosting: boolean("hosting").notNull().default(false),
		shareLocation: text("share_location", { enum: ["DISTANCE_AND_MAP", "DISTANCE_ONLY", "NONE"] }).notNull().default("NONE"),
		locationRadius: integer("location_radius"),
		/** Offset of the post's map position from the author's public location (meters east/north). */
		offsetEast: doublePrecision("offset_east").notNull().default(0),
		offsetNorth: doublePrecision("offset_north").notNull().default(0),
		/** Where the post was created; the feed lists it near here. */
		anchor: geographyPoint("anchor").notNull(),
		isDiscreet: text("is_discreet", { enum: ["NOT_SELECTED", "FALSE", "TRUE"] }).notNull().default("NOT_SELECTED"),
		sharedFields: text("shared_fields").array().notNull().default(sql`'{}'::text[]`),
		/** Right Now media ids (media.media_id). */
		mediaIds: bigint("media_ids", { mode: "number" }).array().notNull().default(sql`'{}'::bigint[]`),
		posted: timestamp("posted", { withTimezone: true }),
		expiration: timestamp("expiration", { withTimezone: true }),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
		updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [
		index("rightnow_posts_anchor_gist").using("gist", t.anchor).where(sql`${t.status} = 'ACTIVE'`),
		index("rightnow_posts_expiration_idx").on(t.expiration).where(sql`${t.status} IN ('ACTIVE', 'HIDDEN')`),
		index("rightnow_posts_author_idx").on(t.authorId, t.createdAt.desc()),
	],
);

export const rightNowRequests = pgTable(
	"rightnow_requests",
	{
		id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
		postId: bigint("post_id", { mode: "number" })
			.notNull()
			.references(() => rightNowPosts.id, { onDelete: "cascade" }),
		senderId: bigint("sender_id", { mode: "bigint" })
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		status: text("status", { enum: ["PENDING", "ACCEPTED", "REJECTED"] }).notNull().default("PENDING"),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
		updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [uniqueIndex("rightnow_requests_post_sender_uq").on(t.postId, t.senderId), index("rightnow_requests_sender_idx").on(t.senderId, t.createdAt.desc())],
);
