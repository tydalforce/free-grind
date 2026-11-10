import { sql } from "drizzle-orm";
import {
	bigint,
	boolean,
	index,
	integer,
	jsonb,
	pgTable,
	primaryKey,
	real,
	smallint,
	text,
	timestamp,
} from "drizzle-orm/pg-core";
import { geographyPoint } from "./types";
import { users } from "./users";

/**
 * Profile + location. Enum-like fields (bodyType, ethnicity, …) are the
 * upstream integer IDs; list fields are integer arrays so grid filters can
 * use GIN `&&` (overlap) lookups.
 */
export const profiles = pgTable(
	"profiles",
	{
		userId: bigint("user_id", { mode: "bigint" })
			.primaryKey()
			.references(() => users.id, { onDelete: "cascade" }),
		displayName: text("display_name"),
		aboutMe: text("about_me"),
		/** Upstream fields without a dedicated column (socialNetworks, identity, …). */
		extra: jsonb("extra").notNull().default({}),

		showAge: boolean("show_age").notNull().default(true),
		showDistance: boolean("show_distance").notNull().default(true),
		showPosition: boolean("show_position").notNull().default(true),
		showTribes: boolean("show_tribes").notNull().default(true),
		nsfw: smallint("nsfw"),
		bodyType: smallint("body_type"),
		ethnicity: smallint("ethnicity"),
		hivStatus: smallint("hiv_status"),
		lastTestedDate: bigint("last_tested_date", { mode: "number" }),
		relationshipStatus: smallint("relationship_status"),
		sexualPosition: smallint("sexual_position"),
		heightCm: real("height_cm"),
		weightGrams: real("weight_grams"),
		genders: smallint("genders").array().notNull().default(sql`'{}'::smallint[]`),
		pronouns: smallint("pronouns").array().notNull().default(sql`'{}'::smallint[]`),
		tribes: smallint("tribes").array().notNull().default(sql`'{}'::smallint[]`),
		tribesImInto: smallint("tribes_im_into").array().notNull().default(sql`'{}'::smallint[]`),
		lookingFor: smallint("looking_for").array().notNull().default(sql`'{}'::smallint[]`),
		meetAt: smallint("meet_at").array().notNull().default(sql`'{}'::smallint[]`),
		vaccines: smallint("vaccines").array().notNull().default(sql`'{}'::smallint[]`),
		sexualHealth: smallint("sexual_health").array().notNull().default(sql`'{}'::smallint[]`),
		profileTags: text("profile_tags").array().notNull().default(sql`'{}'::text[]`),
		/** Favorite Spotify track ids (max 5), shown on the profile. */
		spotifySongIds: text("spotify_song_ids").array().notNull().default(sql`'{}'::text[]`),

		/** Primary photo hash (denormalized from profile_media for the grid). */
		primaryMediaHash: text("primary_media_hash"),
		hasFace: boolean("has_face").notNull().default(false),

		/** Real position — never leaves the server. */
		location: geographyPoint("location"),
		/** Obfuscated position used for every distance/map output (plan 6d). */
		publicLocation: geographyPoint("public_location"),
		geohash: text("geohash"),
		locationUpdatedAt: timestamp("location_updated_at", { withTimezone: true }),
		/** Cell + time the current offset was rolled for (re-roll on change). */
		fuzzCell: text("fuzz_cell"),
		fuzzRolledAt: timestamp("fuzz_rolled_at", { withTimezone: true }),

		/** AUTO | OFF | ON (/v1/visiting/settings). */
		visitingMode: text("visiting_mode", { enum: ["AUTO", "OFF", "ON"] }).notNull().default("AUTO"),
		/** Home for "visiting" detection; only the owner ever reads it back. */
		homeLocation: geographyPoint("home_location"),
		/** Home learned by the server (AUTO without a user-set home); may move after a long stay elsewhere. */
		homeAuto: boolean("home_auto").notNull().default(false),
		/** Where and since when the user has been away from home (learned-home relocation). */
		awayAnchor: geographyPoint("away_anchor"),
		awaySince: timestamp("away_since", { withTimezone: true }),
		/** Derived: shown as visiting (mode ON, or AUTO and far from home). Kept by geo/visiting.ts. */
		isVisiting: boolean("is_visiting").notNull().default(false),
		lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
		onlineUntil: timestamp("online_until", { withTimezone: true }),
		incognito: boolean("incognito").notNull().default(false),
		hideViewedMe: boolean("hide_viewed_me").notNull().default(false),
		locationSearchOptOut: boolean("location_search_opt_out").notNull().default(false),
		viewRightNowNsfw: boolean("view_right_now_nsfw").notNull().default(false),
		showOnMap: boolean("show_on_map").notNull().default(false),
		mapFuzzRadius: integer("map_fuzz_radius"),
		approximateDistance: boolean("approximate_distance").notNull().default(false),
		prepReminderEnabled: boolean("prep_reminder_enabled").notNull().default(false),
		prepReminderTime: text("prep_reminder_time"),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
		updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [
		index("profiles_public_location_gist").using("gist", t.publicLocation),
		index("profiles_geohash_idx").using("btree", sql`${t.geohash} text_pattern_ops`),
		index("profiles_last_seen_idx").on(t.lastSeenAt.desc()),
		index("profiles_online_until_idx").on(t.onlineUntil.desc()).where(sql`${t.incognito} = false`),
		index("profiles_tribes_gin").using("gin", t.tribes),
		index("profiles_looking_for_gin").using("gin", t.lookingFor),
		index("profiles_genders_gin").using("gin", t.genders),
		index("profiles_tags_gin").using("gin", t.profileTags),
	],
);

export const MEDIA_KINDS = ["image", "video", "audio"] as const;
export const MEDIA_STATES = ["processing", "ready", "failed", "deleted"] as const;
export const MEDIA_PURPOSES = ["profile", "chat", "album", "rightnow"] as const;

/**
 * Every uploaded file. `hash` is content-addressed (sha1 of the normalized
 * bytes) like upstream media hashes; variants live under `s3Prefix`.
 */
export const media = pgTable(
	"media",
	{
		hash: text("hash").primaryKey(),
		ownerId: bigint("owner_id", { mode: "bigint" })
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		/** Upstream numeric media id for endpoints that return one. */
		mediaId: bigint("media_id", { mode: "number" }).generatedAlwaysAsIdentity(),
		kind: text("kind", { enum: MEDIA_KINDS }).notNull(),
		purpose: text("purpose", { enum: MEDIA_PURPOSES }).notNull(),
		state: text("state", { enum: MEDIA_STATES }).notNull().default("processing"),
		mime: text("mime").notNull(),
		bytes: bigint("bytes", { mode: "number" }).notNull(),
		width: integer("width"),
		height: integer("height"),
		durationMs: integer("duration_ms"),
		/** For videos: hash of the poster image (itself a `media` row). */
		posterHash: text("poster_hash"),
		/** Square crop for thumbnails: [y2, x1, x2, y1] in source pixels. */
		thumbCoords: jsonb("thumb_coords"),
		takenOnGrindr: boolean("taken_on_grindr").notNull().default(false),
		failureReason: text("failure_reason"),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
		deletedAt: timestamp("deleted_at", { withTimezone: true }),
	},
	(t) => [
		index("media_owner_created_idx").on(t.ownerId, t.createdAt.desc()),
		index("media_processing_idx").on(t.createdAt).where(sql`${t.state} = 'processing'`),
		index("media_media_id_idx").on(t.mediaId),
	],
);

/** Ordered profile media (photos and, as our extension, videos); position 0 = primary. */
export const profileMedia = pgTable(
	"profile_media",
	{
		userId: bigint("user_id", { mode: "bigint" })
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		mediaHash: text("media_hash")
			.notNull()
			.references(() => media.hash, { onDelete: "cascade" }),
		position: smallint("position").notNull(),
	},
	(t) => [primaryKey({ columns: [t.userId, t.mediaHash] }), index("profile_media_user_pos_idx").on(t.userId, t.position)],
);

/** Blocks: owner blocked target. Reverse index answers "who blocked me". */
export const blocks = pgTable(
	"blocks",
	{
		ownerId: bigint("owner_id", { mode: "bigint" })
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		targetId: bigint("target_id", { mode: "bigint" })
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [primaryKey({ columns: [t.ownerId, t.targetId] }), index("blocks_target_idx").on(t.targetId, t.ownerId)],
);

export const hides = pgTable(
	"hides",
	{
		ownerId: bigint("owner_id", { mode: "bigint" })
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		targetId: bigint("target_id", { mode: "bigint" })
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [primaryKey({ columns: [t.ownerId, t.targetId] })],
);

export const favorites = pgTable(
	"favorites",
	{
		ownerId: bigint("owner_id", { mode: "bigint" })
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		targetId: bigint("target_id", { mode: "bigint" })
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		/** Private note + phone number about this favorite (/v1/favorites/notes); gone with the favorite. */
		notes: text("notes"),
		phoneNumber: text("phone_number"),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [primaryKey({ columns: [t.ownerId, t.targetId] }), index("favorites_target_idx").on(t.targetId)],
);

/**
 * Travel plans (/v6/profiles/travel). `geohash` is the destination as the user
 * set it; other profiles only ever see it coarsened (see profiles/travel.ts).
 */
export const travelPlans = pgTable(
	"travel_plans",
	{
		id: bigint("id", { mode: "bigint" }).primaryKey().generatedAlwaysAsIdentity(),
		userId: bigint("user_id", { mode: "bigint" })
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		geohash: text("geohash").notNull(),
		startDate: timestamp("start_date", { withTimezone: true }).notNull(),
		endDate: timestamp("end_date", { withTimezone: true }).notNull(),
		showOnProfile: boolean("show_on_profile").notNull().default(false),
		notes: text("notes"),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
		updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [index("travel_plans_user_end_idx").on(t.userId, t.endDate)],
);

