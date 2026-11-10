import { and, eq, isNull, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { db } from "../../db/client";
import { devices, userRoles, users } from "../../db/schema";
import { coded, errors } from "../../lib/errors";
import { enforceRateLimit } from "../../lib/rateLimit";
import { recordSecurityEvent } from "../../lib/securityEvents";
import { getServerSetting } from "../settings/settings";
import { acceptBanAgreement, currentBan, permanentBanError } from "../../moderation/bans";
import { enforceDeviceBan, refuseIfDeviceOrNetworkBanned, refuseIfNetworkBanned } from "../../moderation/accessBans";

/** Permanent bans refuse sign-in and refresh with the upstream code-27/35 body. */
async function refuseIfPermanentlyBanned(userId: bigint): Promise<void> {
	const state = await currentBan(userId);
	if (state?.kind === "permanent") throw permanentBanError(state, String(userId));
}
import { bumpTokenVersion, consumeAuthToken, issueSession } from "./sessions";
import { onAccountCreated } from "./emailVerification";

const MIN_AGE_YEARS = 18;
// argon2id via Bun's native implementation (no extra dependency).
const PASSWORD_OPTS = { algorithm: "argon2id", memoryCost: 19456, timeCost: 2 } as const;
// Hash compared against when the email is unknown, so timing doesn't reveal accounts.
const DUMMY_HASH = await Bun.password.hash("dummy-password-for-timing", PASSWORD_OPTS);

const emailSchema = z.string().trim().toLowerCase().email().max(254);
const passwordSchema = z.string().min(8).max(128);
const geohashSchema = z
	.string()
	.regex(/^[0-9bcdefghjkmnpqrstuvwxyz]{1,12}$/)
	.nullish()
	.transform((v) => v ?? null);

/** POST /v8/users — body order from grindr-patched CreateAccountEmailRequest. */
const createAccountSchema = z.object({
	email: emailSchema,
	password: passwordSchema,
	birthday: z.number().int(),
	captchaToken: z.string().nullish(),
	token: z.string().nullish(),
	optIn: z.boolean().optional().default(false),
	sessionId: z.string().nullish(),
});

/** POST /v8/sessions, /v9/sessions — sign-in (password) or refresh (authToken). */
const sessionSchema = z.object({
	email: emailSchema,
	password: z.string().max(128).nullish(),
	authToken: z.string().max(256).nullish(),
	token: z.string().nullish(),
	geohash: geohashSchema,
	captchaToken: z.string().nullish(),
});

function parse<T extends z.ZodTypeAny>(schema: T, body: unknown): z.infer<T> {
	const r = schema.safeParse(body);
	if (!r.success) throw errors.invalidCredentials();
	return r.data;
}

function ageInYears(birthdayMs: number): number {
	const b = new Date(birthdayMs);
	const now = new Date();
	let age = now.getUTCFullYear() - b.getUTCFullYear();
	const m = now.getUTCMonth() - b.getUTCMonth();
	if (m < 0 || (m === 0 && now.getUTCDate() < b.getUTCDate())) age--;
	return age;
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
	app.post("/v8/users", { config: { authRoute: true } }, async (req) => {
		await enforceRateLimit(`signup:ip:${req.ip}`, 10, 3_600_000, { ip: req.ip });
		await enforceRateLimit(`signup:dev:${req.client.device.deviceId}`, 5, 86_400_000, { ip: req.ip });
		await refuseIfDeviceOrNetworkBanned(req.client.device.deviceId, req.ip);
		const mode = await getServerSetting<string>("registration.mode");
		if (mode === "closed") throw errors.forbidden("registration closed");

		const body = createAccountSchema.safeParse(req.body);
		if (!body.success) throw errors.parameter(body.error.issues[0]?.path.join(".") ?? "body");
		const { email, password, birthday, optIn, token } = body.data;
		if (ageInYears(birthday) < MIN_AGE_YEARS || birthday < Date.UTC(1900, 0, 1)) throw errors.parameter("birthday");

		const [existing] = await db
			.select({ id: users.id })
			.from(users)
			.where(and(sql`lower(${users.email}) = ${email}`, isNull(users.deletedAt)))
			.limit(1);
		// Same answer shape as upstream for a taken email; no account enumeration via timing of hashing.
		const passwordHash = await Bun.password.hash(password, PASSWORD_OPTS);
		if (existing) throw coded(400, 6, "Email already in use");

		const defaultRole = await getServerSetting<string>("registration.defaultRole");
		const user = await db.transaction(async (tx) => {
			const [u] = await tx.insert(users).values({ email, passwordHash, birthday: new Date(birthday), optIn }).returning();
			if (!u) throw new Error("insert failed");
			if (defaultRole) await tx.insert(userRoles).values({ userId: u.id, role: defaultRole as "unlimited", grantedBy: "registration" });
			if (token) {
				await tx.insert(devices).values({ userId: u.id, deviceId: req.client.device.deviceId, fcmToken: token }).onConflictDoNothing();
			}
			return u;
		});
		await onAccountCreated(req, user);
		return { profileId: String(user.id) };
	});

	const signIn = async (req: import("fastify").FastifyRequest) => {
		await enforceRateLimit(`signin:ip:${req.ip}`, 30, 600_000, { ip: req.ip });
		const body = parse(sessionSchema, req.body);
		await enforceRateLimit(`signin:email:${body.email}`, 10, 600_000, { ip: req.ip });
		// Network bans (code 31) apply before anything else; device bans once the
		// account is known (enforceDeviceBan bans it, then code 27 below).
		await refuseIfNetworkBanned(req.ip);

		// Refresh: rotate the authToken (reuse → family revoked).
		if (body.authToken) {
			const [owner] = await db
				.select({ id: users.id })
				.from(users)
				.where(and(sql`lower(${users.email}) = ${body.email}`, isNull(users.deletedAt)))
				.limit(1);
			if (!owner) throw errors.invalidCredentials();
			const result = await consumeAuthToken(body.authToken, req.client, owner.id);
			if (!result.ok) throw errors.invalidCredentials();
			await enforceDeviceBan(result.user.id, req.client.device.deviceId);
			await refuseIfPermanentlyBanned(result.user.id);
			return issueSession(result.user, req.client, { geohash: body.geohash, familyId: result.familyId, fcmToken: body.token });
		}

		if (!body.password) throw errors.invalidCredentials();
		const [user] = await db
			.select()
			.from(users)
			.where(and(sql`lower(${users.email}) = ${body.email}`, isNull(users.deletedAt)))
			.limit(1);
		const ok = await Bun.password.verify(body.password, user?.passwordHash ?? DUMMY_HASH);
		if (!user || !user.passwordHash || !ok) {
			await recordSecurityEvent("login_failed", { ip: req.ip, deviceId: req.client.device.deviceId, detail: { email: body.email } });
			throw errors.invalidCredentials();
		}
		await enforceDeviceBan(user.id, req.client.device.deviceId);
		await refuseIfPermanentlyBanned(user.id);
		return issueSession(user, req.client, { geohash: body.geohash, fcmToken: body.token });
	};

	app.post("/v8/sessions", { config: { authRoute: true } }, signIn);
	// No reCAPTCHA on our server: /v9 behaves exactly like /v8 and ignores captchaToken.
	app.post("/v9/sessions", { config: { authRoute: true } }, signIn);

	app.post("/v3/users/update-password", { preHandler: app.authenticate }, async (req) => {
		const body = z.object({ oldPassword: z.string().max(128), newPassword: passwordSchema }).safeParse(req.body);
		if (!body.success) throw errors.parameter("password");
		const [user] = await db.select().from(users).where(eq(users.id, req.auth.userId)).limit(1);
		if (!user?.passwordHash || !(await Bun.password.verify(body.data.oldPassword, user.passwordHash))) throw errors.invalidCredentials();
		await db.update(users).set({ passwordHash: await Bun.password.hash(body.data.newPassword, PASSWORD_OPTS) }).where(eq(users.id, user.id));
		// Every other session must sign in again.
		await bumpTokenVersion(user.id);
		const session = await issueSession({ ...user, tokenVersion: user.tokenVersion + 1 }, req.client, { geohash: null });
		return session;
	});

	app.delete("/v3/me/profile", { preHandler: app.authenticate, config: { allowRestricted: true } }, async (req) => {
		await db.update(users).set({ deletedAt: new Date(), email: null, passwordHash: null }).where(eq(users.id, req.auth.userId));
		await bumpTokenVersion(req.auth.userId);
		return {};
	});

	// SMS verification is never required on our server; answer like a success if called.
	app.post("/v4/sms/verification/:profileId/:action", async () => ({ code: null, message: "OK" }));

	/**
	 * Accept the ban agreement once a timed ban has run out (upstream flips
	 * banDetails.isAgreementCompleted). The client then refreshes its session
	 * (accept_ban_agreement in src-tauri) and gets an unrestricted token.
	 */
	app.post("/v1/agreements/ban", { preHandler: app.authenticate, config: { allowRestricted: true } }, async (req) => {
		const body = z.object({ version: z.number().int().optional(), locale: z.string().max(20).optional() }).passthrough().safeParse(req.body ?? {});
		if (!body.success) throw errors.badRequest();
		const result = await acceptBanAgreement(req.auth.userId);
		if (result === "ban_still_active") throw errors.clientAction("ban still active");
		return {};
	});

	app.post("/v3/gcm-push-tokens", { preHandler: app.authenticate, config: { allowUnverified: true } }, async (req) => {
		const body = z.object({ token: z.string().min(10).max(4096), vendorProvidedIdentifier: z.string().nullish() }).safeParse(req.body);
		if (!body.success) throw errors.parameter("token");
		await db.transaction(async (tx) => {
			// A token belongs to one device: detach it from whoever had it.
			await tx.update(devices).set({ fcmToken: null }).where(eq(devices.fcmToken, body.data.token));
			await tx
				.insert(devices)
				.values({ userId: req.auth.userId, deviceId: req.client.device.deviceId, fcmToken: body.data.token })
				.onConflictDoUpdate({ target: [devices.userId, devices.deviceId], set: { fcmToken: body.data.token, lastSeenAt: new Date() } });
		});
		return {};
	});

	app.delete("/v3/push-tokens/:token", { preHandler: app.authenticate, config: { allowUnverified: true } }, async (req) => {
		const { token } = req.params as { token: string };
		await db.update(devices).set({ fcmToken: null }).where(and(eq(devices.userId, req.auth.userId), eq(devices.fcmToken, token)));
		return {};
	});
}
