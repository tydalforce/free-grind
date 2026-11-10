import { and, eq, isNull, sql } from "drizzle-orm";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { redis } from "../../cache/redis";
import { config } from "../../config";
import { db } from "../../db/client";
import { authTokens, legalAcceptances, profiles, userWarnings, users } from "../../db/schema";
import { errors } from "../../lib/errors";
import { sendMail } from "../../lib/mailer";
import { enforceRateLimit } from "../../lib/rateLimit";
import { randomToken, sha256Hex } from "../../lib/secrets";
import { invalidateProfileCard } from "../../profiles/cards";
import { bumpTokenVersion } from "../auth/sessions";
import { recomputeVisiting, setHome } from "../../geo/visiting";
import { getServerSetting } from "../settings/settings";

const RESET_TTL_SECONDS = 3600;
const PASSWORD_OPTS = { algorithm: "argon2id", memoryCost: 19456, timeCost: 2 } as const;
const PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";

export function escapeHtml(s: string): string {
	return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** Minimal dark page for the browser-facing flows (reset password, legal texts). */
export function page(reply: FastifyReply, title: string, bodyHtml: string, status = 200) {
	return reply
		.code(status)
		.header("content-type", "text/html; charset=utf-8")
		.header("content-security-policy", PAGE_CSP)
		.header("x-frame-options", "DENY")
		.header("referrer-policy", "no-referrer")
		.header("cache-control", "no-store")
		.send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${escapeHtml(title)}</title>
<style>:root{color-scheme:dark}body{margin:0;background:#0b0d12;color:#e6e8ee;font:15px/1.55 system-ui,sans-serif}main{max-width:640px;margin:0 auto;padding:32px 16px}h1{font-size:20px}input,textarea{width:100%;box-sizing:border-box;margin:6px 0 14px;padding:10px;border-radius:8px;border:1px solid #262b36;background:#1a1e27;color:inherit}button{padding:10px 16px;border:0;border-radius:8px;background:#f5a524;color:#111;font-weight:600}pre{white-space:pre-wrap;font:inherit}.muted{color:#8b93a7}</style></head><body><main>${bodyHtml}</main></body></html>`);
}

async function legalInfo() {
	const base = config.PUBLIC_API_URL.replace(/\/$/, "");
	const [termsVersion, privacyVersion, termsUrl, privacyUrl] = await Promise.all([
		getServerSetting<string>("legal.termsVersion"),
		getServerSetting<string>("legal.privacyVersion"),
		getServerSetting<string>("legal.termsUrl"),
		getServerSetting<string>("legal.privacyUrl"),
	]);
	return {
		termsOfServiceUrl: termsUrl || `${base}/legal/terms`,
		latestTermsOfServiceVersion: termsVersion ?? "1",
		privacyPolicyUrl: privacyUrl || `${base}/legal/privacy`,
		latestPrivacyPolicyVersion: privacyVersion ?? "1",
	};
}

const RESET_KEY = (hash: string) => `pwreset:${hash}`;
const RESET_USER_KEY = (userId: bigint | string) => `pwreset:user:${userId}`;

export async function accountRoutes(app: FastifyInstance): Promise<void> {
	// --- Legal ----------------------------------------------------------------------

	app.get("/v3/legal-agreements", async () => ({ legalAgreements: await legalInfo() }));

	app.get("/v3/me/legal-agreements", { preHandler: app.authenticate, config: { allowRestricted: true } }, async (req) => {
		const [row] = await db.select().from(legalAcceptances).where(eq(legalAcceptances.userId, req.auth.userId)).limit(1);
		return {
			termsOfServiceVersion: row?.termsVersion ?? null,
			privacyPolicyVersion: row?.privacyVersion ?? null,
			userConsentList: row?.consents ?? [],
			createdAtTermsAgreement: row?.termsAcceptedAt?.getTime() ?? null,
			createdAtPrivacyAgreement: row?.privacyAcceptedAt?.getTime() ?? null,
		};
	});

	/** Accept versions; consents are only ever added (an empty list keeps existing ones). */
	app.put("/v3/me/legal-agreements", { preHandler: app.authenticate, config: { allowRestricted: true } }, async (req) => {
		const version = z.union([z.string().max(40), z.number()]).transform(String);
		const body = z
			.object({ termsOfServiceVersion: version.nullish(), privacyPolicyVersion: version.nullish(), userConsentList: z.array(z.enum(["HIV_COLLECT", "VACCINE_COLLECT", "DOXYPEP_COLLECT"])).max(10).nullish() })
			.safeParse(req.body ?? {});
		if (!body.success) throw errors.parameter(body.error.issues[0]?.path.join("."));
		const b = body.data;
		const now = new Date();
		const [existing] = await db.select().from(legalAcceptances).where(eq(legalAcceptances.userId, req.auth.userId)).limit(1);
		const consents = [...new Set([...(existing?.consents ?? []), ...(b.userConsentList ?? [])])];
		const values = {
			termsVersion: b.termsOfServiceVersion ?? existing?.termsVersion ?? null,
			termsAcceptedAt: b.termsOfServiceVersion ? now : (existing?.termsAcceptedAt ?? null),
			privacyVersion: b.privacyPolicyVersion ?? existing?.privacyVersion ?? null,
			privacyAcceptedAt: b.privacyPolicyVersion ? now : (existing?.privacyAcceptedAt ?? null),
			consents,
		};
		await db.insert(legalAcceptances).values({ userId: req.auth.userId, ...values }).onConflictDoUpdate({ target: legalAcceptances.userId, set: values });
		return {};
	});

	const legalPage = (kind: "terms" | "privacy") => async (_req: unknown, reply: FastifyReply) => {
		const [text, version] = await Promise.all([
			getServerSetting<string>(kind === "terms" ? "legal.termsText" : "legal.privacyText"),
			getServerSetting<string>(kind === "terms" ? "legal.termsVersion" : "legal.privacyVersion"),
		]);
		const title = kind === "terms" ? "Terms of Service" : "Privacy Policy";
		return page(reply, title, `<h1>${title}</h1><p class="muted">Version ${escapeHtml(version ?? "")}</p><pre>${escapeHtml(text ?? "")}</pre>`);
	};
	app.get("/legal/terms", { config: { clientHeaders: "none" } }, legalPage("terms"));
	app.get("/legal/privacy", { config: { clientHeaders: "none" } }, legalPage("privacy"));

	// --- Warnings -------------------------------------------------------------------

	app.get("/v2/warnings", { preHandler: app.authenticate, config: { allowRestricted: true } }, async (req) => {
		const rows = await db
			.select({ warning: userWarnings.warning, count: sql<number>`count(*)::int` })
			.from(userWarnings)
			.where(and(eq(userWarnings.userId, req.auth.userId), isNull(userWarnings.acknowledgedAt)))
			.groupBy(userWarnings.warning);
		return { warnings: rows };
	});

	app.put("/v1/warnings", { preHandler: app.authenticate, config: { allowRestricted: true } }, async (req) => {
		await db.update(userWarnings).set({ acknowledgedAt: new Date() }).where(and(eq(userWarnings.userId, req.auth.userId), isNull(userWarnings.acknowledgedAt)));
		return {};
	});

	// --- Visiting -------------------------------------------------------------------

	app.get("/v1/visiting/settings", { preHandler: app.authenticate }, async (req) => {
		const [row] = await db.select({ mode: profiles.visitingMode }).from(profiles).where(eq(profiles.userId, req.auth.userId)).limit(1);
		return { setting: row?.mode ?? "AUTO" };
	});

	app.put("/v1/visiting/settings", { preHandler: app.authenticate }, async (req) => {
		const body = z.object({ setting: z.enum(["AUTO", "OFF", "ON"]) }).safeParse(req.body);
		if (!body.success) throw errors.parameter("setting");
		await db.insert(profiles).values({ userId: req.auth.userId, visitingMode: body.data.setting }).onConflictDoUpdate({ target: profiles.userId, set: { visitingMode: body.data.setting, updatedAt: new Date() } });
		await recomputeVisiting(req.auth.userId);
		await invalidateProfileCard(req.auth.userId);
		return {};
	});

	/**
	 * Own home only (set by the user, or learned in AUTO mode); 404 until there
	 * is one. `name` stays empty: the server has no geocoder, the client names it.
	 */
	app.get("/v1/visiting/home", { preHandler: app.authenticate }, async (req) => {
		const [row] = (await db.execute(
			sql`SELECT ST_Y(home_location::geometry) AS lat, ST_X(home_location::geometry) AS lon FROM profiles WHERE user_id = ${req.auth.userId} AND home_location IS NOT NULL`,
		)) as unknown as { lat: number; lon: number }[];
		if (!row) throw errors.notFound();
		return { name: "", lat: Number(row.lat), lon: Number(row.lon) };
	});

	app.put("/v1/visiting/home", { preHandler: app.authenticate }, async (req) => {
		const body = z.object({ lat: z.number().min(-90).max(90), lon: z.number().min(-180).max(180) }).safeParse(req.body);
		if (!body.success) throw errors.parameter("lat");
		const home = { lat: body.data.lat, lon: body.data.lon };
		await setHome(req.auth.userId, home);
		return { name: "", lat: home.lat, lon: home.lon };
	});

	// --- Forgot password ------------------------------------------------------------

	/**
	 * Always 200, whether or not the address exists (no account enumeration).
	 * Existing accounts get a single-use link (1 h); a newer link voids the older.
	 */
	app.post("/v3/users/forgot-password", { config: { authRoute: true } }, async (req) => {
		const body = z.object({ email: z.string().trim().toLowerCase().email().max(254) }).safeParse(req.body);
		if (!body.success) throw errors.parameter("email");
		await enforceRateLimit(`forgot:ip:${req.ip}`, 10, 3_600_000, { ip: req.ip });
		await enforceRateLimit(`forgot:email:${body.data.email}`, 3, 3_600_000, { ip: req.ip });
		const [user] = await db
			.select({ id: users.id, email: users.email })
			.from(users)
			.where(and(sql`lower(${users.email}) = ${body.data.email}`, isNull(users.deletedAt)))
			.limit(1);
		if (user?.email) {
			const token = randomToken(32);
			const hash = sha256Hex(token);
			const previous = await redis.get(RESET_USER_KEY(user.id));
			const p = redis.multi();
			if (previous) p.del(RESET_KEY(previous));
			p.set(RESET_KEY(hash), String(user.id), "EX", RESET_TTL_SECONDS);
			p.set(RESET_USER_KEY(user.id), hash, "EX", RESET_TTL_SECONDS);
			await p.exec();
			const link = `${config.PUBLIC_API_URL.replace(/\/$/, "")}/reset-password?token=${token}`;
			const german = req.client.locale.language === "de";
			// Not awaited: same response time whether or not the account exists.
			void sendMail({
				to: user.email,
				subject: german ? "Passwort zurücksetzen" : "Reset your password",
				text: german
					? `Über diesen Link kannst du ein neues Passwort setzen (1 Stunde gültig):\n\n${link}\n\nWenn du das nicht angefordert hast, ignoriere diese E-Mail.`
					: `Use this link to set a new password (valid for 1 hour):\n\n${link}\n\nIf you didn\'t request this, ignore this e-mail.`,
			}).catch((e) => req.log.error({ err: e }, "password reset mail failed"));
		}
		return {};
	});

	app.get("/reset-password", { config: { clientHeaders: "none" } }, async (req, reply) => {
		const token = String((req.query as { token?: string }).token ?? "");
		const valid = /^[\w-]{20,100}$/.test(token) && (await redis.exists(RESET_KEY(sha256Hex(token)))) === 1;
		if (!valid) return page(reply, "Link expired", "<h1>Link expired</h1><p>This link is invalid or has expired. Request a new one in the app.</p>", 410);
		return page(
			reply,
			"New password",
			`<h1>Set a new password</h1><form method="post" action="/reset-password"><input type="hidden" name="token" value="${escapeHtml(token)}"><label>New password<input type="password" name="password" minlength="8" maxlength="128" autocomplete="new-password" required></label><label>Repeat<input type="password" name="confirm" minlength="8" maxlength="128" autocomplete="new-password" required></label><button type="submit">Save</button></form>`,
		);
	});

	app.post("/reset-password", { config: { clientHeaders: "none" } }, async (req, reply) => {
		await enforceRateLimit(`reset:ip:${req.ip}`, 20, 3_600_000, { ip: req.ip });
		const body = z.object({ token: z.string().regex(/^[\w-]{20,100}$/), password: z.string().min(8).max(128), confirm: z.string() }).safeParse(req.body);
		if (!body.success) return page(reply, "Invalid", "<h1>Invalid input</h1><p>The password needs at least 8 characters.</p>", 400);
		if (body.data.password !== body.data.confirm) return page(reply, "Mismatch", "<h1>Passwords don't match</h1><p>Go back and try again.</p>", 400);
		const hash = sha256Hex(body.data.token);
		// Single use: GETDEL.
		const userId = await redis.getdel(RESET_KEY(hash));
		if (!userId) return page(reply, "Link expired", "<h1>Link expired</h1><p>Request a new one in the app.</p>", 410);
		const id = BigInt(userId);
		await redis.del(RESET_USER_KEY(id));
		await db.update(users).set({ passwordHash: await Bun.password.hash(body.data.password, PASSWORD_OPTS) }).where(eq(users.id, id));
		// Sign out everywhere: revoke refresh tokens and current session JWTs.
		await db.update(authTokens).set({ revokedAt: new Date() }).where(and(eq(authTokens.userId, id), isNull(authTokens.revokedAt)));
		await bumpTokenVersion(id);
		return page(reply, "Password changed", "<h1>Password changed</h1><p>You can now sign in with your new password.</p>");
	});
}
