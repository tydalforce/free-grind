import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/** AES-256-GCM for secret server settings; key = sha256(APP_SECRET). */
function key(appSecret: string): Buffer {
	return createHash("sha256").update(appSecret).digest();
}

export function encryptSecret(value: unknown, appSecret: string): string {
	const iv = randomBytes(12);
	const cipher = createCipheriv("aes-256-gcm", key(appSecret), iv);
	const data = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
	return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), data.toString("base64url")].join(".");
}

export function decryptSecret(stored: string, appSecret: string): unknown {
	const [version, iv, tag, data] = stored.split(".");
	if (version !== "v1" || !iv || !tag || !data) throw new Error("unsupported secret format");
	const decipher = createDecipheriv("aes-256-gcm", key(appSecret), Buffer.from(iv, "base64url"));
	decipher.setAuthTag(Buffer.from(tag, "base64url"));
	const plain = Buffer.concat([decipher.update(Buffer.from(data, "base64url")), decipher.final()]).toString("utf8");
	return JSON.parse(plain);
}

export function sha256Hex(value: string | Uint8Array): string {
	return createHash("sha256").update(value).digest("hex");
}

export function randomToken(bytes = 32): string {
	return randomBytes(bytes).toString("base64url");
}
