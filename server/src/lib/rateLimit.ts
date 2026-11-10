import { redis } from "../cache/redis";
import { ApiError } from "./errors";
import { recordSecurityEvent } from "./securityEvents";

/**
 * Fixed-window counter in Redis (one INCR + PEXPIRE via pipeline). Cheap
 * enough to run on every auth/upload request.
 */
export async function hitRateLimit(bucket: string, limit: number, windowMs: number): Promise<{ allowed: boolean; retryAfterMs: number }> {
	const windowId = Math.floor(Date.now() / windowMs);
	const key = `rl:${bucket}:${windowId}`;
	const [[, count]] = (await redis.multi().incr(key).pexpire(key, windowMs).exec()) as [[null, number], [null, number]];
	return { allowed: count <= limit, retryAfterMs: windowMs - (Date.now() % windowMs) };
}

export async function enforceRateLimit(bucket: string, limit: number, windowMs: number, meta: { ip?: string; userId?: string } = {}): Promise<void> {
	const { allowed, retryAfterMs } = await hitRateLimit(bucket, limit, windowMs);
	if (allowed) return;
	await recordSecurityEvent("rate_limited", { ip: meta.ip, userId: meta.userId, detail: { bucket } });
	// 429 → the Rust client maps it to GrindrError::RateLimited.
	throw new ApiError(429, { code: 429, message: "Too many requests" }, { "retry-after": String(Math.ceil(retryAfterMs / 1000)) });
}
