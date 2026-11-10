import { inArray, sql } from "drizzle-orm";
import { db } from "../db/client";
import { flags } from "../db/schema";

type Seed = typeof flags.$inferInsert;

/**
 * Flags the client reads today (src/services/assignmentsStore.ts,
 * useFeatureFlag(...)) plus our own pre-login config channel. Inserted once;
 * admins change them afterwards. `locked` ones are forced on every start.
 */
const SEEDS: Seed[] = [
	// No reCAPTCHA on our server, ever.
	{ key: "recaptcha_first_party", type: "FEATURE_FLAG", defaultValue: "off", isPublic: true, locked: true, description: "Kein reCAPTCHA (fest aus)" },
	{ key: "recaptcha_device_key_registration", type: "FEATURE_FLAG", defaultValue: "off", isPublic: true, locked: true, description: "Kein reCAPTCHA (fest aus)" },
	{ key: "right-now-map", type: "FEATURE_FLAG", defaultValue: "on", description: "Right-Now-Kartenansicht" },
	{ key: "right-now-discreet", type: "FEATURE_FLAG", defaultValue: "on", description: "Right Now: diskrete Posts und Chat-Requests" },
	{ key: "right-now-explicit-images", type: "FEATURE_FLAG", defaultValue: "on", description: "Right Now: explizite Bilder erlauben" },
	{ key: "browse-maps-v1_5", type: "FEATURE_FLAG", defaultValue: "on", description: "Grid-Kartenansicht" },
	{ key: "profile_videos", type: "FEATURE_FLAG", defaultValue: "on", description: "Videos als Profilmedien" },
	{ key: "email_verification", type: "FEATURE_FLAG", defaultValue: "off", isPublic: true, description: "E-Mail-Verifizierung statt SMS: off | optional | required (Pflicht sperrt die API bis zur Bestätigung)" },
	{ key: "registration_mode", type: "FEATURE_FLAG", defaultValue: "open", isPublic: true, description: "open | invite | closed" },
	{ key: "oauth_google", type: "FEATURE_FLAG", defaultValue: "off", isPublic: true, description: "Google-Login (Payload aus Integrationen)" },
	{ key: "oauth_facebook", type: "FEATURE_FLAG", defaultValue: "off", isPublic: true, description: "Facebook-Login (Payload aus Integrationen)" },
	{ key: "videocall_provider", type: "FEATURE_FLAG", defaultValue: "livekit", isPublic: false, description: "Videocall-Provider" },
];

/** Flags this server no longer has; removed from existing databases. */
const RETIRED = [
	// FCM client config is compiled into the app now (FG_FCM_*).
	"push_fcm_config",
];

export async function seedFlags(): Promise<void> {
	await db.delete(flags).where(inArray(flags.key, RETIRED));
	await db.insert(flags).values(SEEDS).onConflictDoNothing();
	const locked = SEEDS.filter((s) => s.locked);
	for (const s of locked) {
		await db
			.update(flags)
			.set({ defaultValue: s.defaultValue, isPublic: s.isPublic ?? false, locked: true, enabled: true, updatedAt: sql`now()` })
			.where(sql`${flags.key} = ${s.key}`);
	}
}
