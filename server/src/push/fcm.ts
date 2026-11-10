import { SignJWT, importPKCS8 } from "jose";
import { z } from "zod";
import { config } from "../config";
import { getServerSetting } from "../modules/settings/settings";

/**
 * FCM HTTP v1 sender. Credentials come from the Firebase service account JSON
 * stored (encrypted) in the admin integration `push.fcm.serviceAccount`.
 * Only the worker sends; API instances enqueue (push/notify.ts).
 */

export const serviceAccountSchema = z.object({
	type: z.literal("service_account").optional(),
	project_id: z.string().min(1),
	client_email: z.string().email(),
	private_key: z.string().includes("PRIVATE KEY"),
	token_uri: z.string().url().default("https://oauth2.googleapis.com/token"),
});
export type ServiceAccount = z.infer<typeof serviceAccountSchema>;

export async function loadServiceAccount(): Promise<ServiceAccount | null> {
	const raw = await getServerSetting<unknown>("push.fcm.serviceAccount");
	if (!raw) return null;
	const parsed = serviceAccountSchema.safeParse(typeof raw === "string" ? safeJson(raw) : raw);
	return parsed.success ? parsed.data : null;
}

function safeJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

let tokenCache: { email: string; token: string; expiresAt: number } | null = null;

async function accessToken(sa: ServiceAccount): Promise<string> {
	if (tokenCache && tokenCache.email === sa.client_email && tokenCache.expiresAt > Date.now() + 60_000) return tokenCache.token;
	const key = await importPKCS8(sa.private_key, "RS256");
	const now = Math.floor(Date.now() / 1000);
	const assertion = await new SignJWT({ scope: "https://www.googleapis.com/auth/firebase.messaging" })
		.setProtectedHeader({ alg: "RS256", typ: "JWT" })
		.setIssuer(sa.client_email)
		.setAudience(sa.token_uri)
		.setIssuedAt(now)
		.setExpirationTime(now + 3600)
		.sign(key);
	const res = await fetch(sa.token_uri, {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
	});
	if (!res.ok) throw new Error(`FCM auth failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
	const body = (await res.json()) as { access_token: string; expires_in?: number };
	tokenCache = { email: sa.client_email, token: body.access_token, expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000 };
	return body.access_token;
}

export type SendResult = { ok: true } | { ok: false; invalidToken: boolean; error: string };

/** Sends one data-only message (every value a string, upstream V2 envelope). */
export async function sendToToken(sa: ServiceAccount, token: string, data: Record<string, string>): Promise<SendResult> {
	const res = await fetch(`${process.env.FCM_API_BASE || config.FCM_API_BASE}/v1/projects/${encodeURIComponent(sa.project_id)}/messages:send`, {
		method: "POST",
		headers: { authorization: `Bearer ${await accessToken(sa)}`, "content-type": "application/json" },
		body: JSON.stringify({ message: { token, data, android: { priority: "HIGH", ttl: "86400s" } } }),
	});
	if (res.ok) return { ok: true };
	const text = await res.text();
	if (res.status === 401) tokenCache = null;
	// Token no longer valid for this app → drop it (UNREGISTERED, or a malformed token).
	const invalidToken = res.status === 404 || /UNREGISTERED|registration-token-not-registered|INVALID_ARGUMENT.*token|SENDER_ID_MISMATCH/i.test(text);
	return { ok: false, invalidToken, error: `${res.status} ${text.slice(0, 300)}` };
}
