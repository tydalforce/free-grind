import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { redis } from "../cache/redis";
import { consume, durationSeconds, isFeatureEnabled, peek } from "../entitlements/enforce";
import { notifyQueue } from "../jobs/queues";
import { errors } from "../lib/errors";
import { getProfileCards } from "../profiles/cards";
import { isBlockedEitherWay } from "../profiles/relations";
import { publishToUser } from "../realtime/bus";
import { sendSystemMessage } from "../chat/service";
import { type LiveKitConfig, deleteRoom, joinToken, loadLiveKit } from "./livekit";

/**
 * Video calls (/v1/video-call*, /v3/video-call) on self-hosted LiveKit.
 * Responses keep the upstream (Agora) shape and add `provider: "livekit"` and
 * `url`, which the app uses to pick its call engine; without those fields it
 * stays on Agora, so the official server is unaffected.
 *
 * A call lives in Redis while it rings/runs. It ends on leave, after 45 s
 * without an answer, or at its maximum length — then both sides get
 * videocall.v1.call_ended and the talked seconds are charged to the caller
 * only — receiving a call costs nothing.
 */

const RING_TIMEOUT_MS = 45_000;
/** Hard ceiling per call even when everything is unlimited (keeps tokens bounded). */
const MAX_CALL_SECONDS = 4 * 3600;
const UNLIMITED = 2_147_483_647;
const REFRESH_SECONDS = 300;

type CallState = { channelId: string; callerId: string; calleeId: string; maxSeconds: number; createdAt: number; answeredAt: number | null };

const callKey = (channel: string) => `vc:call:${channel}`;
const activeKey = (userId: string) => `vc:active:${userId}`;

async function loadCall(channel: string): Promise<CallState | null> {
	const raw = await redis.get(callKey(channel));
	return raw ? (JSON.parse(raw) as CallState) : null;
}

async function saveCall(call: CallState): Promise<void> {
	const ttl = call.maxSeconds + 600;
	await redis.multi().set(callKey(call.channelId), JSON.stringify(call), "EX", ttl).set(activeKey(call.callerId), call.channelId, "EX", ttl).set(activeKey(call.calleeId), call.channelId, "EX", ttl).exec();
}

/** Seconds a user may still talk now (daily/monthly allowance, per-call cap). */
async function allowance(userId: bigint): Promise<number> {
	const [daily, monthly, perCall] = await Promise.all([peek(userId, "videocall.dailySeconds"), peek(userId, "videocall.monthlySeconds"), durationSeconds(userId, "videocall.maxCallSeconds")]);
	return Math.min(daily.remaining, monthly.remaining, perCall);
}

async function remainingSeconds(userId: bigint): Promise<number> {
	const [daily, monthly] = await Promise.all([peek(userId, "videocall.dailySeconds"), peek(userId, "videocall.monthlySeconds")]);
	const r = Math.min(daily.remaining, monthly.remaining);
	return Number.isFinite(r) ? Math.max(0, Math.floor(r)) : UNLIMITED;
}

/** Charges the talked seconds, up to what's left (never refuses after the fact). */
async function charge(userId: bigint, seconds: number): Promise<void> {
	if (seconds <= 0) return;
	for (const key of ["videocall.dailySeconds", "videocall.monthlySeconds"]) {
		const left = (await peek(userId, key)).remaining;
		const n = Math.min(seconds, Number.isFinite(left) ? Math.max(0, Math.floor(left)) : seconds);
		if (n > 0) await consume(userId, key, n).catch(() => undefined);
	}
}

const failure = (result: string) => ({ result, channelId: null, token: null, maxSeconds: null, message: null });

async function requireLiveKit(): Promise<LiveKitConfig> {
	const cfg = await loadLiveKit();
	if (!cfg) throw errors.forbidden("video calls are not available");
	return cfg;
}

export type CallEndReason = "SUCCESSFUL" | "UNANSWERED" | "DECLINED" | "EXCEED_LENGTH_LIMIT";

/**
 * The chat's call status message (VideoCallMessageBody: `result`,
 * `videoCallDuration` in seconds), from the caller to the callee like upstream.
 * `result` uses the values the client maps (SUCCESSFUL, DECLINED, UNANSWERED,
 * Cancelled, BUSY).
 */
async function callStatusMessage(callerId: string, calleeId: string, result: string, seconds: number): Promise<void> {
	await sendSystemMessage(BigInt(callerId), BigInt(calleeId), "VideoCall", { result, videoCallDuration: seconds }).catch(() => undefined);
}

/**
 * Ends a call once (whoever comes first wins), charges, notifies both, closes
 * the room and leaves the status message in the chat. `cancelled`: the caller
 * hung up before it was answered.
 */
export async function endCall(channelId: string, reason: CallEndReason | ((call: CallState) => CallEndReason), opts: { cancelled?: (call: CallState) => boolean } = {}): Promise<boolean> {
	const call = await loadCall(channelId);
	if (!call) return false;
	// DEL is the claim: only one ender gets 1.
	if ((await redis.del(callKey(channelId))) !== 1) return false;
	for (const uid of [call.callerId, call.calleeId]) {
		if ((await redis.get(activeKey(uid))) === channelId) await redis.del(activeKey(uid));
	}
	const result = typeof reason === "function" ? reason(call) : reason;
	const duration = call.answeredAt ? Math.min(call.maxSeconds, Math.ceil((Date.now() - call.answeredAt) / 1000)) : 0;
	await charge(BigInt(call.callerId), duration);
	const payload = { channelId, senderId: call.callerId, recipientId: call.calleeId, result, duration };
	await Promise.all([publishToUser(call.callerId, "videocall.v1.call_ended", payload), publishToUser(call.calleeId, "videocall.v1.call_ended", payload)]).catch(() => undefined);
	const cfg = await loadLiveKit();
	if (cfg) await deleteRoom(cfg, channelId);
	const messageResult = result === "SUCCESSFUL" || result === "EXCEED_LENGTH_LIMIT" ? "SUCCESSFUL" : result === "UNANSWERED" && opts.cancelled?.(call) ? "Cancelled" : result;
	await callStatusMessage(call.callerId, call.calleeId, messageResult, messageResult === "SUCCESSFUL" ? duration : 0);
	return true;
}

/** Worker: ring timeout / maximum length reached. */
export async function handleCallTimer(channelId: string, kind: "ring" | "limit"): Promise<void> {
	const call = await loadCall(channelId);
	if (!call) return;
	if (kind === "ring" && !call.answeredAt) await endCall(channelId, "UNANSWERED");
	if (kind === "limit" && call.answeredAt) await endCall(channelId, "EXCEED_LENGTH_LIMIT");
}

export async function videoCallRoutes(app: FastifyInstance): Promise<void> {
	const auth = { preHandler: app.authenticate };

	app.get("/v3/video-call", auth, async (req) => ({ remainingSeconds: await remainingSeconds(req.auth.userId) }));

	app.post("/v1/video-call", auth, async (req) => {
		const me = req.auth.userId;
		const cfg = await requireLiveKit();
		if (!(await isFeatureEnabled(me, "videocall.enabled"))) throw errors.forbidden("video calls are not available");
		const b = z.object({ targetProfileId: z.union([z.number().int(), z.string().regex(/^\d{1,19}$/)]) }).safeParse(req.body);
		if (!b.success) throw errors.badRequest("Invalid request");
		const target = BigInt(b.data.targetProfileId);
		if (target === me) throw errors.badRequest("Invalid request");
		const card = (await getProfileCards([target])).get(String(target));
		if (!card || card.deleted || card.banned || (await isBlockedEitherWay(String(me), String(target)))) return failure("TARGET_PROFILE_UNAVAILABLE");
		if (!(await isFeatureEnabled(target, "videocall.receive"))) return failure("TARGET_PROFILE_UNAVAILABLE");
		// Either side already ringing or talking.
		const [mine, theirs] = await redis.mget(activeKey(String(me)), activeKey(String(target)));
		if (theirs && (await loadCall(theirs))) {
			// Upstream leaves a "Busy" status in the chat.
			await callStatusMessage(String(me), String(target), "BUSY", 0);
			return failure("TARGET_PROFILE_UNAVAILABLE");
		}
		if (mine && (await loadCall(mine))) await endCall(mine, (c) => (c.answeredAt ? "SUCCESSFUL" : "UNANSWERED"), { cancelled: (c) => c.callerId === String(me) });

		// Only the caller pays, so only the caller's allowance limits the call.
		const maxSeconds = Math.floor(Math.min(await allowance(me), MAX_CALL_SECONDS));
		if (maxSeconds <= 0) return failure("EXCEED_LENGTH_LIMIT");
		try {
			await consume(me, "videocall.callsPerDay");
		} catch {
			return failure("EXCEED_LENGTH_LIMIT");
		}

		const channelId = randomUUID();
		await saveCall({ channelId, callerId: String(me), calleeId: String(target), maxSeconds, createdAt: Date.now(), answeredAt: null });
		await notifyQueue.add("call_ring", { kind: "call_ring", channelId }, { delay: RING_TIMEOUT_MS, jobId: `ring-${channelId}` });
		const myCard = (await getProfileCards([me])).get(String(me));
		await publishToUser(target, "videocall.v1.incoming_call", { channelId, senderId: String(me), senderDisplayName: myCard?.displayName ?? null, senderProfileImageHash: myCard?.primaryMediaHash ?? null });
		const token = await joinToken(cfg, channelId, String(me), maxSeconds + 120, myCard?.displayName ?? undefined);
		return { result: "SUCCESS", channelId, token, maxSeconds, message: null, provider: "livekit", url: cfg.url };
	});

	app.patch("/v1/video-call/join", auth, async (req) => {
		const me = String(req.auth.userId);
		const cfg = await requireLiveKit();
		const b = z.object({ channelId: z.string().uuid() }).safeParse(req.body);
		if (!b.success) throw errors.badRequest("Invalid request");
		const call = await loadCall(b.data.channelId);
		if (!call || call.calleeId !== me) throw errors.notFound();
		if (!call.answeredAt) {
			call.answeredAt = Date.now();
			await saveCall(call);
			await notifyQueue.add("call_limit", { kind: "call_limit", channelId: call.channelId }, { delay: call.maxSeconds * 1000, jobId: `limit-${call.channelId}` });
		}
		const card = (await getProfileCards([me])).get(me);
		const token = await joinToken(cfg, call.channelId, me, call.maxSeconds + 120, card?.displayName ?? undefined);
		return { result: "SUCCESS", channelId: call.channelId, token, maxSeconds: call.maxSeconds, message: null, provider: "livekit", url: cfg.url };
	});

	app.patch("/v1/video-call/leave", auth, async (req) => {
		const me = String(req.auth.userId);
		const b = z.object({ channelId: z.string().max(100) }).safeParse(req.body);
		if (!b.success) throw errors.badRequest("Invalid request");
		const call = await loadCall(b.data.channelId);
		if (!call || (call.callerId !== me && call.calleeId !== me)) return {};
		// Hanging up a ringing call: the callee declines, the caller cancels.
		await endCall(call.channelId, (c) => (c.answeredAt ? "SUCCESSFUL" : me === c.calleeId ? "DECLINED" : "UNANSWERED"), { cancelled: (c) => !c.answeredAt && me === c.callerId });
		return {};
	});

	/** Fresh token for the caller's own running call (no body, like upstream). */
	app.patch("/v1/video-call", auth, async (req) => {
		const me = String(req.auth.userId);
		const cfg = await requireLiveKit();
		const channel = await redis.get(activeKey(me));
		const call = channel ? await loadCall(channel) : null;
		if (!call) return { result: "NOT_FOUND", token: null, remainingSeconds: null, refreshSeconds: null, message: null };
		const started = call.answeredAt ?? call.createdAt;
		const remaining = Math.max(0, call.maxSeconds - Math.floor((Date.now() - started) / 1000));
		const token = await joinToken(cfg, call.channelId, me, remaining + 120);
		return { result: "SUCCESS", token, remainingSeconds: remaining, refreshSeconds: REFRESH_SECONDS, message: null, provider: "livekit", url: cfg.url };
	});
}
