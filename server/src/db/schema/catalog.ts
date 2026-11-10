import { boolean, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

/**
 * Localized option lists the client reads (plan 4c):
 *  - gender       → GET /public/v2/genders (+ v1)   ids stored in profiles.genders
 *  - pronoun      → GET /v1/pronouns                ids stored in profiles.pronouns
 *  - tag_category → GET /v1/tags (categoryCollection)
 *  - tag          → GET /v1/tags (tags[], `key` stored in profiles.profile_tags)
 * Ids are stable per type: once a profile references one it must keep its meaning,
 * so items are deactivated, never renumbered.
 */
export const CATALOG_TYPES = ["gender", "pronoun", "tag_category", "tag"] as const;
export type CatalogType = (typeof CATALOG_TYPES)[number];

export const catalogItems = pgTable(
	"catalog_items",
	{
		type: text("type", { enum: CATALOG_TYPES }).notNull(),
		itemId: integer("item_id").notNull(),
		/** Tags: the stable key profiles store. */
		key: text("key"),
		/** Tags: their category's item_id. */
		parentId: integer("parent_id"),
		sort: integer("sort").notNull().default(0),
		active: boolean("active").notNull().default(true),
		/** Genders: displayGroup, sortFilter, sortProfile, excludeOn*Selection. */
		meta: jsonb("meta").notNull().default({}),
		updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [primaryKey({ columns: [t.type, t.itemId] }), uniqueIndex("catalog_items_tag_key_uq").on(t.type, t.key)],
);

export const catalogTranslations = pgTable(
	"catalog_translations",
	{
		type: text("type", { enum: CATALOG_TYPES }).notNull(),
		itemId: integer("item_id").notNull(),
		/** "en", "de", "de_AT", … */
		locale: text("locale").notNull(),
		label: text("label").notNull(),
		/** Genders: genderPlural. Tag categories: possessiveText. */
		extra: jsonb("extra").notNull().default({}),
		updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [primaryKey({ columns: [t.type, t.itemId, t.locale] })],
);
