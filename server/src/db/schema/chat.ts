import { sql } from "drizzle-orm";
import { bigint, boolean, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { users } from "./users";

/**
 * Chat (plan phase 3). A conversation is always 1:1; its id is the upstream
 * "<lowerProfileId>:<higherProfileId>". Each participant has a member row with
 * their own view of it (pinned, muted, unread, preview, cleared-at), so the
 * inbox is a single index range scan on (user_id, last_activity_at).
 */
export const conversations = pgTable("conversations", {
	id: text("id").primaryKey(),
	userLow: bigint("user_low", { mode: "bigint" })
		.notNull()
		.references(() => users.id, { onDelete: "cascade" }),
	userHigh: bigint("user_high", { mode: "bigint" })
		.notNull()
		.references(() => users.id, { onDelete: "cascade" }),
	createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
	lastMessageAt: timestamp("last_message_at", { withTimezone: true }),
});

export const conversationMembers = pgTable(
	"conversation_members",
	{
		conversationId: text("conversation_id")
			.notNull()
			.references(() => conversations.id, { onDelete: "cascade" }),
		userId: bigint("user_id", { mode: "bigint" })
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		otherId: bigint("other_id", { mode: "bigint" }).notNull(),
		pinned: boolean("pinned").notNull().default(false),
		muted: boolean("muted").notNull().default(false),
		unreadCount: integer("unread_count").notNull().default(0),
		/** Own read position (ms); the *other* member's value is the sender's "read" label. */
		lastReadAt: bigint("last_read_at", { mode: "number" }),
		/** Null = not in the inbox (no message yet, or deleted on this side). */
		lastActivityAt: timestamp("last_activity_at", { withTimezone: true }),
		/** Last message visible to this member (null after unsend/delete of it). */
		previewMessageId: text("preview_message_id"),
		/** "Delete conversation" on this side: older messages stay hidden for this member. */
		clearedAt: timestamp("cleared_at", { withTimezone: true }),
	},
	(t) => [
		primaryKey({ columns: [t.conversationId, t.userId] }),
		index("conv_members_unread_idx").on(t.lastActivityAt).where(sql`${t.unreadCount} > 0`),
		index("conv_members_other_idx").on(t.otherId),
		index("conv_members_inbox_idx").on(t.userId, t.pinned.desc(), t.lastActivityAt.desc()).where(sql`${t.lastActivityAt} IS NOT NULL`),
	],
);

/**
 * Messages, partitioned by month on created_at (see migration 0012 and
 * db/partitions.ts). `id` is the upstream messageId "<tsMs>:<uuid>" and
 * created_at equals that timestamp, so a lookup by id prunes to one partition.
 */
export const messages = pgTable(
	"messages",
	{
		id: text("id").notNull(),
		conversationId: text("conversation_id").notNull(),
		senderId: bigint("sender_id", { mode: "bigint" }).notNull(),
		recipientId: bigint("recipient_id", { mode: "bigint" }).notNull(),
		type: text("type").notNull(),
		/** Stored body without viewer-specific fields (signed URLs are added per viewer). */
		body: jsonb("body"),
		mediaHash: text("media_hash"),
		replyToId: text("reply_to_id"),
		unsent: boolean("unsent").notNull().default(false),
		reactions: jsonb("reactions").notNull().default([]),
		/** Members who deleted this message on their side. */
		hiddenFor: bigint("hidden_for", { mode: "bigint" }).array().notNull().default(sql`'{}'::bigint[]`),
		/** Expiring media: views the recipient has used. */
		viewsUsed: integer("views_used").notNull().default(0),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
	},
	(t) => [
		primaryKey({ columns: [t.id, t.createdAt] }),
		index("messages_conv_created_idx").on(t.conversationId, t.createdAt.desc()),
		index("messages_sender_created_idx").on(t.senderId, t.createdAt.desc()),
		// Retention checks ("is this file still used by a message?").
		index("messages_media_hash_idx").on(t.mediaHash).where(sql`${t.mediaHash} IS NOT NULL`),
	],
);

/** Chat media drawer (/v4/chat/media/drawer). */
export const chatDrawer = pgTable(
	"chat_drawer",
	{
		ownerId: bigint("owner_id", { mode: "bigint" })
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		mediaHash: text("media_hash").notNull(),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [primaryKey({ columns: [t.ownerId, t.mediaHash] }), index("chat_drawer_owner_created_idx").on(t.ownerId, t.createdAt.desc())],
);

/** Which of my chat media I already sent into which conversation (drawer `used`). */
export const chatMediaUsage = pgTable(
	"chat_media_usage",
	{
		ownerId: bigint("owner_id", { mode: "bigint" })
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		conversationId: text("conversation_id").notNull(),
		mediaHash: text("media_hash").notNull(),
	},
	(t) => [primaryKey({ columns: [t.ownerId, t.conversationId, t.mediaHash] })],
);

/** Saved phrases (/v1/chat/phrases, legacy /v3/me/prefs/phrases). */
export const savedPhrases = pgTable(
	"saved_phrases",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		userId: bigint("user_id", { mode: "bigint" })
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		text: text("text").notNull(),
		frequency: integer("frequency").notNull().default(0),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [index("saved_phrases_user_idx").on(t.userId, t.createdAt)],
);
