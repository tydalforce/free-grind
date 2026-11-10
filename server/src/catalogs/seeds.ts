import { sql } from "drizzle-orm";
import { db } from "../db/client";
import { catalogItems, catalogTranslations, type CatalogType } from "../db/schema";

/**
 * Starter lists (own wording, English + German). Inserted once; admins edit,
 * extend and translate them afterwards. Ids are stable — never renumber.
 */
type SeedItem = { type: CatalogType; itemId: number; key?: string; parentId?: number; sort: number; meta?: Record<string, unknown>; en: string; de: string; enExtra?: Record<string, unknown>; deExtra?: Record<string, unknown> };

const GENDERS: [number, string, string, string, string, number][] = [
	// id, en, en plural, de, de plural, displayGroup
	[1, "Man", "Men", "Mann", "Männer", 1],
	[2, "Woman", "Women", "Frau", "Frauen", 1],
	[3, "Trans man", "Trans men", "Trans Mann", "Trans Männer", 2],
	[4, "Trans woman", "Trans women", "Trans Frau", "Trans Frauen", 2],
	[5, "Non-binary", "Non-binary people", "Nicht-binär", "Nicht-binäre Personen", 3],
	[6, "Genderqueer", "Genderqueer people", "Genderqueer", "Genderqueere Personen", 3],
	[7, "Genderfluid", "Genderfluid people", "Genderfluid", "Genderfluide Personen", 3],
	[8, "Agender", "Agender people", "Agender", "Agender Personen", 3],
	[9, "Intersex", "Intersex people", "Inter*", "Inter* Personen", 3],
	[10, "Questioning", "Questioning people", "Unsicher", "Unsichere Personen", 3],
];

const PRONOUNS: [number, string, string][] = [
	[1, "He/Him", "Er/Ihm"],
	[2, "She/Her", "Sie/Ihr"],
	[3, "They/Them", "They/Them"],
	[4, "He/They", "Er/They"],
	[5, "She/They", "Sie/They"],
	[6, "Any pronouns", "Alle Pronomen"],
	[7, "Ask me", "Frag mich"],
];

const TAG_CATEGORIES: [number, string, string, string, string][] = [
	// id, en, en possessive, de, de possessive
	[1, "Interests", "My interests", "Interessen", "Meine Interessen"],
	[2, "Personality", "My personality", "Persönlichkeit", "Meine Persönlichkeit"],
	[3, "Looking for", "What I'm into", "Suche", "Worauf ich stehe"],
];

const TAGS: [number, number, string, string, string][] = [
	// id, category, key, en, de
	[1, 1, "music", "Music", "Musik"],
	[2, 1, "travel", "Travel", "Reisen"],
	[3, 1, "gaming", "Gaming", "Gaming"],
	[4, 1, "fitness", "Fitness", "Fitness"],
	[5, 1, "hiking", "Hiking", "Wandern"],
	[6, 1, "cooking", "Cooking", "Kochen"],
	[7, 1, "movies", "Movies", "Filme"],
	[8, 1, "art", "Art", "Kunst"],
	[9, 2, "chill", "Chill", "Entspannt"],
	[10, 2, "funny", "Funny", "Lustig"],
	[11, 2, "nerdy", "Nerdy", "Nerdig"],
	[12, 2, "outgoing", "Outgoing", "Gesellig"],
	[13, 2, "shy", "Shy", "Schüchtern"],
	[14, 3, "friends", "Friends", "Freundschaft"],
	[15, 3, "dates", "Dates", "Dates"],
	[16, 3, "chat", "Chat", "Chat"],
	[17, 3, "relationship", "Relationship", "Beziehung"],
];

function items(): SeedItem[] {
	return [
		...GENDERS.map(([itemId, en, enPlural, de, dePlural, displayGroup], i) => ({
			type: "gender" as const,
			itemId,
			sort: i,
			meta: { displayGroup, sortFilter: i, sortProfile: i },
			en,
			de,
			enExtra: { plural: enPlural },
			deExtra: { plural: dePlural },
		})),
		...PRONOUNS.map(([itemId, en, de], i) => ({ type: "pronoun" as const, itemId, sort: i, en, de })),
		...TAG_CATEGORIES.map(([itemId, en, enPos, de, dePos], i) => ({
			type: "tag_category" as const,
			itemId,
			sort: i,
			en,
			de,
			enExtra: { possessiveText: enPos },
			deExtra: { possessiveText: dePos },
		})),
		...TAGS.map(([itemId, parentId, key, en, de], i) => ({ type: "tag" as const, itemId, parentId, key, sort: i, en, de })),
	];
}

/** Idempotent: only fills an empty catalog, so admin edits are never overwritten. */
export async function seedCatalogs(): Promise<void> {
	const [{ n }] = (await db.select({ n: sql<number>`count(*)::int` }).from(catalogItems)) as [{ n: number }];
	if (n > 0) return;
	const list = items();
	await db.transaction(async (tx) => {
		await tx.insert(catalogItems).values(
			list.map((i) => ({ type: i.type, itemId: i.itemId, key: i.key ?? null, parentId: i.parentId ?? null, sort: i.sort, meta: i.meta ?? {} })),
		);
		await tx.insert(catalogTranslations).values(
			list.flatMap((i) => [
				{ type: i.type, itemId: i.itemId, locale: "en", label: i.en, extra: i.enExtra ?? {} },
				{ type: i.type, itemId: i.itemId, locale: "de", label: i.de, extra: i.deExtra ?? {} },
			]),
		);
	});
}
