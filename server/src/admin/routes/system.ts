import { desc, lt, sql } from "drizzle-orm";
import { compileTerms, findIn } from "../../moderation/bannedTerms";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { redis } from "../../cache/redis";
import { db, dbRead } from "../../db/client";
import { adminAuditLog, serverSettings } from "../../db/schema";
import { ApiError } from "../../lib/errors";
import { SETTING_DEFAULTS, getServerSetting, setServerSetting } from "../../modules/settings/settings";
import { audit } from "../audit";
import { sendMail } from "../../lib/mailer";

/** Stored encrypted; the UI only learns whether they are set, the audit log never sees them. */
const SECRET_SETTINGS = new Set(["smtp.password"]);

/** Settings the admin UI may edit, with validators. Secret/internal ones (signing keys) are excluded. */
const EDITABLE: Record<string, z.ZodTypeAny> = {
	"client.minAppVersion": z.string().regex(/^(\d+(\.\d+){0,3})?$/),
	"registration.mode": z.enum(["open", "invite", "closed"]),
	"registration.defaultRole": z.enum(["", "plus", "xtra", "unlimited", "premium"]),
	"auth.autoLinkThirdPartyByEmail": z.boolean(),
	"map.fuzzRadius.min": z.number().int().min(0).max(10_000),
	"map.fuzzRadius.max": z.number().int().min(0).max(50_000),
	"map.fuzzRadius.default": z.number().int().min(0).max(50_000),
	"map.fuzz.rotateHours": z.number().int().min(1).max(24 * 365),
	"distance.roundMeters": z.number().int().min(1).max(10_000),
	"media.url.chatTtlSec": z.number().int().min(60).max(86_400),
	"media.url.albumTtlSec": z.number().int().min(60).max(86_400),
	"media.url.expiringGraceSec": z.number().int().min(0).max(300),
	"media.retention.expiringDays": z.number().int().min(0).max(3650),
	"locale.default": z.string().regex(/^[a-z]{2,3}(_[A-Z]{2})?$/),
	"visiting.autoDistanceKm": z.number().int().min(1).max(5000),
	"visiting.relocateDays": z.number().int().min(1).max(3650),
	"quota.timeZone": z.string().refine((tz) => {
		try {
			new Intl.DateTimeFormat("en", { timeZone: tz });
			return true;
		} catch {
			return false;
		}
	}, "unknown time zone"),
	"quota.weekStartsOn": z.union([z.literal(0), z.literal(1)]),
	banned_terms: z.array(z.string().min(1).max(100)).max(5000),
	"bans.requireAgreementDefault": z.boolean(),
	"legal.termsVersion": z.string().regex(/^[w.-]{1,40}$/),
	"legal.privacyVersion": z.string().regex(/^[w.-]{1,40}$/),
	"legal.termsUrl": z.union([z.literal(""), z.string().url().max(500)]),
	"legal.privacyUrl": z.union([z.literal(""), z.string().url().max(500)]),
	"legal.termsText": z.string().max(200_000),
	"legal.privacyText": z.string().max(200_000),
	"smtp.host": z.string().max(255),
	"smtp.port": z.number().int().min(1).max(65_535),
	"smtp.secure": z.boolean(),
	"smtp.user": z.string().max(255),
	"smtp.password": z.string().max(500),
	"smtp.from": z.string().max(255),
	"retention.auditLogMonths": z.number().int().min(1).max(240),
	"retention.securityEventsMonths": z.number().int().min(1).max(240),
};

export async function adminSystemRoutes(app: FastifyInstance): Promise<void> {
	app.get("/admin/api/settings", { preHandler: app.requireAdmin }, async () => {
		const out: Record<string, { value: unknown; default: unknown }> = {};
		for (const key of Object.keys(EDITABLE)) {
			const value = await getServerSetting(key);
			out[key] = SECRET_SETTINGS.has(key)
				? { value: "", default: "", isSet: typeof value === "string" && value.length > 0 } as { value: unknown; default: unknown }
				: { value, default: (SETTING_DEFAULTS as Record<string, unknown>)[key] };
		}
		return { settings: out };
	});

	app.put("/admin/api/settings/:key", { preHandler: app.requireOwner }, async (req) => {
		const { key } = req.params as { key: string };
		const schema = EDITABLE[key];
		if (!schema) throw new ApiError(404, { error: "unknown_setting" });
		const parsed = schema.safeParse((req.body as { value?: unknown })?.value);
		if (!parsed.success) throw new ApiError(400, { error: "invalid_value", detail: parsed.error.issues[0]?.message });
		if (SECRET_SETTINGS.has(key)) {
			await setServerSetting(key, parsed.data, { actor: req.admin.username, secret: true });
			await audit(req.admin, "setting.set_secret", key, null, { changed: true });
			return { ok: true };
		}
		const before = await getServerSetting(key);
		await setServerSetting(key, parsed.data, { actor: req.admin.username });
		await audit(req.admin, "setting.set", key, before, parsed.data);
		return { ok: true };
	});

	/** Tries a text against the banned terms (the saved list, or a draft list). */
	app.post("/admin/api/moderation/banned-terms/test", { preHandler: app.requireAdmin }, async (req) => {
		const body = z.object({ text: z.string().max(5000), terms: z.array(z.string().max(100)).max(5000).optional() }).safeParse(req.body);
		if (!body.success) throw new ApiError(400, { error: "invalid_body" });
		const list = compileTerms(body.data.terms ?? ((await getServerSetting<string[]>("banned_terms")) ?? []));
		return { hits: findIn(body.data.text, list) };
	});

	app.post("/admin/api/settings/smtp/test", { preHandler: app.requireOwner }, async (req) => {
		const body = z.object({ to: z.string().email() }).safeParse(req.body);
		if (!body.success) throw new ApiError(400, { error: "invalid_email" });
		try {
			await sendMail({ to: body.data.to, subject: "free-grind-server test mail", text: "SMTP works." });
		} catch (e) {
			throw new ApiError(502, { error: "smtp_failed", detail: (e as Error).message });
		}
		return { ok: true };
	});

	app.get("/admin/api/audit", { preHandler: app.requireAdmin }, async (req) => {
		const q = z.object({ before: z.string().regex(/^\d+$/).optional(), limit: z.coerce.number().int().min(1).max(200).default(100) }).parse(req.query);
		const rows = await dbRead
			.select()
			.from(adminAuditLog)
			.where(q.before ? lt(adminAuditLog.id, BigInt(q.before)) : undefined)
			.orderBy(desc(adminAuditLog.id))
			.limit(q.limit);
		return { entries: rows, next: rows.length === q.limit ? String(rows[rows.length - 1]!.id) : null };
	});

	/** Cheap dashboard numbers: estimates from pg_class / indexed counts, cached 30 s. */
	app.get("/admin/api/stats", { preHandler: app.requireAdmin }, async () => {
		const cached = await redis.get("admin:stats");
		if (cached) return JSON.parse(cached);
		const [users] = await dbRead.execute(sql`SELECT reltuples::bigint AS estimate FROM pg_class WHERE relname = 'users'`);
		const [signups] = await dbRead.execute(sql`SELECT count(*)::int AS n FROM users WHERE created_at > now() - interval '24 hours'`);
		const [active] = await dbRead.execute(sql`SELECT count(*)::int AS n FROM profiles WHERE last_seen_at > now() - interval '15 minutes'`);
		const [settings] = await db.select({ n: sql<number>`count(*)::int` }).from(serverSettings);
		const stats = {
			usersEstimate: Number((users as { estimate?: number })?.estimate ?? 0),
			signups24h: Number((signups as { n?: number })?.n ?? 0),
			activeNow: Number((active as { n?: number })?.n ?? 0),
			customSettings: settings?.n ?? 0,
			generatedAt: Date.now(),
		};
		await redis.set("admin:stats", JSON.stringify(stats), "EX", 30);
		return stats;
	});
}
