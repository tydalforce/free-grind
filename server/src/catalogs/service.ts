import { createHash } from "node:crypto";
import { asc } from "drizzle-orm";
import { localCache } from "../cache/local";
import { db } from "../db/client";
import { catalogItems, catalogTranslations, type CatalogType } from "../db/schema";
import { pickTranslation } from "../lib/locale";

export type CatalogItem = {
	type: CatalogType;
	itemId: number;
	key: string | null;
	parentId: number | null;
	sort: number;
	active: boolean;
	meta: Record<string, unknown>;
	/** locale → { label, extra } */
	translations: Map<string, { label: string; extra: Record<string, unknown> }>;
};

const cache = localCache<CatalogItem[]>("catalogs", { ttlMs: 5 * 60_000, max: 1 });

/** Whole catalog (small) cached per instance; admin edits invalidate it cluster-wide. */
export async function loadCatalog(): Promise<CatalogItem[]> {
	return cache.getOrLoad("all", async () => {
		const [items, translations] = await Promise.all([
			db.select().from(catalogItems).orderBy(asc(catalogItems.type), asc(catalogItems.sort), asc(catalogItems.itemId)),
			db.select().from(catalogTranslations),
		]);
		const byItem = new Map<string, CatalogItem["translations"]>();
		for (const t of translations) {
			const k = `${t.type}:${t.itemId}`;
			const m = byItem.get(k) ?? new Map();
			m.set(t.locale, { label: t.label, extra: (t.extra as Record<string, unknown>) ?? {} });
			byItem.set(k, m);
		}
		return items.map((i) => ({
			type: i.type,
			itemId: i.itemId,
			key: i.key,
			parentId: i.parentId,
			sort: i.sort,
			active: i.active,
			meta: (i.meta as Record<string, unknown>) ?? {},
			translations: byItem.get(`${i.type}:${i.itemId}`) ?? new Map(),
		}));
	});
}

function label(item: CatalogItem, chain: readonly string[]) {
	return pickTranslation(item.translations, chain) ?? [...item.translations.values()][0] ?? { label: item.key ?? String(item.itemId), extra: {} };
}

const num = (v: unknown) => (typeof v === "number" ? v : null);
const nums = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is number => typeof x === "number") : null);

/** GET /public/v2/genders — Gender objects in the caller's language. */
export function serializeGenders(items: CatalogItem[], chain: readonly string[]) {
	return items
		.filter((i) => i.type === "gender" && i.active)
		.map((i) => {
			const t = label(i, chain);
			return {
				genderId: i.itemId,
				gender: t.label,
				genderPlural: typeof t.extra.plural === "string" ? t.extra.plural : null,
				displayGroup: num(i.meta.displayGroup) ?? 0,
				sortProfile: num(i.meta.sortProfile),
				sortFilter: num(i.meta.sortFilter),
				excludeOnProfileSelection: nums(i.meta.excludeOnProfileSelection),
				excludeOnFilterSelection: nums(i.meta.excludeOnFilterSelection),
			};
		});
}

/** GET /v1/pronouns */
export function serializePronouns(items: CatalogItem[], chain: readonly string[]) {
	return items.filter((i) => i.type === "pronoun" && i.active).map((i) => ({ pronounId: i.itemId, pronoun: label(i, chain).label }));
}

/** Every locale that has at least one translation. */
export function catalogLocales(items: CatalogItem[]): string[] {
	const set = new Set<string>();
	for (const i of items) for (const l of i.translations.keys()) set.add(l);
	return [...set].sort();
}

/**
 * GET /v1/tags — one entry per language (the client picks the closest one);
 * each language falls back along its own chain for missing translations.
 */
export function serializeTags(items: CatalogItem[], defaultLocale: string) {
	const categories = items.filter((i) => i.type === "tag_category" && i.active);
	const tags = items.filter((i) => i.type === "tag" && i.active);
	return catalogLocales(items).map((locale) => {
		const chain = [...new Set([locale, locale.split("_")[0]!, defaultLocale])];
		return {
			language: locale,
			categoryCollection: categories.map((c) => {
				const ct = label(c, chain);
				return {
					text: ct.label,
					possessiveText: typeof ct.extra.possessiveText === "string" ? ct.extra.possessiveText : null,
					tags: tags.filter((t) => t.parentId === c.itemId).map((t) => ({ tagId: t.itemId, text: label(t, chain).label, key: t.key ?? String(t.itemId) })),
				};
			}),
		};
	});
}

export function etagOf(value: unknown): string {
	return `"${createHash("sha1").update(JSON.stringify(value)).digest("base64url").slice(0, 22)}"`;
}

/** For profile validation: active ids/keys per type. */
export async function activeCatalogIds(): Promise<{ genders: Set<number>; pronouns: Set<number>; tagKeys: Set<string> }> {
	const items = await loadCatalog();
	return {
		genders: new Set(items.filter((i) => i.type === "gender" && i.active).map((i) => i.itemId)),
		pronouns: new Set(items.filter((i) => i.type === "pronoun" && i.active).map((i) => i.itemId)),
		tagKeys: new Set(items.filter((i) => i.type === "tag" && i.active && i.key).map((i) => i.key!)),
	};
}
