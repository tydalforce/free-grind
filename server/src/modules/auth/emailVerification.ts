import { randomInt, timingSafeEqual } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { redis } from "../../cache/redis";
import { config } from "../../config";
import { db } from "../../db/client";
import { users } from "../../db/schema";
import { evaluateFlags, type EvalContext } from "../../flags/engine";
import { errors, problem } from "../../lib/errors";
import { sendMail } from "../../lib/mailer";
import { enforceRateLimit } from "../../lib/rateLimit";
import { randomToken, sha256Hex } from "../../lib/secrets";
import type { ClientContext } from "../../plugins/securityHeaders";
import { escapeHtml, page } from "../account/routes";
import { bumpTokenVersion } from "./sessions";

/**
 * E-mail verification: this server's stand-in for upstream's SMS verification
 * (we can't send SMS). Controlled by the public flag `email_verification`:
 *  - off:      nothing happens
 *  - optional: a code is mailed after sign-up; the app offers to verify
 *  - required: until verified, the session carries `email_verification_required`
 *              and every route not marked `allowUnverified` answers 403
 *              urn:gr:err:email_verification_required
 * Verifying bumps the token version; the next refresh drops both claims.
 */

export type EmailVerificationMode = "off" | "optional" | "required";

const CODE_TTL_SECONDS = 30 * 60;
const MAX_ATTEMPTS = 5;
const CODE_KEY = (userId: bigint | string) => `emailver:code:${userId}`;
const LINK_KEY = (hash: string) => `emailver:link:${hash}`;

export function modeOf(value: string | undefined | null): EmailVerificationMode {
	const v = (value ?? "").toLowerCase();
	return v === "optional" || v === "required" ? v : "off";
}

/** The flag's value for a user (rules can target roles, regions, …). */
export async function emailVerificationMode(ctx: EvalContext): Promise<EmailVerificationMode> {
	const assignments = await evaluateFlags(ctx);
	return modeOf(assignments.find((a) => a.key === "email_verification")?.value);
}

function contextFor(user: { id: bigint; createdAt: Date }, client: ClientContext): EvalContext {
	return { userId: String(user.id), roles: ["free"], geohash: null, platform: client.ua.platform, appVersion: client.ua.appVersion, accountCreatedAt: user.createdAt };
}

/** Mails a fresh 6-digit code plus a one-click link; replaces any earlier code. */
export async function sendVerificationMail(user: { id: bigint; email: string }, german: boolean): Promise<void> {
	const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
	const token = randomToken(32);
	const tokenHash = sha256Hex(token);
	const previous = await redis.hget(CODE_KEY(user.id), "link");
	const p = redis.multi();
	if (previous) p.del(LINK_KEY(previous));
	p.del(CODE_KEY(user.id));
	p.hset(CODE_KEY(user.id), { code: sha256Hex(`${user.id}:${code}`), attempts: "0", link: tokenHash });
	p.expire(CODE_KEY(user.id), CODE_TTL_SECONDS);
	p.set(LINK_KEY(tokenHash), String(user.id), "EX", CODE_TTL_SECONDS);
	await p.exec();
	const link = `${config.PUBLIC_API_URL.replace(/\/$/, "")}/verify-email?token=${token}`;
	await sendMail({
		to: user.email,
		subject: german ? `Dein Bestätigungscode: ${code}` : `Your verification code: ${code}`,
		text: german
			? `Dein Code zum Bestätigen deiner E-Mail-Adresse: ${code}\n\nOder öffne diesen Link (30 Minuten gültig):\n${link}\n\nWenn du kein Konto angelegt hast, ignoriere diese E-Mail.`
			: `Your code to confirm your e-mail address: ${code}\n\nOr open this link (valid for 30 minutes):\n${link}\n\nIf you didn't create an account, ignore this e-mail.`,
	});
}

async function markVerified(userId: bigint): Promise<void> {
	const link = await redis.hget(CODE_KEY(userId), "link");
	await redis.del(CODE_KEY(userId), ...(link ? [LINK_KEY(link)] : []));
	await db.update(users).set({ emailVerifiedAt: new Date() }).where(and(eq(users.id, userId), isNull(users.emailVerifiedAt)));
	await bumpTokenVersion(userId);
}

type CheckResult = "ok" | "wrong" | "expired";

async function checkCode(userId: bigint, code: string): Promise<CheckResult> {
	const stored = await redis.hgetall(CODE_KEY(userId));
	if (!stored.code) return "expired";
	const attempts = await redis.hincrby(CODE_KEY(userId), "attempts", 1);
	if (attempts > MAX_ATTEMPTS) {
		await redis.del(CODE_KEY(userId));
		return "expired";
	}
	const a = Buffer.from(stored.code, "hex");
	const b = Buffer.from(sha256Hex(`${userId}:${code}`), "hex");
	return a.length === b.length && timingSafeEqual(a, b) ? "ok" : "wrong";
}

/** After sign-up: send the first code when the flag is on (failures only logged). */
export async function onAccountCreated(req: FastifyRequest, user: { id: bigint; email: string | null; createdAt: Date }): Promise<void> {
	if (!user.email) return;
	const mode = await emailVerificationMode(contextFor(user, req.client));
	if (mode === "off") return;
	const email = user.email;
	void sendVerificationMail({ id: user.id, email }, req.client.locale.language === "de").catch((e) => req.log.error({ err: e }, "verification mail failed"));
}

export async function emailVerificationRoutes(app: FastifyInstance): Promise<void> {
	const loadUser = async (req: FastifyRequest) => {
		const [user] = await db
			.select({ id: users.id, email: users.email, emailVerifiedAt: users.emailVerifiedAt, createdAt: users.createdAt })
			.from(users)
			.where(eq(users.id, req.auth.userId))
			.limit(1);
		if (!user) throw errors.unauthorized();
		return user;
	};
	const opts = { preHandler: app.authenticate, config: { allowRestricted: true, allowUnverified: true } };

	app.get("/v1/me/email-verification", opts, async (req) => {
		const user = await loadUser(req);
		const mode = await emailVerificationMode(contextFor(user, req.client));
		return { email: user.email, verified: !!user.emailVerifiedAt, mode };
	});

	app.post("/v1/me/email-verification/send", opts, async (req) => {
		const user = await loadUser(req);
		if (!user.email) throw errors.clientAction("no e-mail address");
		if (user.emailVerifiedAt) return { sent: false, verified: true };
		await enforceRateLimit(`emailver:send:${user.id}`, 1, 60_000, { ip: req.ip, userId: String(user.id) });
		await enforceRateLimit(`emailver:send:h:${user.id}`, 6, 3_600_000, { ip: req.ip, userId: String(user.id) });
		try {
			await sendVerificationMail({ id: user.id, email: user.email }, req.client.locale.language === "de");
		} catch (e) {
			req.log.error({ err: e }, "verification mail failed");
			throw problem(503, "internal_error", "mail could not be sent");
		}
		return { sent: true, verified: false };
	});

	app.post("/v1/me/email-verification/verify", opts, async (req) => {
		const body = z.object({ code: z.string().trim().regex(/^\d{6}$/) }).safeParse(req.body);
		if (!body.success) throw errors.parameter("code");
		const user = await loadUser(req);
		if (user.emailVerifiedAt) return { verified: true };
		await enforceRateLimit(`emailver:verify:${user.id}`, 20, 3_600_000, { ip: req.ip, userId: String(user.id) });
		const result = await checkCode(user.id, body.data.code);
		if (result === "expired") throw errors.clientAction("code expired");
		if (result === "wrong") throw errors.parameter("code");
		await markVerified(user.id);
		return { verified: true };
	});

	// Link from the mail, opened in a browser.
	app.get("/verify-email", { config: { clientHeaders: "none" } }, async (req, reply) => {
		await enforceRateLimit(`emailver:link:ip:${req.ip}`, 30, 3_600_000, { ip: req.ip });
		const token = z.object({ token: z.string().regex(/^[\w-]{20,100}$/) }).safeParse(req.query);
		if (!token.success) return page(reply, "Invalid link", "<h1>Invalid link</h1>", 400);
		const userId = await redis.getdel(LINK_KEY(sha256Hex(token.data.token)));
		if (!userId) return page(reply, "Link expired", "<h1>Link expired</h1><p>Request a new code in the app.</p>", 410);
		await markVerified(BigInt(userId));
		return page(reply, "E-mail confirmed", `<h1>E-mail confirmed</h1><p>${escapeHtml("You can go back to the app now.")}</p>`);
	});
}

declare module "fastify" {
	interface FastifyContextConfig {
		/** Route stays usable while required e-mail verification is pending. */
		allowUnverified?: boolean;
	}
}
