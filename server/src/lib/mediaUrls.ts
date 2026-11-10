import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { redis } from "../cache/redis";
import { localCache } from "../cache/local";
import { config } from "../config";
import { getServerSetting, setServerSetting } from "../modules/settings/settings";
import { mediaBase } from "./publicUrls";

/**
 * Signed private-media URLs exactly in the upstream CloudFront shape (plan 4b):
 *   {PUBLIC_MEDIA_URL}/{uploaderProfileId}/{mediaHash}?Expires=<unix s>&Signature=<sig>&Key-Pair-Id=<kid>
 *
 * Like upstream, the URL alone grants access until it expires (chat 15 min,
 * album 30 min); a fresh one is issued with every API response. Deleted media
 * is additionally revoked at once (Redis lookup on every fetch).
 *
 * Expiry is window-aligned so API responses repeat the same URL until it
 * expires, which keeps client caches warm.
 */

export const MEDIA_VARIANTS = ["thumb", "blur"] as const;
export type MediaVariant = (typeof MEDIA_VARIANTS)[number];

type SigningKey = { kid: string; secret: Buffer };
type KeySet = { active: SigningKey; all: Map<string, SigningKey> };

const keyCache = localCache<KeySet>("media-keys", { ttlMs: 60_000, max: 1 });

async function loadKeys(): Promise<KeySet> {
	return keyCache.getOrLoad("keys", async () => {
		let stored = await getServerSetting<{ active: string; keys: Record<string, string> }>("media.signingKeys");
		if (!stored) {
			stored = await rotateMediaSigningKey();
		}
		const all = new Map<string, SigningKey>();
		for (const [kid, secret] of Object.entries(stored.keys)) all.set(kid, { kid, secret: Buffer.from(secret, "base64url") });
		const active = all.get(stored.active);
		if (!active) throw new Error("no active media signing key");
		return { active, all };
	});
}

/** New active key; the previous one stays valid until its URLs have expired. */
export async function rotateMediaSigningKey(): Promise<{ active: string; keys: Record<string, string> }> {
	const current = await getServerSetting<{ active: string; keys: Record<string, string> }>("media.signingKeys");
	const kid = `K${randomBytes(6).toString("hex").toUpperCase()}`;
	const keys: Record<string, string> = { [kid]: randomBytes(32).toString("base64url") };
	if (current) keys[current.active] = current.keys[current.active]!;
	const next = { active: kid, keys };
	await setServerSetting("media.signingKeys", next, { secret: true, actor: "system" });
	keyCache.clear();
	return next;
}

function signature(key: SigningKey, path: string, expires: number): string {
	return createHmac("sha256", key.secret).update(`${path}|${expires}`).digest("base64url");
}

export function alignedExpiry(nowMs: number, ttlSeconds: number): number {
	const now = Math.floor(nowMs / 1000);
	// Valid for at least ttl and at most 2×ttl; identical within one window.
	return (Math.floor(now / ttlSeconds) + 2) * ttlSeconds;
}

export async function signMediaUrl(opts: {
	uploaderProfileId: string;
	mediaHash: string;
	/** Derived file of the same media: unblurred preview or blurred cover (albums). */
	variant?: MediaVariant;
	ttlSeconds: number;
	/** Hard cap, e.g. an expiring album share that ends sooner. */
	notAfterMs?: number;
	nowMs?: number;
}): Promise<{ url: string; expiresAt: number }> {
	const { active } = await loadKeys();
	let expires = alignedExpiry(opts.nowMs ?? Date.now(), opts.ttlSeconds);
	if (opts.notAfterMs != null) expires = Math.min(expires, Math.floor(opts.notAfterMs / 1000));
	const path = `${opts.uploaderProfileId}/${opts.mediaHash}${opts.variant ? `/${opts.variant}` : ""}`;
	const sig = signature(active, path, expires);
	const url = `${mediaBase()}/${path}?Expires=${expires}&Signature=${sig}&Key-Pair-Id=${active.kid}`;
	return { url, expiresAt: expires * 1000 };
}

export type MediaUrlCheck = { ok: true } | { ok: false; reason: "expired" | "bad_signature" | "unknown_key" | "revoked" };

export async function verifyMediaUrl(opts: {
	uploaderProfileId: string;
	mediaHash: string;
	variant?: MediaVariant;
	expires: string | undefined;
	signature: string | undefined;
	keyPairId: string | undefined;
	nowMs?: number;
}): Promise<MediaUrlCheck> {
	if (!opts.expires || !opts.signature || !opts.keyPairId || !/^\d{1,12}$/.test(opts.expires)) return { ok: false, reason: "bad_signature" };
	const expires = Number(opts.expires);
	if (expires * 1000 <= (opts.nowMs ?? Date.now())) return { ok: false, reason: "expired" };
	const { all } = await loadKeys();
	const key = all.get(opts.keyPairId);
	if (!key) return { ok: false, reason: "unknown_key" };
	const expected = Buffer.from(signature(key, `${opts.uploaderProfileId}/${opts.mediaHash}${opts.variant ? `/${opts.variant}` : ""}`, expires));
	const given = Buffer.from(opts.signature);
	if (expected.length !== given.length || !timingSafeEqual(expected, given)) return { ok: false, reason: "bad_signature" };
	if (await isRevoked(opts.mediaHash)) return { ok: false, reason: "revoked" };
	return { ok: true };
}

// --- Revocation ---------------------------------------------------------------

const revKey = (hash: string) => `mrev:${hash}`;

/** Deleted media stops working at once, even for URLs that haven't expired yet. */
export async function revokeMedia(mediaHash: string, ttlSeconds = 2 * 86_400): Promise<void> {
	await redis.set(revKey(mediaHash), "1", "EX", ttlSeconds);
}

export async function isRevoked(mediaHash: string): Promise<boolean> {
	return (await redis.exists(revKey(mediaHash))) === 1;
}
