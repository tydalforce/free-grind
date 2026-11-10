import { desc, eq, isNull } from "drizzle-orm";
import { type JWK, type JWTPayload, SignJWT, exportJWK, generateKeyPair, importJWK, jwtVerify, decodeProtectedHeader } from "jose";
import { randomUUID } from "node:crypto";
import { invalidate, localCache } from "../cache/local";
import { config } from "../config";
import { db } from "../db/client";
import { jwtKeys } from "../db/schema";
import { sha256Hex } from "./secrets";

/**
 * Session JWT in the upstream shape (authentication.md "Session ID"):
 * header { kid, alg: RS256, typ: JWT }, payload below. `tv` and `did` are our
 * additions for immediate revocation and device binding; the client ignores
 * unknown claims.
 */
export type SessionClaims = {
	exp: number;
	profileId: string;
	roles: string[];
	features: string[];
	featureFlags: string[];
	experiments: Record<string, string>;
	systemTime: number;
	upsells: Record<string, never>;
	restriction?: "AGE_RESTRICTED" | "TIMED_BAN" | "TRUST_VENDOR_REJECTED" | null;
	restrictionReason?: string | null;
	banDetails?: {
		expiryTime: number | null;
		reason: string | null;
		subReason: string | null;
		isAutomated: boolean;
		isAgreementCompleted: boolean;
	};
	grit: string;
	/** users.token_version at issue time. */
	tv: number;
	/** sha256(deviceId) prefix — device binding. */
	did: string;
};

type KeyRecord = { kid: string; privateKey: CryptoKey | Uint8Array; publicKey: CryptoKey | Uint8Array; publicJwk: JWK };

const keyCache = localCache<{ active: KeyRecord; all: Map<string, KeyRecord> }>("jwt-keys", { ttlMs: 60_000, max: 1 });

async function loadKeys(): Promise<{ active: KeyRecord; all: Map<string, KeyRecord> }> {
	return keyCache.getOrLoad("keys", async () => {
		let rows = await db.select().from(jwtKeys).where(isNull(jwtKeys.retiredAt)).orderBy(desc(jwtKeys.createdAt));
		if (!rows.some((r) => r.active)) {
			await rotateJwtKey();
			rows = await db.select().from(jwtKeys).where(isNull(jwtKeys.retiredAt)).orderBy(desc(jwtKeys.createdAt));
		}
		const all = new Map<string, KeyRecord>();
		let active: KeyRecord | undefined;
		for (const row of rows) {
			const publicJwk = JSON.parse(row.publicJwk) as JWK;
			const rec: KeyRecord = {
				kid: row.kid,
				privateKey: await importJWK(JSON.parse(row.privateJwk) as JWK, "RS256"),
				publicKey: await importJWK(publicJwk, "RS256"),
				publicJwk,
			};
			all.set(row.kid, rec);
			if (row.active && !active) active = rec;
		}
		if (!active) throw new Error("no active JWT key");
		return { active, all };
	});
}

/** Creates a new active key; the previous active key stays valid for verification. */
export async function rotateJwtKey(): Promise<string> {
	const { publicKey, privateKey } = await generateKeyPair("RS256", { modulusLength: 2048, extractable: true });
	const kid = randomUUID();
	const publicJwk = { ...(await exportJWK(publicKey)), kid, alg: "RS256", use: "sig" };
	const privateJwk = { ...(await exportJWK(privateKey)), kid, alg: "RS256" };
	await db.transaction(async (tx) => {
		// Keep only the most recent previous key valid; older ones retire.
		const previous = await tx.select({ kid: jwtKeys.kid }).from(jwtKeys).where(isNull(jwtKeys.retiredAt)).orderBy(desc(jwtKeys.createdAt));
		for (const [i, row] of previous.entries()) {
			if (i >= 1) await tx.update(jwtKeys).set({ retiredAt: new Date(), active: false }).where(eq(jwtKeys.kid, row.kid));
			else await tx.update(jwtKeys).set({ active: false }).where(eq(jwtKeys.kid, row.kid));
		}
		await tx.insert(jwtKeys).values({ kid, privateJwk: JSON.stringify(privateJwk), publicJwk: JSON.stringify(publicJwk), active: true });
	});
	await invalidate("jwt-keys");
	return kid;
}

export function deviceBindingHash(deviceId: string): string {
	return sha256Hex(`did:${deviceId}`).slice(0, 32);
}

export async function signSessionJwt(
	claims: Omit<SessionClaims, "exp" | "systemTime" | "grit" | "upsells">,
	opts: { expCapMs?: number | null } = {},
): Promise<{ token: string; exp: number }> {
	const { active } = await loadKeys();
	const now = Date.now();
	let exp = Math.floor(now / 1000) + config.SESSION_TTL_SECONDS;
	// Never shorter than 60 s, so a ban ending right now doesn't produce an already-expired token.
	if (opts.expCapMs != null) exp = Math.min(exp, Math.max(Math.floor(now / 1000) + 60, Math.ceil(opts.expCapMs / 1000)));
	const payload: SessionClaims = { ...claims, exp, systemTime: now, grit: randomUUID(), upsells: {} };
	const token = await new SignJWT(payload as unknown as JWTPayload)
		.setProtectedHeader({ kid: active.kid, alg: "RS256", typ: "JWT" })
		.sign(active.privateKey);
	return { token, exp };
}

export async function verifySessionJwt(token: string): Promise<SessionClaims | null> {
	try {
		const { kid } = decodeProtectedHeader(token);
		if (!kid) return null;
		const { all } = await loadKeys();
		let key = all.get(kid);
		if (!key) {
			// A key rotated on another instance: reload once.
			keyCache.clear();
			key = (await loadKeys()).all.get(kid);
			if (!key) return null;
		}
		const { payload } = await jwtVerify(token, key.publicKey, { algorithms: ["RS256"] });
		const claims = payload as unknown as SessionClaims;
		if (typeof claims.profileId !== "string" || typeof claims.tv !== "number") return null;
		return claims;
	} catch {
		return null;
	}
}

export async function publicJwks(): Promise<{ keys: JWK[] }> {
	const { all } = await loadKeys();
	return { keys: [...all.values()].map((k) => k.publicJwk) };
}
