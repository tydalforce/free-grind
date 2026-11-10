import { sql } from "drizzle-orm";
import { bigint, boolean, index, integer, pgTable, primaryKey, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { media } from "./profiles";
import { users } from "./users";

/** Private albums (/v1|v2/albums). `version` bumps on content changes ("unseen content"). */
export const albums = pgTable(
	"albums",
	{
		id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
		ownerId: bigint("owner_id", { mode: "bigint" })
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		name: text("name"),
		version: integer("version").notNull().default(1),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
		updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [index("albums_owner_idx").on(t.ownerId, t.createdAt)],
);

/** Album items; `id` is the upstream contentId. New uploads go first (position ascending). */
export const albumContent = pgTable(
	"album_content",
	{
		id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
		albumId: bigint("album_id", { mode: "number" })
			.notNull()
			.references(() => albums.id, { onDelete: "cascade" }),
		mediaHash: text("media_hash")
			.notNull()
			.references(() => media.hash, { onDelete: "cascade" }),
		position: integer("position").notNull(),
		isFresh: boolean("is_fresh").notNull().default(false),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [uniqueIndex("album_content_album_media_uq").on(t.albumId, t.mediaHash), index("album_content_album_pos_idx").on(t.albumId, t.position)],
);

export const ALBUM_EXPIRATION_TYPES = ["INDEFINITE", "ONCE", "TEN_MINUTES", "ONE_HOUR", "ONE_DAY"] as const;

/**
 * Who an album is shared with. A timed share starts counting at the first
 * view (`firstViewedAt`); `expiresAt` is set then. Unshare deletes the row.
 */
export const albumShares = pgTable(
	"album_shares",
	{
		albumId: bigint("album_id", { mode: "number" })
			.notNull()
			.references(() => albums.id, { onDelete: "cascade" }),
		profileId: bigint("profile_id", { mode: "bigint" })
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		expirationType: text("expiration_type", { enum: ALBUM_EXPIRATION_TYPES }).notNull().default("INDEFINITE"),
		sharedAt: timestamp("shared_at", { withTimezone: true }).notNull().defaultNow(),
		firstViewedAt: timestamp("first_viewed_at", { withTimezone: true }),
		expiresAt: timestamp("expires_at", { withTimezone: true }),
		/** Album version the recipient last opened (hasUnseenContent). */
		seenVersion: integer("seen_version").notNull().default(0),
	},
	(t) => [
		primaryKey({ columns: [t.albumId, t.profileId] }),
		index("album_shares_profile_idx").on(t.profileId, t.sharedAt.desc()),
		index("album_shares_expires_idx").on(t.expiresAt).where(sql`${t.expiresAt} IS NOT NULL`),
	],
);

/** Per-recipient views of single items (POST /v1/albums/{id}/view/content/{cid}). */
export const albumContentViews = pgTable(
	"album_content_views",
	{
		albumId: bigint("album_id", { mode: "number" })
			.notNull()
			.references(() => albums.id, { onDelete: "cascade" }),
		profileId: bigint("profile_id", { mode: "bigint" }).notNull(),
		contentId: bigint("content_id", { mode: "number" }).notNull(),
		views: integer("views").notNull().default(0),
	},
	(t) => [primaryKey({ columns: [t.albumId, t.profileId, t.contentId] })],
);
