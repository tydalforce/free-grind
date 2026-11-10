/**
 * Locale fallback chain for localized catalogs (plan 4c):
 * L-Locale "de_AT" → ["de_AT", "de", <default>]. Accept-Language is only
 * consulted when L-Locale is missing (anonymous media/admin routes).
 */
export function localeChain(primary: { language: string; region: string | null } | null, acceptLanguage: string | undefined, defaultLanguage: string): string[] {
	const chain: string[] = [];
	const push = (v: string | null | undefined) => {
		if (v && !chain.includes(v)) chain.push(v);
	};
	if (primary) {
		if (primary.region) push(`${primary.language}_${primary.region}`);
		push(primary.language);
	} else if (acceptLanguage) {
		for (const part of acceptLanguage.split(",")) {
			const tag = part.split(";")[0]!.trim();
			const m = /^([a-zA-Z]{2,3})(?:-([a-zA-Z]{2}|\d{3}))?/.exec(tag);
			if (!m) continue;
			if (m[2]) push(`${m[1]!.toLowerCase()}_${m[2].toUpperCase()}`);
			push(m[1]!.toLowerCase());
		}
	}
	push(defaultLanguage);
	return chain;
}

/** Picks the first translation available along the chain. */
export function pickTranslation<T>(translations: ReadonlyMap<string, T>, chain: readonly string[]): T | undefined {
	for (const loc of chain) {
		const t = translations.get(loc);
		if (t !== undefined) return t;
	}
	return undefined;
}
