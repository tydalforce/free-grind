import { Worker } from "bullmq";
import { eq } from "drizzle-orm";
import { startInvalidationListener } from "./cache/local";
import { closeRedis } from "./cache/redis";
import { closeDb, db } from "./db/client";
import { media } from "./db/schema";
import { type MediaJob, type NotifyJob, type PushJob, connection } from "./jobs/queues";
import { notifyCameOnline, sweepUnreadChatReminders } from "./push/growth";
import { handleCallTimer } from "./videocall/routes";
import { runBroadcast } from "./push/broadcast";
import { deliverPush } from "./push/notify";
import { processImage } from "./media/images";
import { hashSaltFor } from "./media/service";
import { objectFile, objectKey, putObject } from "./media/storage";
import { ffmpegAvailable, transcode } from "./media/video";
import { sweepExpiredBans } from "./moderation/bans";
import { PARTITIONED_TABLES, dropExpiredPartitions, ensureMonthlyPartitions } from "./db/partitions";
import { drainSecurityEvents } from "./jobs/securityEventsDrain";
import { getServerSetting } from "./modules/settings/settings";
import { sweepExpiredAlbumShares } from "./albums/access";
import { refreshDynamic } from "./chat/service";
import { sweepExpiredRightNowPosts } from "./rightnow/routes";
import { sweepExpiringMedia } from "./media/retention";
import { sweepExpiredGrants } from "./jobs/expiryCleanup";

/**
 * Background worker: video transcoding (+ poster), later push delivery,
 * expiry/retention cleanup and outbox draining. Scales separately from the API.
 */

await startInvalidationListener();
const hasFfmpeg = await ffmpegAvailable();
if (!hasFfmpeg) console.warn("[worker] ffmpeg/ffprobe not found — video jobs will fail until installed");

export async function processVideoJob(job: MediaJob): Promise<void> {
	const original = new Uint8Array(await objectFile(objectKey(job.purpose, job.hash, "original")).arrayBuffer());
	const result = await transcode(original, { maxDurationMs: job.maxDurationMs ?? undefined, muteAudio: job.muteAudio });
	await putObject(objectKey(job.purpose, job.hash, "video.mp4"), result.mp4, "video/mp4");
	// Poster goes through the normal image pipeline (variants + thumbs), so
	// /images/profile|thumb/{size}/{videoHash} can serve it.
	const poster = await processImage(result.poster, { purpose: job.purpose, hashSalt: hashSaltFor(job.ownerId, job.purpose) });
	await db
		.insert(media)
		.values({ hash: poster.hash, ownerId: BigInt(job.ownerId), kind: "image", purpose: job.purpose as "profile", state: "ready", mime: "image/jpeg", bytes: poster.bytes, width: poster.width, height: poster.height })
		.onConflictDoNothing();
	await db
		.update(media)
		.set({ state: "ready", bytes: result.mp4.length, width: result.probe.width, height: result.probe.height, durationMs: result.probe.durationMs, posterHash: poster.hash })
		.where(eq(media.hash, job.hash));
}

const worker = new Worker<MediaJob>(
	"media",
	async (job) => {
		if (job.data.kind === "video") {
			if (!hasFfmpeg) throw new Error("ffmpeg not installed");
			await processVideoJob(job.data);
		}
	},
	{ connection, concurrency: Number(process.env.MEDIA_CONCURRENCY ?? 2) },
);

const notifyWorker = new Worker<NotifyJob>(
	"notify",
	async (job) => {
		if (job.data.kind === "came_online") return notifyCameOnline(job.data.userId);
		if (job.data.kind === "call_ring") return handleCallTimer(job.data.channelId, "ring");
		if (job.data.kind === "call_limit") return handleCallTimer(job.data.channelId, "limit");
		if (job.data.kind === "broadcast") return runBroadcast(job.data.title, job.data.body, job.data.target);
	},
	{ connection, concurrency: Number(process.env.NOTIFY_CONCURRENCY ?? 4) },
);

const pushWorker = new Worker<PushJob>("push", async (job) => deliverPush(job.data), { connection, concurrency: Number(process.env.PUSH_CONCURRENCY ?? 8) });
pushWorker.on("failed", (job, err) => {
	if (job) console.error(`[worker] push ${job.id} failed (attempt ${job.attemptsMade}):`, err.message);
});

worker.on("failed", async (job, err) => {
	if (!job) return;
	console.error(`[worker] ${job.name} ${job.id} failed (attempt ${job.attemptsMade}):`, err.message);
	if (job.attemptsMade >= (job.opts.attempts ?? 1)) {
		await db.update(media).set({ state: "failed", failureReason: err.message.slice(0, 500) }).where(eq(media.hash, job.data.hash));
	}
});

// Periodic housekeeping (cheap, idempotent; safe with several workers).
const consumer = `worker-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
const sweep = setInterval(() => {
	void sweepExpiredBans().catch((e) => console.error("[worker] ban sweep failed:", e));
	void drainSecurityEvents(consumer).catch((e) => console.error("[worker] security event drain failed:", e));
	void sweepExpiredGrants().catch((e) => console.error("[worker] expired roles/overrides sweep failed:", e));
	void sweepExpiredRightNowPosts().catch((e) => console.error("[worker] right now sweep failed:", e));
	void sweepExpiredAlbumShares(async (owner, recipient) => {
		await refreshDynamic(owner, recipient, "ExpiringAlbumV2");
		await refreshDynamic(recipient, owner, "ExpiringAlbumV2");
	}).catch((e) => console.error("[worker] album share sweep failed:", e));
}, 60_000);

async function maintainPartitions(): Promise<void> {
	const retention: Record<string, number> = {
		admin_audit_log: (await getServerSetting<number>("retention.auditLogMonths")) ?? 24,
		security_events: (await getServerSetting<number>("retention.securityEventsMonths")) ?? 12,
	};
	for (const table of PARTITIONED_TABLES) {
		await ensureMonthlyPartitions(table);
		const dropped = await dropExpiredPartitions(table, retention[table] ?? 12);
		if (dropped.length) console.log(`[worker] dropped partitions: ${dropped.join(", ")}`);
	}
}
void maintainPartitions().catch((e) => console.error("[worker] partition maintenance failed:", e));
// Expiring pics/videos past retention: hourly is plenty (retention is in days).
const sweepExpiring = () => {
	void sweepExpiringMedia().catch((e) => console.error("[worker] expiring media sweep failed:", e));
	void sweepUnreadChatReminders().catch((e) => console.error("[worker] unread chat reminders failed:", e));
};
sweepExpiring();
const retentionTimer = setInterval(sweepExpiring, 3_600_000);

const partitionTimer = setInterval(() => {
	void maintainPartitions().catch((e) => console.error("[worker] partition maintenance failed:", e));
}, 6 * 3_600_000);

console.log("[worker] started");

for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.on(signal, async () => {
		clearInterval(sweep);
		clearInterval(partitionTimer);
		clearInterval(retentionTimer);
		await Promise.all([worker.close(), pushWorker.close(), notifyWorker.close()]);
		await Promise.all([closeDb(), closeRedis()]);
		process.exit(0);
	});
}
