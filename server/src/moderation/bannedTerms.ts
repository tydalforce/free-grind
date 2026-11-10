import { getServerSetting } from "../modules/settings/settings";

/**
 * Banned-terms moderation for free-text profile fields (setting `banned_terms`,
 * maintained in the admin UI). Matching is whole-word, ignores case and
 * accents ("Österreich" = "osterreich"), and a `*` at the start or end of a
 * term matches any letters there ("nazi*" also hits "nazis"). Phrases with
 * spaces match across any whitespace. So "ass" does not hit "Klasse".
 */

type Compiled = { term: string; re: RegExp }[];

let cache: { key: string; compiled: Compiled } | null = null;

const WORD = "[\\p{L}\\p{N}]";

export function normalizeText(text: string): string {
	return text.normalize("NFKD").replace(/\p{M}+/gu, "").toLowerCase();
}

function compileTerm(raw: string): { term: string; re: RegExp } | null {
	const term = normalizeText(raw.trim());
	if (!term || term === "*") return null;
	const prefix = term.startsWith("*");
	const suffix = term.endsWith("*");
	const core = term.replace(/^\*|\*$/g, "");
	if (!core) return null;
	const body = core
		.split(/\s+/)
		.map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
		.join("\\s+");
	const pattern = `${prefix ? `${WORD}*` : `(?<!${WORD})`}${body}${suffix ? `${WORD}*` : `(?!${WORD})`}`;
	return { term: raw.trim(), re: new RegExp(pattern, "gu") };
}

export function compileTerms(terms: string[]): Compiled {
	return terms.map(compileTerm).filter((c): c is { term: string; re: RegExp } => !!c);
}

async function compiled(): Promise<Compiled> {
	const terms = (await getServerSetting<string[]>("banned_terms")) ?? [];
	const key = terms.join("\n");
	if (cache?.key !== key) cache = { key, compiled: compileTerms(terms) };
	return cache.compiled;
}

/** The words of `text` that hit a banned term (as written in the text, normalized), de-duplicated. */
export function findIn(text: string, list: Compiled): string[] {
	const normalized = normalizeText(text);
	const hits = new Set<string>();
	for (const { re } of list) {
		re.lastIndex = 0;
		for (const m of normalized.matchAll(re)) hits.add(m[0]);
	}
	return [...hits];
}

export async function findBannedTerms(text: string | null | undefined): Promise<string[]> {
	if (!text) return [];
	const list = await compiled();
	return list.length ? findIn(text, list) : [];
}

/** Upstream BannedTermsResponse fields (display_name, about_me, …) that were hit, or null. */
export async function bannedTermsHits(fields: Record<string, string | null | undefined>): Promise<Record<string, { terms: string[] }> | null> {
	const hits: Record<string, { terms: string[] }> = {};
	for (const [field, text] of Object.entries(fields)) {
		const terms = await findBannedTerms(text);
		if (terms.length) hits[field] = { terms };
	}
	return Object.keys(hits).length ? hits : null;
}
