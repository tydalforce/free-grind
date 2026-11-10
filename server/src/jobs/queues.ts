import { Queue } from "bullmq";
import { config } from "../config";

/**
 * Job queues (BullMQ on Redis). API instances only enqueue; the worker
 * process (src/worker.ts) runs the jobs, scaled independently.
 */
export const connection = { url: config.REDIS_URL, maxRetriesPerRequest: null } as const;

export type MediaJob = { kind: "video"; hash: string; ownerId: string; purpose: string; maxDurationMs: number | null; muteAudio: boolean };

export const mediaQueue = new Queue<MediaJob>("media", {
	connection,
	defaultJobOptions: { attempts: 3, backoff: { type: "exponential", delay: 10_000 }, removeOnComplete: 1000, removeOnFail: 5000 },
});

/** One push to all devices of a user; `skipIfConnected`: the open app gets it over the WebSocket. */
export type PushJob = { userId: string; data: Record<string, string>; skipIfConnected: boolean };

export const pushQueue = new Queue<PushJob>("push", {
	connection,
	defaultJobOptions: { attempts: 4, backoff: { type: "exponential", delay: 5_000 }, removeOnComplete: 1000, removeOnFail: 5000 },
});

/** Fan-out work after an event, done in the worker (who should be notified). */
export type BroadcastTarget = { kind: "all" } | { kind: "role"; role: string } | { kind: "users"; userIds: string[] };
export type NotifyJob =
	| { kind: "came_online"; userId: string }
	| { kind: "call_ring" | "call_limit"; channelId: string }
	| { kind: "broadcast"; title: string; body: string; target: BroadcastTarget };

export const notifyQueue = new Queue<NotifyJob>("notify", {
	connection,
	defaultJobOptions: { attempts: 2, backoff: { type: "fixed", delay: 10_000 }, removeOnComplete: 1000, removeOnFail: 1000 },
});

export async function closeQueues(): Promise<void> {
	await Promise.all([mediaQueue.close(), pushQueue.close(), notifyQueue.close()]);
}
