import { redis } from "../cache/redis";

export type SecurityEventKind =
	| "header_rejected"
	| "device_mismatch"
	| "token_reuse"
	| "signature_rejected"
	| "rate_limited"
	| "login_failed";

/**
 * Security events go to a Redis stream first (cheap on the hot path, capped
 * length); a worker drains them into the `security_events` table for the
 * admin UI. Never blocks or fails the request.
 */
export async function recordSecurityEvent(
	kind: SecurityEventKind,
	data: { userId?: bigint | string | null; deviceId?: string | null; ip?: string; detail?: unknown },
): Promise<void> {
	try {
		await redis.xadd(
			"stream:security_events",
			"MAXLEN",
			"~",
			"100000",
			"*",
			"kind",
			kind,
			"userId",
			data.userId != null ? String(data.userId) : "",
			"deviceId",
			data.deviceId ?? "",
			"ip",
			data.ip ?? "",
			"detail",
			JSON.stringify(data.detail ?? null),
		);
	} catch {
		// best effort
	}
}
