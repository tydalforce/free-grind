import { bigint, bigserial, boolean, index, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { users } from "./users";

/** Accepted Terms of Service / Privacy Policy versions (/v3/me/legal-agreements). */
export const legalAcceptances = pgTable("legal_acceptances", {
	userId: bigint("user_id", { mode: "bigint" })
		.primaryKey()
		.references(() => users.id, { onDelete: "cascade" }),
	termsVersion: text("terms_version"),
	termsAcceptedAt: timestamp("terms_accepted_at", { withTimezone: true }),
	privacyVersion: text("privacy_version"),
	privacyAcceptedAt: timestamp("privacy_accepted_at", { withTimezone: true }),
	consents: text("consents").array().notNull().default([]),
});

/** Community-guideline warnings shown in the app until acknowledged (/v2/warnings). */
export const userWarnings = pgTable(
	"user_warnings",
	{
		id: bigserial("id", { mode: "bigint" }).primaryKey(),
		userId: bigint("user_id", { mode: "bigint" })
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		/** Upstream code, e.g. MILD_INSULTS (BanSubReason values). */
		warning: text("warning").notNull(),
		note: text("note"),
		createdBy: text("created_by"),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
		acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
	},
	(t) => [index("user_warnings_open_idx").on(t.userId, t.acknowledgedAt)],
);

/** Per-category push toggles (/v5/push-settings); null = not set (treated as on). */
export const pushSettings = pgTable("push_settings", {
	userId: bigint("user_id", { mode: "bigint" })
		.primaryKey()
		.references(() => users.id, { onDelete: "cascade" }),
	favoritePushNotification: boolean("favorite_push"),
	tapPushNotification: boolean("tap_push"),
	tappedPushNotification: boolean("tapped_push"),
	mediaRecipientPushNotification: boolean("media_recipient_push"),
	recommendedPushNotification: boolean("recommended_push"),
	unreadChatsPushNotification: boolean("unread_chats_push"),
	viewedProfilePushNotification: boolean("viewed_profile_push"),
	updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
