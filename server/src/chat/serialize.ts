import type { messages } from "../db/schema";
import { albumMessageBody, albumReactionBody } from "../albums/access";
import { signMediaUrl } from "../lib/mediaUrls";
import { getServerSetting } from "../modules/settings/settings";
import { db } from "../db/client";
import { sql } from "drizzle-orm";

/** postStatus of a Right Now post as it is now (ACTIVE/HIDDEN past expiration → EXPIRED). */
async function currentPostStatus(postId: unknown, stored: unknown): Promise<string | null> {
	const id = Number(postId);
	if (!Number.isSafeInteger(id)) return typeof stored === "string" ? stored : null;
	const [row] = (await db.execute(sql`SELECT status, expiration FROM rightnow_posts WHERE id = ${id}`)) as unknown as { status: string; expiration: string | null }[];
	if (!row) return "EXPIRED";
	const ended = row.expiration != null && new Date(row.expiration).getTime() <= Date.now();
	return (row.status === "ACTIVE" || row.status === "HIDDEN") && ended ? "EXPIRED" : row.status;
}

export type MessageRow = typeof messages.$inferSelect;
export type Reaction = { profileId: number; reactionType: number };

/** "Unlimited" views are reported like upstream: capped at Int32 max. */
export const UNLIMITED_VIEWS = 2_147_483_647;

const CHAT1_TYPE: Record<string, string> = {
	Text: "text",
	Image: "image",
	ExpiringImage: "expiring_image",
	Video: "video",
	PrivateVideo: "private_video",
	NonExpiringVideo: "video",
	Audio: "audio",
	Location: "map",
	Giphy: "giphy",
	Gaymoji: "gaymoji",
	Album: "album_share",
	ExpiringAlbum: "expiring_album",
	ExpiringAlbumV2: "expiring_album",
	AlbumContentReaction: "album_content_reaction",
	AlbumContentReply: "album_content_reply",
	ProfilePhotoReply: "profile_photo_reply",
	VideoCall: "video_call",
};

const DYNAMIC_TYPES = new Set(["Album", "ExpiringAlbum", "ExpiringAlbumV2"]);

export function chat1TypeOf(row: Pick<MessageRow, "type" | "unsent" | "body">): string {
	if (row.unsent) return "retracted";
	if (row.type === "Video") {
		const max = (row.body as { maxViews?: number | null } | null)?.maxViews;
		return max != null && max < UNLIMITED_VIEWS ? "expiring_video" : "video";
	}
	return CHAT1_TYPE[row.type] ?? "unknown";
}

type Body = Record<string, unknown>;

export type SerializeOptions = {
	/** Set when this response hands the viewer a single expiring view (GET single message). */
	grantedView?: boolean;
	/** The replied-to message, already loaded (one level only). */
	replyTo?: MessageRow | null;
	nowMs?: number;
};

async function chatTtl(): Promise<number> {
	return (await getServerSetting<number>("media.url.chatTtlSec")) ?? 900;
}

async function signedFor(row: MessageRow, viewerId: bigint, opts: { notAfterMs?: number; nowMs?: number } = {}) {
	if (!row.mediaHash) return { url: null as string | null, expiresAt: null as number | null };
	const { url, expiresAt } = await signMediaUrl({
		uploaderProfileId: String(row.senderId),
		mediaHash: row.mediaHash,
		ttlSeconds: await chatTtl(),
		notAfterMs: opts.notAfterMs,
		nowMs: opts.nowMs,
	});
	return { url, expiresAt };
}

async function serializeBody(row: MessageRow, viewerId: bigint, opts: SerializeOptions): Promise<Body | null> {
	if (row.unsent || row.body == null) return null;
	const b = row.body as Body;
	const isSender = row.senderId === viewerId;
	const now = opts.nowMs ?? Date.now();

	switch (row.type) {
		case "Image": {
			const { url } = await signedFor(row, viewerId, { nowMs: now });
			return { mediaId: b.mediaId, width: b.width ?? null, height: b.height ?? null, url, imageHash: b.mediaHash, takenOnGrindr: b.takenOnGrindr ?? null, createdAt: b.createdAt ?? null };
		}
		case "ExpiringImage": {
			const maxViews = Number(b.maxViews ?? 1);
			const remaining = Math.max(0, maxViews - row.viewsUsed);
			const durationMs = Number(b.durationMs ?? 10_000);
			if (isSender || opts.grantedView) {
				const grace = ((await getServerSetting<number>("media.url.expiringGraceSec")) ?? 5) * 1000;
				const signed = await signedFor(row, viewerId, { nowMs: now, notAfterMs: isSender ? undefined : now + durationMs + grace });
				return { mediaId: b.mediaId, url: signed.url, width: b.width ?? null, height: b.height ?? null, duration: durationMs, viewsRemaining: remaining, expiresAt: signed.expiresAt, viewed: row.viewsUsed > 0 };
			}
			return { mediaId: b.mediaId, url: null, width: b.width ?? null, height: b.height ?? null, duration: remaining > 0 ? durationMs : -1, viewsRemaining: remaining, expiresAt: null, viewed: row.viewsUsed > 0 };
		}
		case "Video":
		case "PrivateVideo":
		case "NonExpiringVideo": {
			const maxViews = b.maxViews == null ? null : Number(b.maxViews);
			const remaining = maxViews == null ? UNLIMITED_VIEWS : Math.max(0, maxViews - row.viewsUsed);
			const base = { maxViews, looping: b.looping ?? null, viewsRemaining: remaining, ...(row.type === "PrivateVideo" ? { viewCount: row.viewsUsed } : {}) };
			if (isSender || opts.grantedView) {
				const signed = await signedFor(row, viewerId, { nowMs: now });
				return { mediaId: b.mediaId, url: signed.url, contentType: b.contentType ?? "video/mp4", length: b.length ?? 0, ...base, expiresAt: signed.expiresAt };
			}
			// Upstream: a received video carries no url in the message list; the
			// single-message GET hands it out (and uses one of viewsRemaining).
			return { mediaId: null, url: null, contentType: null, length: 0, ...base, expiresAt: null };
		}
		case "Audio": {
			const signed = await signedFor(row, viewerId, { nowMs: now });
			return { mediaId: b.mediaId, mediaHash: b.mediaHash ?? null, url: signed.url, contentType: b.contentType ?? "audio/mp4", length: b.length ?? null, expiresAt: signed.expiresAt };
		}
		case "Album":
		case "ExpiringAlbum":
		case "ExpiringAlbumV2":
			return albumMessageBody(Number(b.albumId), row.senderId, row.recipientId, viewerId);
		case "AlbumContentReaction":
		case "AlbumContentReply":
			return albumReactionBody(b as { albumId: number; albumContentId: number; albumContentReply?: string }, viewerId);
		case "RightNowRequest":
			// The post's current status, not the one at accepting (it expires after an hour).
			return { ...b, postStatus: await currentPostStatus(b.postId, b.postStatus) };
		default:
			return b;
	}
}

export async function serializeMessage(row: MessageRow, viewerId: bigint, opts: SerializeOptions = {}): Promise<Record<string, unknown>> {
	const replyTo = opts.replyTo && !opts.replyTo.hiddenFor.includes(viewerId) ? await serializeMessage(opts.replyTo, viewerId, { nowMs: opts.nowMs }) : null;
	return {
		messageId: row.id,
		conversationId: row.conversationId,
		senderId: Number(row.senderId),
		timestamp: row.createdAt.getTime(),
		unsent: row.unsent,
		reactions: (row.reactions as Reaction[]) ?? [],
		type: row.type,
		chat1Type: chat1TypeOf(row),
		body: await serializeBody(row, viewerId, opts),
		replyToMessage: replyTo,
		replyPreview: null,
		dynamic: DYNAMIC_TYPES.has(row.type),
	};
}

/** ConversationPreview (inbox); never carries signed URLs. Unsent → null like upstream. */
export function buildPreview(row: MessageRow | null | undefined): Record<string, unknown> | null {
	if (!row || row.unsent) return null;
	const b = (row.body ?? {}) as Body;
	const uuid = row.id.split(":")[1] ?? row.id;
	let url: unknown = null;
	if (row.type === "Image") url = b.mediaHash ?? null;
	else if (row.type === "Giphy") url = b.urlPath ?? null;
	else if (row.type === "Gaymoji") url = b.imageHash ?? null;
	return {
		conversationId: { value: row.conversationId },
		messageId: row.id,
		chat1MessageId: uuid,
		senderId: Number(row.senderId),
		reactorId: null,
		reactionType: null,
		reactionTimestamp: null,
		type: row.type,
		chat1Type: chat1TypeOf(row),
		text: row.type === "Text" ? ((b.text as string) ?? null) : null,
		url,
		lat: row.type === "Location" ? (b.lat ?? null) : null,
		lon: row.type === "Location" ? (b.lon ?? null) : null,
		albumId: b.albumId ?? null,
		albumContentId: row.type === "AlbumContentReply" ? (b.albumContentId ?? null) : null,
		albumContentReply: row.type === "AlbumContentReply" ? (b.albumContentReply ?? null) : null,
		duration: row.type === "Audio" ? (b.length ?? null) : null,
		imageHash: row.type === "ProfilePhotoReply" ? (b.imageHash ?? null) : null,
		photoContentReply: row.type === "ProfilePhotoReply" ? (b.photoContentReply ?? null) : null,
	};
}
