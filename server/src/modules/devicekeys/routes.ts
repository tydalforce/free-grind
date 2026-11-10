import { randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { invalidate } from "../../cache/local";
import { redis } from "../../cache/redis";
import { db } from "../../db/client";
import { deviceKeys } from "../../db/schema";
import { errors } from "../../lib/errors";
import { enforceRateLimit } from "../../lib/rateLimit";
import { recordSecurityEvent } from "../../lib/securityEvents";
import { fromB64url, keyIdFor, verifyDer } from "./signing";

const CHALLENGE_TTL_SECONDS = 300;
const challengeKey = (userId: bigint, deviceId: string) => `dkc:${userId}:${deviceId}`;

const registerSchema = z.object({
	publicKey: z.string().min(40).max(400),
	keyId: z.string().min(40).max(64),
	registrationSignature: z.string().min(40).max(200),
});

export async function deviceKeyRoutes(app: FastifyInstance): Promise<void> {
	app.post("/v1/verification/device-keys/challenge", { preHandler: app.authenticate }, async (req) => {
		await enforceRateLimit(`dkc:${req.auth.profileId}`, 20, 3_600_000, { ip: req.ip, userId: req.auth.profileId });
		const challenge = randomBytes(32).toString("base64url");
		const expiresAt = new Date(Date.now() + CHALLENGE_TTL_SECONDS * 1000);
		// One open challenge per (user, device); a new one replaces the old.
		await redis.set(challengeKey(req.auth.userId, req.client.device.deviceId), challenge, "EX", CHALLENGE_TTL_SECONDS);
		return { challenge, expiresAt: expiresAt.toISOString() };
	});

	const register = async (req: FastifyRequest) => {
		const body = registerSchema.safeParse(req.body);
		if (!body.success) throw errors.parameter("body");
		const { publicKey, keyId, registrationSignature } = body.data;
		const spki = fromB64url(publicKey);
		const sig = fromB64url(registrationSignature);
		if (!spki || !sig || keyIdFor(spki) !== keyId) throw errors.parameter("keyId");

		// Challenge is single-use: GETDEL.
		const challenge = await redis.getdel(challengeKey(req.auth.userId, req.client.device.deviceId));
		if (!challenge) throw errors.clientAction("challenge expired");

		const message = `${req.auth.profileId}|${keyId}|${publicKey}|${req.client.device.deviceId}|${challenge}`;
		if (!verifyDer(spki, message, sig)) {
			await recordSecurityEvent("signature_rejected", { userId: req.auth.profileId, deviceId: req.client.device.deviceId, ip: req.ip, detail: { stage: "registration" } });
			throw errors.clientAction("invalid registration signature");
		}
		await db
			.insert(deviceKeys)
			.values({ keyId, userId: req.auth.userId, deviceId: req.client.device.deviceId, publicKey })
			.onConflictDoUpdate({ target: deviceKeys.keyId, set: { userId: req.auth.userId, deviceId: req.client.device.deviceId, publicKey } });
		await invalidate("device-keys", keyId);
		return { keyId };
	};

	app.post("/v1/verification/device-keys", { preHandler: app.authenticate }, register);
	// v2 only adds an X-Grindr-Captcha-Token header; we don't use reCAPTCHA, so it's ignored.
	app.post("/v2/verification/device-keys", { preHandler: app.authenticate }, register);
}
