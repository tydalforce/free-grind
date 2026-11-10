import { and, eq, isNull, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { db } from "../db/client";
import { users } from "../db/schema";
import { errors, problem } from "../lib/errors";
import { enforceRateLimit } from "../lib/rateLimit";
import { escapeHtml, page } from "../modules/account/routes";
import { appealForBan, submitAppeal, type AppealRow } from "./appeals";
import { currentBan } from "./bans";

// Same parameters as sign-in, so checking a password here costs the same.
const PASSWORD_OPTS = { algorithm: "argon2id", memoryCost: 19456, timeCost: 2 } as const;
const DUMMY_HASH = await Bun.password.hash("dummy-password-for-timing", PASSWORD_OPTS);

/** Upstream: 400 urn:gr:err:parameter with parameterName "validation" for an unbanned account. */
const notBanned = () => problem(400, "parameter", undefined, { parameterName: "validation" });

const appealBody = z.object({
	userEmail: z.string().max(254).nullish(),
	userDevice: z.string().max(200).nullish(),
	userLocation: z.string().max(200).nullish(),
	countryCode: z
		.string()
		.regex(/^[A-Za-z]{2}$/)
		.transform((v) => v.toUpperCase())
		.nullish(),
	userVpn: z.boolean().nullish(),
	errorDescription: z.string().max(4000).nullish(),
	// We never ask for reCAPTCHA, so it's ignored.
	captchaToken: z.string().nullish(),
});

function response(userId: bigint, appeal: AppealRow) {
	return { profileId: Number(userId), result: appeal.status };
}

/**
 * Ban appeals (docs safety/appeals.md): GET /v1 and POST /v2. The app calls these with the
 * restricted session of a timed ban; permanently banned accounts can't sign
 * in, so they appeal on the /ban-appeal web page (like web.grindr.com/ban-appeal).
 */
export async function appealRoutes(app: FastifyInstance): Promise<void> {
	app.get("/v1/decision-appeal", { preHandler: app.authenticate, config: { allowRestricted: true } }, async (req) => {
		const state = await currentBan(req.auth.userId);
		if (!state) throw notBanned();
		const appeal = await appealForBan(req.auth.userId, state);
		return { profileId: Number(req.auth.userId), result: appeal?.status ?? null };
	});

	// Only /v2 exists upstream for submitting (POST /v1 was retired).
	const submit = async (req: import("fastify").FastifyRequest) => {
		await enforceRateLimit(`appeal:user:${req.auth.userId}`, 5, 86_400_000, { ip: req.ip, userId: String(req.auth.userId) });
		const body = appealBody.safeParse(req.body ?? {});
		if (!body.success) throw errors.parameter(body.error.issues[0]?.path.join("."));
		const b = body.data;
		const result = await submitAppeal(req.auth.userId, {
			source: "app",
			userEmail: b.userEmail,
			userDevice: b.userDevice,
			userLocation: b.userLocation,
			countryCode: b.countryCode,
			userVpn: b.userVpn,
			description: b.errorDescription,
		});
		if (result.kind === "not_banned") throw notBanned();
		return response(req.auth.userId, result.appeal);
	};
	app.post("/v2/decision-appeal", { preHandler: app.authenticate, config: { allowRestricted: true } }, submit);

	// --- Web page -------------------------------------------------------------------

	const form = (message = "") =>
		`<h1>Appeal a ban</h1>${message}<p class="muted">Sign in with the account that was banned and tell us why the ban should be lifted. A moderator reviews every appeal; if it's granted, you can sign in again in the app.</p>
<form method="post" action="/ban-appeal"><label>Email<input type="email" name="email" maxlength="254" autocomplete="username" required></label><label>Password<input type="password" name="password" maxlength="128" autocomplete="current-password" required></label><label>Why should the ban be lifted?<textarea name="description" rows="6" maxlength="4000" required></textarea></label><button type="submit">Send appeal</button></form>`;

	app.get("/ban-appeal", { config: { clientHeaders: "none" } }, async (_req, reply) => page(reply, "Appeal a ban", form()));

	app.post("/ban-appeal", { config: { clientHeaders: "none" } }, async (req, reply) => {
		await enforceRateLimit(`appeal:ip:${req.ip}`, 20, 3_600_000, { ip: req.ip });
		const body = z
			.object({
				email: z.string().trim().toLowerCase().email().max(254),
				password: z.string().min(1).max(128),
				description: z.string().trim().min(1).max(4000),
			})
			.safeParse(req.body);
		if (!body.success) return page(reply, "Appeal a ban", form(`<p>Please fill in every field.</p>`), 400);
		const { email, password, description } = body.data;
		await enforceRateLimit(`appeal:email:${email}`, 10, 3_600_000, { ip: req.ip });

		const [user] = await db
			.select({ id: users.id, passwordHash: users.passwordHash })
			.from(users)
			.where(and(sql`lower(${users.email}) = ${email}`, isNull(users.deletedAt)))
			.limit(1);
		const ok = await Bun.password.verify(password, user?.passwordHash ?? DUMMY_HASH);
		if (!user || !user.passwordHash || !ok) return page(reply, "Appeal a ban", form(`<p>Wrong email or password.</p>`), 400);

		const result = await submitAppeal(user.id, { source: "web", userEmail: email, description });
		if (result.kind === "not_banned") return page(reply, "Not banned", "<h1>This account isn't banned</h1><p>You can sign in in the app.</p>");
		if (result.kind === "created") return page(reply, "Appeal sent", "<h1>Appeal sent</h1><p>A moderator will review it. If it's granted, you can sign in again in the app.</p>");
		const status = result.appeal.status;
		const text =
			status === "PENDING"
				? "Your appeal for this ban is still being reviewed."
				: status === "GRANTED"
					? "Your appeal was granted."
					: "Your appeal for this ban was reviewed and rejected.";
		return page(reply, "Appeal", `<h1>Appeal already sent</h1><p>${escapeHtml(text)}</p>`);
	});
}
