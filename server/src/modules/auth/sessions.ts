import { and, eq, isNull, sql } from "drizzle-orm";
import { loadLiveKit } from "../../videocall/livekit";
import { randomUUID } from "node:crypto";
import { redis } from "../../cache/redis";
import { db } from "../../db/client";
import { authTokens, devices, profiles, users } from "../../db/schema";
import { getActiveRoles, resolveFeatures } from "../../entitlements/resolve";
import { type EvalContext, evaluateFlags, isOn } from "../../flags/engine";
import type { ClientContext } from "../../plugins/securityHeaders";
import { type SessionClaims, deviceBindingHash, signSessionJwt } from "../../lib/jwt";
import { randomToken, sha256Hex } from "../../lib/secrets";
import { updateLocationFromGeohash } from "../../geo/location";
import { banClaims, currentBan, sessionExpiryCapMs } from "../../moderation/bans";
import { recordSecurityEvent } from "../../lib/securityEvents";

type UserRow = typeof users.$inferSelect;

/**
 * Cached token_version per user. The key includes a global epoch so a bulk
 * re-issue (e.g. a role's features changed) invalidates every cached entry
 * with one INCR instead of deleting millions of keys.
 */
const EPOCH_KEY = "tv:epoch";
const TV_KEY = (epoch: string, userId: bigint | string) => `tv:${epoch}:${userId}`;

async function epoch(): Promise<string> {
	return (await redis.get(EPOCH_KEY)) ?? "0";
}

/** Current token_version, cached in Redis so every request can check it cheaply. */
export async function getTokenVersion(userId: bigint | string): Promise<number> {
	const e = await epoch();
	const cached = await redis.get(TV_KEY(e, userId));
	if (cached != null) return Number(cached);
	const [row] = await db.select({ tv: users.tokenVersion }).from(users).where(eq(users.id, BigInt(userId))).limit(1);
	const tv = row?.tv ?? -1;
	await redis.set(TV_KEY(e, userId), String(tv), "EX", 3600);
	return tv;
}

/** Invalidates every session JWT of the user; the client refreshes and gets fresh claims. */
export async function bumpTokenVersion(userId: bigint): Promise<void> {
	const [row] = await db
		.update(users)
		.set({ tokenVersion: sqlIncrement() })
		.where(eq(users.id, userId))
		.returning({ tv: users.tokenVersion });
	if (row) await redis.set(TV_KEY(await epoch(), userId), String(row.tv), "EX", 3600);
}

/** Bulk variant: bumps all matching users in one statement, then rolls the cache epoch. */
export async function bumpTokenVersionWhere(where: ReturnType<typeof sql>): Promise<number> {
	const rows = await db.execute(sql`UPDATE ${users} SET token_version = token_version + 1 WHERE ${where}`);
	await redis.incr(EPOCH_KEY);
	return (rows as unknown as { count?: number }).count ?? 0;
}

function sqlIncrement() {
	return sql`${users.tokenVersion} + 1`;
}

import { modeOf } from "./emailVerification";

export async function buildClaims(user: UserRow, client: ClientContext, geohash: string | null) {
	const [roles, ban] = await Promise.all([getActiveRoles(user.id), currentBan(user.id)]);
	const ctx: EvalContext = {
		userId: String(user.id),
		roles: roles.length ? roles : ["free"],
		geohash,
		platform: client.ua.platform,
		appVersion: client.ua.appVersion,
		accountCreatedAt: user.createdAt,
	};
	const [assignments, allFeatures, livekit] = await Promise.all([evaluateFlags(ctx), resolveFeatures(user.id), loadLiveKit()]);
	// Video calls only exist on this server once LiveKit is set up.
	const features = livekit ? allFeatures : allFeatures.filter((f) => f !== "CreateVideoCall");
	const featureFlags = assignments.filter((a) => a.type === "FEATURE_FLAG" && isOn(a.value)).map((a) => a.key);
	const experiments = Object.fromEntries(assignments.filter((a) => a.type === "EXPERIMENT").map((a) => [a.key, a.value]));
	// FEATURE-type flags extend the entitlement-derived features.
	const flagFeatures = assignments.filter((a) => a.type === "FEATURE" && isOn(a.value)).map((a) => a.key);
	// E-mail verification (our SMS stand-in, flag email_verification): only while it's switched on.
	const emailMode = modeOf(assignments.find((a) => a.key === "email_verification")?.value);
	if (!user.emailVerifiedAt && user.email && emailMode !== "off") {
		featureFlags.push("email_unverified");
		if (emailMode === "required") featureFlags.push("email_verification_required");
	}
	return {
		profileId: String(user.id),
		roles,
		features: [...new Set([...features, ...flagFeatures])].sort(),
		featureFlags: featureFlags.sort(),
		experiments,
		...banClaims(ban),
		tv: user.tokenVersion,
		did: deviceBindingHash(client.device.deviceId),
	};
}

export type IssuedSession = { profileId: string; sessionId: string; authToken: string };

/** Starts (familyId undefined) or continues a refresh-token family and signs a JWT. */
export async function issueSession(
	user: UserRow,
	client: ClientContext,
	opts: { geohash: string | null; familyId?: string; fcmToken?: string | null },
): Promise<IssuedSession> {
	const authToken = randomToken(48);
	const familyId = opts.familyId ?? randomUUID();
	await db.transaction(async (tx) => {
		await tx.insert(authTokens).values({
			familyId,
			userId: user.id,
			deviceId: client.device.deviceId,
			tokenHash: sha256Hex(authToken),
		});
		await tx
			.insert(devices)
			.values({
				userId: user.id,
				deviceId: client.device.deviceId,
				userAgent: `${client.ua.appVersion};${client.ua.os};${client.ua.deviceModel}`,
				fcmToken: opts.fcmToken || null,
			})
			.onConflictDoUpdate({
				target: [devices.userId, devices.deviceId],
				set: { lastSeenAt: new Date(), revokedAt: null, ...(opts.fcmToken ? { fcmToken: opts.fcmToken } : {}) },
			});
		await tx.insert(profiles).values({ userId: user.id }).onConflictDoNothing();
	});
	// Sign-in with a geohash moves the profile there (real + obfuscated public point).
	if (opts.geohash) await updateLocationFromGeohash(user.id, opts.geohash);
	const claims = await buildClaims(user, client, opts.geohash);
	// During an active timed ban the token ends with the ban, so the client refreshes then.
	const { token } = await signSessionJwt(claims, { expCapMs: sessionExpiryCapMs(await currentBan(user.id)) });
	return { profileId: String(user.id), sessionId: token, authToken };
}

export type RefreshResult = { ok: true; user: UserRow; familyId: string } | { ok: false };

/**
 * Consumes an authToken. A token that was already consumed (or revoked) is a
 * replay: the whole family is revoked and the event logged.
 */
export async function consumeAuthToken(authToken: string, client: ClientContext, expectUserId?: bigint): Promise<RefreshResult> {
	const hash = sha256Hex(authToken);
	return db.transaction(async (tx) => {
		const [row] = await tx.select().from(authTokens).where(eq(authTokens.tokenHash, hash)).for("update").limit(1);
		if (!row) return { ok: false } as const;
		if (row.consumedAt || row.revokedAt) {
			await tx.update(authTokens).set({ revokedAt: new Date() }).where(and(eq(authTokens.familyId, row.familyId), isNull(authTokens.revokedAt)));
			await recordSecurityEvent("token_reuse", { userId: row.userId, deviceId: client.device.deviceId, detail: { familyId: row.familyId } });
			return { ok: false } as const;
		}
		if (expectUserId != null && row.userId !== expectUserId) return { ok: false } as const;
		if (row.deviceId !== client.device.deviceId) {
			await recordSecurityEvent("device_mismatch", { userId: row.userId, deviceId: client.device.deviceId, detail: { expected: row.deviceId } });
			return { ok: false } as const;
		}
		await tx.update(authTokens).set({ consumedAt: new Date() }).where(eq(authTokens.id, row.id));
		const [user] = await tx.select().from(users).where(eq(users.id, row.userId)).limit(1);
		if (!user || user.deletedAt) return { ok: false } as const;
		return { ok: true, user, familyId: row.familyId } as const;
	});
}
