import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { alignedExpiry, revokeMedia, signMediaUrl, verifyMediaUrl } from "../../src/lib/mediaUrls";
import { localeChain, pickTranslation } from "../../src/lib/locale";

function parse(url: string) {
	const u = new URL(url);
	const [, uploader, hash] = u.pathname.split("/");
	return {
		uploaderProfileId: uploader!,
		mediaHash: hash!,
		expires: u.searchParams.get("Expires") ?? undefined,
		signature: u.searchParams.get("Signature") ?? undefined,
		keyPairId: u.searchParams.get("Key-Pair-Id") ?? undefined,
	};
}

describe("signed media URLs", () => {
	const hash = () => randomBytes(20).toString("hex");

	test("upstream shape; same URL within a window", async () => {
		const now = 1_800_000_000_000;
		const a = await signMediaUrl({ uploaderProfileId: "1", mediaHash: "abc", ttlSeconds: 900, nowMs: now });
		const b = await signMediaUrl({ uploaderProfileId: "1", mediaHash: "abc", ttlSeconds: 900, nowMs: now + 60_000 });
		expect(a.url).toMatch(/\/1\/abc\?Expires=\d+&Signature=[\w-]+&Key-Pair-Id=K[0-9A-F]+$/);
		expect(a.url).toBe(b.url);
		const exp = alignedExpiry(now, 900) * 1000;
		expect(exp - now).toBeGreaterThanOrEqual(900_000);
		expect(exp - now).toBeLessThanOrEqual(1_800_000);
	});

	test("the URL alone grants access until it expires, like upstream", async () => {
		const { url } = await signMediaUrl({ uploaderProfileId: "10", mediaHash: hash(), ttlSeconds: 900 });
		expect(await verifyMediaUrl(parse(url))).toEqual({ ok: true });
	});

	test("expired, tampered and revoked URLs fail", async () => {
		const h = hash();
		const { url } = await signMediaUrl({ uploaderProfileId: "10", mediaHash: h, ttlSeconds: 900 });
		const p = parse(url);
		expect(await verifyMediaUrl({ ...p, nowMs: Date.now() + 3 * 3_600_000 })).toEqual({ ok: false, reason: "expired" });
		expect((await verifyMediaUrl({ ...p, mediaHash: hash() })).ok).toBe(false);
		expect((await verifyMediaUrl({ ...p, expires: String(Number(p.expires) + 900) })).ok).toBe(false);
		await revokeMedia(h, 60);
		expect(await verifyMediaUrl(p)).toEqual({ ok: false, reason: "revoked" });
	});

	test("notAfter caps the expiry (expiring album shares)", async () => {
		const notAfterMs = Date.now() + 60_000;
		const { expiresAt } = await signMediaUrl({ uploaderProfileId: "1", mediaHash: hash(), ttlSeconds: 1800, notAfterMs });
		expect(expiresAt).toBeLessThanOrEqual(notAfterMs);
	});
});

describe("locale chain", () => {
	test("L-Locale with region falls back to language, then default", () => {
		expect(localeChain({ language: "de", region: "AT" }, undefined, "en")).toEqual(["de_AT", "de", "en"]);
	});
	test("Accept-Language when L-Locale is missing", () => {
		expect(localeChain(null, "pt-BR,pt;q=0.9,en;q=0.8", "en")).toEqual(["pt_BR", "pt", "en"]);
	});
	test("pickTranslation walks the chain", () => {
		const t = new Map([["de", "Hallo"], ["en", "Hello"]]);
		expect(pickTranslation(t, ["de_AT", "de", "en"])).toBe("Hallo");
		expect(pickTranslation(t, ["fr", "en"])).toBe("Hello");
	});
});
