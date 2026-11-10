import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../db/client";
import { media } from "../db/schema";
import { checkCap } from "../entitlements/enforce";
import { errors } from "../lib/errors";
import { type ThumbCoords, processImage } from "./images";
import { mediaQueue } from "../jobs/queues";
import { objectKey, putObject } from "./storage";
import { sniffKind } from "./video";

export type MediaPurpose = "profile" | "chat" | "album" | "rightnow";

/**
 * Hash salt: owner-scoped, and per purpose for private media, so the same
 * photo used as profile picture and in an album/discreet post gets different
 * hashes (no shared row, no way to link a discreet post to a profile).
 */
export function hashSaltFor(ownerId: bigint | string, purpose: string): string {
	return purpose === "profile" ? String(ownerId) : `${ownerId}:${purpose}`;
}
export type MediaRow = typeof media.$inferSelect;

/** Upstream ProfileMedia.state codes (client: MEDIA_MODERATION_STATE). */
export const MEDIA_STATE_CODE = { processing: 0, ready: 1, failed: 2, deleted: 2 } as const;
/** ProfileMedia.type: 1 = image; 2 = video (our extension, profile videos). */
export const MEDIA_TYPE_CODE = { image: 1, video: 2, audio: 3 } as const;

/** Total bytes a user currently stores (cap `user.totalStorageBytes`). */
async function storedBytes(userId: bigint): Promise<number> {
	const [row] = await db
		.select({ n: sql<string>`coalesce(sum(${media.bytes}), 0)` })
		.from(media)
		.where(and(eq(media.ownerId, userId), sql`${media.deletedAt} IS NULL`));
	return Number(row?.n ?? 0);
}

export type StoreOptions = {
	ownerId: bigint;
	purpose: MediaPurpose;
	takenOnGrindr: boolean;
	thumbCoords?: ThumbCoords | null;
	/** Which kinds this endpoint accepts. */
	accept: ("image" | "video" | "audio")[];
	video?: { maxDurationMs: number | null; muteAudio: boolean };
	/**
	 * Store videos/audio as uploaded (ready at once, no transcode). Chat media
	 * works like upstream: "A video is stored as uploaded".
	 */
	storeAsIs?: boolean;
	/** Client-declared Content-Type, used when it agrees with the sniffed kind. */
	declaredMime?: string | null;
	/** Client-declared duration (ms) for audio/video. */
	durationMs?: number | null;
};

const DEFAULT_MIME = { video: "video/mp4", audio: "audio/mp4" } as const;

function mimeFor(kind: "video" | "audio", declared: string | null | undefined): string {
	const base = declared?.split(";")[0]?.trim().toLowerCase();
	if (base && base.startsWith(`${kind}/`) && /^[a-z]+\/[\w.+-]+$/.test(base)) return base;
	return DEFAULT_MIME[kind];
}

/**
 * Stores an upload. Images are processed synchronously (fast, sharp);
 * videos are kept as `original` and transcoded by the worker — the row stays
 * `processing` (state 0) until then.
 */
export async function storeUpload(body: Buffer, opts: StoreOptions): Promise<MediaRow> {
	const kind = sniffKind(body, opts.declaredMime);
	if (!kind || !opts.accept.includes(kind)) throw errors.badRequest("Unsupported media type");
	await checkCap(opts.ownerId, "user.totalStorageBytes", await storedBytes(opts.ownerId), body.length);

	if (kind === "image") {
		const img = await processImage(body, { purpose: opts.purpose, hashSalt: hashSaltFor(opts.ownerId, opts.purpose), thumbCoords: opts.thumbCoords });
		const [row] = await db
			.insert(media)
			.values({
				hash: img.hash,
				ownerId: opts.ownerId,
				kind: "image",
				purpose: opts.purpose,
				state: "ready",
				mime: "image/jpeg",
				bytes: img.bytes,
				width: img.width,
				height: img.height,
				thumbCoords: opts.thumbCoords ?? null,
				takenOnGrindr: opts.takenOnGrindr,
			})
			.onConflictDoUpdate({
				// Same picture uploaded again by the same owner: revive it.
				target: media.hash,
				set: { state: "ready", deletedAt: null, thumbCoords: opts.thumbCoords ?? null },
				where: sql`${media.ownerId} = ${opts.ownerId}`,
			})
			.returning();
		if (!row) throw errors.conflict("media hash belongs to another user");
		return row;
	}

	const hash = createHash("sha1").update(`${hashSaltFor(opts.ownerId, opts.purpose)}:`).update(body).digest("hex");
	const mime = mimeFor(kind, opts.declaredMime);
	const asIs = opts.storeAsIs || kind === "audio";
	await putObject(objectKey(opts.purpose, hash, "original"), body, asIs ? mime : "application/octet-stream");
	const [row] = await db
		.insert(media)
		.values({ hash, ownerId: opts.ownerId, kind, purpose: opts.purpose, state: asIs ? "ready" : "processing", mime: asIs ? mime : DEFAULT_MIME[kind], bytes: body.length, durationMs: opts.durationMs ?? null, takenOnGrindr: opts.takenOnGrindr, thumbCoords: opts.thumbCoords ?? null })
		.onConflictDoUpdate({ target: media.hash, set: { deletedAt: null }, where: sql`${media.ownerId} = ${opts.ownerId}` })
		.returning();
	if (!row) throw errors.conflict("media hash belongs to another user");
	if (kind === "video" && row.state === "processing") {
		await mediaQueue.add(
			"video",
			{ kind: "video", hash, ownerId: String(opts.ownerId), purpose: opts.purpose, maxDurationMs: opts.video?.maxDurationMs ?? null, muteAudio: opts.video?.muteAudio ?? false },
			{ jobId: `video:${hash}` },
		);
	}
	return row;
}
