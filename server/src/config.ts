import { z } from "zod";

const bool = z
	.string()
	.optional()
	.transform((v) => v == null || v === "" ? undefined : ["1", "true", "yes", "on"].includes(v.toLowerCase()));

const schema = z.object({
	NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
	PORT: z.coerce.number().int().default(8080),
	PUBLIC_API_URL: z.string().url().default("http://localhost:8080"),
	/** Unset or "auto": media links follow the host of each request (dev); production sets the media domain. */
	PUBLIC_MEDIA_URL: z
		.string()
		.optional()
		.transform((v) => (!v || v === "auto" ? undefined : v.replace(/\/$/, "")))
		.pipe(z.string().url().optional()),
	APP_SECRET: z.string().min(16).default("dev-only-secret-change-me"),
	DATABASE_URL: z.string().default("postgres://freegrind:freegrind@localhost:5432/freegrind"),
	DATABASE_READ_URL: z.string().optional().transform((v) => (v ? v : undefined)),
	DATABASE_MIGRATION_URL: z.string().optional().transform((v) => (v ? v : undefined)),
	REDIS_URL: z.string().default("redis://localhost:6379"),
	/** FCM HTTP v1 base URL (tests point it at a local fake). */
	FCM_API_BASE: z.string().url().default("https://fcm.googleapis.com"),
	SESSION_TTL_SECONDS: z.coerce.number().int().min(60).default(1800),
	ENFORCE_SECURITY_HEADERS: bool,
	ENFORCE_DEVICE_BINDING: bool,
});

const parsed = schema.parse(process.env);

const PLACEHOLDER_SECRETS = new Set(["dev-only-secret-change-me", "change-me-to-a-long-random-string"]);
if (parsed.NODE_ENV === "production" && (PLACEHOLDER_SECRETS.has(parsed.APP_SECRET) || parsed.APP_SECRET.length < 32)) {
	// Secrets (integration keys, media signing keys, TOTP) are encrypted with it.
	throw new Error("APP_SECRET must be set to a random value of at least 32 characters in production (e.g. `openssl rand -base64 48`).");
}

export const config = {
	...parsed,
	isProd: parsed.NODE_ENV === "production",
	isTest: parsed.NODE_ENV === "test",
	enforceSecurityHeaders: parsed.ENFORCE_SECURITY_HEADERS ?? true,
	enforceDeviceBinding: parsed.ENFORCE_DEVICE_BINDING ?? true,
	databaseReadUrl: parsed.DATABASE_READ_URL ?? parsed.DATABASE_URL,
	databaseMigrationUrl: parsed.DATABASE_MIGRATION_URL ?? parsed.DATABASE_URL,
};

export type Config = typeof config;
