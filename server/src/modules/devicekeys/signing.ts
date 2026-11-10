import { createHash, createPublicKey, verify } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { localCache } from "../../cache/local";
import { redis } from "../../cache/redis";
import { db } from "../../db/client";
import { deviceKeys } from "../../db/schema";
import { ApiError } from "../../lib/errors";
import { recordSecurityEvent } from "../../lib/securityEvents";

/**
 * Device-key upload signing, byte-for-byte as in
 * docs/content/grindr-api/security-headers.md "Device-key upload signing":
 *  - base64url without padding everywhere
 *  - SHA256withECDSA on P-256, ASN.1 DER signatures
 *  - registration string: userId|keyId|publicKey|androidId|challenge
 *  - upload string:       bodyHash|timestamp|userId|androidId|nonce
 */

export const MAX_CLOCK_DRIFT_MS = 5 * 60_000;
const NONCE_TTL_SECONDS = Math.ceil((MAX_CLOCK_DRIFT_MS * 2) / 1000);

export function b64url(buf: Uint8Array): string {
	return Buffer.from(buf).toString("base64url");
}

export function fromB64url(value: string): Buffer | null {
	if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
	return Buffer.from(value, "base64url");
}

export function keyIdFor(spkiDer: Uint8Array): string {
	return b64url(createHash("sha256").update(spkiDer).digest());
}

/** Verifies a DER ECDSA-P256-SHA256 signature over `message`. */
export function verifyDer(spkiDer: Uint8Array, message: string, signatureDer: Uint8Array): boolean {
	try {
		const key = createPublicKey({ key: Buffer.from(spkiDer), format: "der", type: "spki" });
		if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") return false;
		return verify("sha256", Buffer.from(message, "utf8"), { key, dsaEncoding: "der" }, Buffer.from(signatureDer));
	} catch {
		return false;
	}
}

/** Problem bodies the client's `signing_reject` matches by substring on `type`. */
function signingReject(kind: "timestamp_drift" | "nonce_replayed" | "resource_not_found" | "bad_signature", detail?: string): ApiError {
	return new ApiError(400, { type: `urn:gr:err:${kind}`, title: kind, status: 400, ...(detail ? { detail } : {}) });
}

type KeyRecord = { publicKey: string; userId: bigint; deviceId: string };
const keyCache = localCache<KeyRecord | null>("device-keys", { ttlMs: 60_000, max: 50_000 });

async function loadKey(keyId: string): Promise<KeyRecord | null> {
	return keyCache.getOrLoad(keyId, async () => {
		const [row] = await db.select().from(deviceKeys).where(eq(deviceKeys.keyId, keyId)).limit(1);
		return row ? { publicKey: row.publicKey, userId: row.userId, deviceId: row.deviceId } : null;
	});
}

function header(req: FastifyRequest, name: string): string | undefined {
	const v = req.headers[name];
	return Array.isArray(v) ? v[0] : v;
}

/**
 * Verifies a signed upload. `body` is the exact raw request body.
 * Returns true when the request was signed (and valid), false when it
 * carried no signature headers at all (unsigned legacy endpoints).
 */
export async function verifySignedUpload(req: FastifyRequest, body: Uint8Array, opts: { required: boolean }): Promise<boolean> {
	const keyId = header(req, "x-key-id");
	const sig = header(req, "x-sig");
	const timestamp = header(req, "x-timestamp");
	const nonce = header(req, "x-nonce");
	if (!keyId && !sig && !timestamp && !nonce) {
		if (opts.required) throw signingReject("bad_signature", "missing signature");
		return false;
	}
	const reject = async (kind: Parameters<typeof signingReject>[0], detail?: string): Promise<never> => {
		if (kind === "bad_signature") {
			await recordSecurityEvent("signature_rejected", { userId: req.auth?.profileId, deviceId: req.client.device.deviceId, ip: req.ip, detail: { keyId } });
		}
		throw signingReject(kind, detail);
	};

	if (!keyId || !sig || !timestamp || !nonce || !/^\d{1,16}$/.test(timestamp)) return reject("bad_signature");
	const key = await loadKey(keyId);
	if (!key) return reject("resource_not_found");
	if (key.userId !== req.auth.userId || key.deviceId !== req.client.device.deviceId) return reject("bad_signature");

	const ts = Number(timestamp);
	if (Math.abs(Date.now() - ts) > MAX_CLOCK_DRIFT_MS) return reject("timestamp_drift", new Date().toISOString());

	const sigDer = fromB64url(sig);
	const spki = fromB64url(key.publicKey);
	if (!sigDer || !spki) return reject("bad_signature");
	const bodyHash = b64url(createHash("sha256").update(body).digest());
	const message = `${bodyHash}|${timestamp}|${req.auth.profileId}|${req.client.device.deviceId}|${nonce}`;
	if (!verifyDer(spki, message, sigDer)) return reject("bad_signature");

	// Nonce is consumed only for valid signatures; replay → retryable reject.
	const fresh = await redis.set(`nonce:${keyId}:${nonce}`, "1", "EX", NONCE_TTL_SECONDS, "NX");
	if (fresh !== "OK") return reject("nonce_replayed");
	return true;
}

export async function deleteKeysForDevice(userId: bigint, deviceId: string): Promise<void> {
	const rows = await db
		.delete(deviceKeys)
		.where(and(eq(deviceKeys.userId, userId), eq(deviceKeys.deviceId, deviceId)))
		.returning({ keyId: deviceKeys.keyId });
	for (const r of rows) keyCache.delete(r.keyId);
}
