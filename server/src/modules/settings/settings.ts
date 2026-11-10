import { eq } from "drizzle-orm";
import { invalidate, localCache } from "../../cache/local";
import { config } from "../../config";
import { db } from "../../db/client";
import { serverSettings } from "../../db/schema";
import { decryptSecret, encryptSecret } from "../../lib/secrets";

/**
 * Global server settings (admin "Server-Einstellungen" + global security
 * values from plan 6a). Every key has a typed default here, so the server
 * works without any configuration.
 */
export const SETTING_DEFAULTS = {
	"client.minAppVersion": "" as string,
	"registration.mode": "open" as "open" | "invite" | "closed",
	"registration.defaultRole": "" as "" | "plus" | "xtra" | "unlimited" | "premium",
	"auth.autoLinkThirdPartyByEmail": false as boolean,
	"map.fuzzRadius.min": 50 as number,
	"map.fuzzRadius.max": 1500 as number,
	"map.fuzzRadius.default": 300 as number,
	"map.fuzz.rotateHours": 168 as number,
	"distance.roundMeters": 100 as number,
	"media.url.chatTtlSec": 900 as number,
	"media.url.albumTtlSec": 1800 as number,
	"media.url.expiringGraceSec": 5 as number,
	"media.retention.expiringDays": 1 as number,
	"locale.default": "en" as string,
	/** Visiting AUTO: farther than this from home counts as visiting. */
	"visiting.autoDistanceKm": 50 as number,
	/** Visiting AUTO: a learned home moves to where the user has stayed this long. */
	"visiting.relocateDays": 30 as number,
	/** Time zone and week start for day/week/month quota windows. */
	"quota.timeZone": "UTC" as string,
	"quota.weekStartsOn": 1 as 0 | 1,
	"banned_terms": [] as string[],
	/** Timed bans require reading + accepting the ban agreement by default (per ban overridable). */
	"bans.requireAgreementDefault": true as boolean,
	/** Legal documents: a version bump makes the app ask users to accept again. Empty URL = served by this server. */
	"legal.termsVersion": "20261110" as string,
	"legal.privacyVersion": "20261110" as string,
	"legal.termsUrl": "" as string,
	"legal.privacyUrl": "" as string,
	"legal.termsText": "PLACEHOLDER – replace in the admin UI (Settings → Legal) with your own Terms of Service before going live." as string,
	"legal.privacyText": "PLACEHOLDER – replace in the admin UI (Settings → Legal) with your own Privacy Policy before going live." as string,
	/** Outgoing mail (password reset, e-mail verification). Defaults reach the local Mailpit container. */
	"smtp.host": "127.0.0.1" as string,
	"smtp.port": 1025 as number,
	"smtp.secure": false as boolean,
	"smtp.user": "" as string,
	"smtp.password": "" as string,
	"smtp.from": "free-grind <no-reply@localhost>" as string,
	/** Monthly partitions older than this are dropped by the worker. */
	"retention.auditLogMonths": 24 as number,
	"retention.securityEventsMonths": 12 as number,
} as const;

export type SettingKey = keyof typeof SETTING_DEFAULTS;

const cache = localCache<unknown>("settings", { ttlMs: 30_000, max: 1000 });

export async function getServerSetting<T>(key: SettingKey | (string & {})): Promise<T | undefined> {
	return (await cache.getOrLoad(key, async () => {
		const [row] = await db.select().from(serverSettings).where(eq(serverSettings.key, key)).limit(1);
		if (!row) return (SETTING_DEFAULTS as Record<string, unknown>)[key];
		if (!row.secret) return row.value;
		try {
			return decryptSecret(row.value as string, config.APP_SECRET);
		} catch {
			// APP_SECRET changed since this was stored. Treat as unset instead of
			// failing every request; callers that own the value (e.g. media
			// signing keys) regenerate it, admins re-enter integration secrets.
			console.warn(`[settings] secret setting "${key}" cannot be decrypted with the current APP_SECRET; treating it as unset`);
			return undefined;
		}
	})) as T | undefined;
}

/** Back to the default (removes the stored value). */
export async function deleteServerSetting(key: string): Promise<void> {
	await db.delete(serverSettings).where(eq(serverSettings.key, key));
	await invalidate("settings", key);
}

export async function setServerSetting(key: string, value: unknown, opts: { secret?: boolean; actor?: string } = {}): Promise<void> {
	const stored = opts.secret ? encryptSecret(value, config.APP_SECRET) : value;
	await db
		.insert(serverSettings)
		.values({ key, value: stored, secret: opts.secret ?? false, updatedBy: opts.actor ?? null })
		.onConflictDoUpdate({
			target: serverSettings.key,
			set: { value: stored, secret: opts.secret ?? false, updatedBy: opts.actor ?? null, updatedAt: new Date() },
		});
	await invalidate("settings", key);
}
