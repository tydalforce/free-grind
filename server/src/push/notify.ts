import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { redis } from "../cache/redis";
import type { MessageRow } from "../chat/serialize";
import { db } from "../db/client";
import { conversationMembers, devices, pushSettings } from "../db/schema";
import { type PushJob, pushQueue } from "../jobs/queues";
import { publicImageUrl } from "../media/routes";
import { getProfileCards } from "../profiles/cards";
import { isConnected } from "../realtime/bus";
import { loadServiceAccount, sendToToken } from "./fcm";

/**
 * Push notifications (docs/content/grindr-api/push-notifications.md): data-only
 * V2 payloads, every value a string. API code calls the notify* helpers; they
 * only enqueue — the worker sends (deliverPush). Rules:
 *  - chat/tap/view pushes skip users with an open WebSocket (they get it live)
 *  - cancel-only pushes (unsend, clear) always go out
 *  - muted conversations and switched-off push settings are respected
 */

const CHANNEL = { chat: "id_grindr_notifications_channel_individual_v2", tap: "id_grindr_notifications_channel_tap_v2" } as const;

/** FCM configured at all? Cheap check so API calls skip the queue otherwise. */
async function enabled(): Promise<boolean> {
	return (await loadServiceAccount()) != null;
}

async function enqueue(userId: bigint | string, data: Record<string, string | undefined>, skipIfConnected: boolean): Promise<void> {
	if (!(await enabled())) return;
	const clean: Record<string, string> = {};
	for (const [k, v] of Object.entries(data)) if (v != null) clean[k] = v;
	await pushQueue.add("push", { userId: String(userId), data: clean, skipIfConnected });
}

type SettingKey = keyof Omit<typeof pushSettings.$inferSelect, "userId" | "updatedAt">;

/** Null (never set) counts as on, like upstream defaults. */
async function settingOn(userId: bigint, key: SettingKey): Promise<boolean> {
	const [row] = await db.select().from(pushSettings).where(eq(pushSettings.userId, userId)).limit(1);
	return row?.[key] !== false;
}

async function sender(senderId: bigint) {
	const card = (await getProfileCards([senderId])).get(String(senderId));
	const name = card?.displayName?.trim();
	return {
		title: name || "SOMEONE_TITLE",
		translateTitle: name ? "false" : "true",
		imageUrl: card?.primaryMediaHash ? publicImageUrl("thumb", "320x320", card.primaryMediaHash) : undefined,
		name: name ?? null,
	};
}

const base = (notificationId: string = randomUUID()) => ({ version: "2", notificationId, timestamp: String(Date.now()) });

/** Text keys for message types (plain text for Text and replies, like upstream). */
const BODY_KEY: Record<string, string> = {
	Image: "CHAT_IMAGE_NOTIFICATION_BODY",
	ExpiringImage: "CHAT_EXPIRING_IMAGE_NOTIFICATION_BODY",
	Video: "CHAT_VIDEO_NOTIFICATION_BODY",
	PrivateVideo: "CHAT_VIDEO_NOTIFICATION_BODY",
	NonExpiringVideo: "CHAT_VIDEO_NOTIFICATION_BODY",
	Audio: "CHAT_AUDIO_NOTIFICATION_BODY",
	Giphy: "CHAT_GIF_NOTIFICATION_BODY",
	Gaymoji: "CHAT_GAYMOJI_NOTIFICATION_BODY",
	Location: "CHAT_LOCATION_NOTIFICATION_BODY",
	Album: "CHAT_ALBUM_NOTIFICATION_BODY",
	ExpiringAlbum: "CHAT_ALBUM_NOTIFICATION_BODY",
	ExpiringAlbumV2: "CHAT_ALBUM_NOTIFICATION_BODY",
	AlbumContentReaction: "CHAT_ALBUM_CONTENT_REACTION_NOTIFICATION_BODY",
};

/** notificationId of a message's push = the UUID part of its id, so unsend can withdraw it. */
export const messageNotificationId = (messageId: string) => messageId.split(":")[1] ?? messageId;

async function conversationMuted(userId: bigint, conversationId: string): Promise<boolean> {
	const [m] = await db
		.select({ muted: conversationMembers.muted })
		.from(conversationMembers)
		.where(and(eq(conversationMembers.conversationId, conversationId), eq(conversationMembers.userId, userId)))
		.limit(1);
	return !!m?.muted;
}

export async function notifyNewMessage(row: MessageRow): Promise<void> {
	// Call status lines only document the call; the call itself rang already.
	if (row.type === "VideoCall") return;
	if (!(await enabled())) return;
	if (await conversationMuted(row.recipientId, row.conversationId)) return;
	const s = await sender(row.senderId);
	const b = (row.body ?? {}) as Record<string, unknown>;
	let title = s.title;
	let translateTitle = s.translateTitle;
	let body: string;
	let translateBody = "true";
	if (row.type === "Text") [body, translateBody] = [String(b.text ?? ""), "false"];
	else if (row.type === "AlbumContentReply") [body, translateBody] = [String(b.albumContentReply ?? ""), "false"];
	else if (row.type === "ProfilePhotoReply") [body, translateBody] = [String(b.photoContentReply ?? ""), "false"];
	else if (row.type === "RightNowRequest") {
		[title, translateTitle] = ["RIGHT_NOW_REQUEST_APPROVED_NOTIFICATION_TITLE", "true"];
		body = "RIGHT_NOW_REQUEST_APPROVED_NOTIFICATION_BODY";
	} else body = BODY_KEY[row.type] ?? "CHAT_IMAGE_NOTIFICATION_BODY";
	await enqueue(
		row.recipientId,
		{
			...base(messageNotificationId(row.id)),
			timestamp: String(row.createdAt.getTime()),
			title,
			translateTitle,
			body,
			translateBody,
			action: `grindr://conversation?id=${row.conversationId}&senderId=${row.senderId}`,
			channel: CHANNEL.chat,
			imageUrl: s.imageUrl,
			senderId: String(row.senderId),
			quickReply: "true",
		},
		true,
	);
}

/** Someone reacted to `row` (a message of its sender). */
export async function notifyReaction(row: MessageRow, reactorId: bigint): Promise<void> {
	if (reactorId === row.senderId || !(await enabled())) return;
	if (await conversationMuted(row.senderId, row.conversationId)) return;
	const s = await sender(reactorId);
	await enqueue(
		row.senderId,
		{
			...base(),
			title: s.title,
			translateTitle: s.translateTitle,
			body: s.name ? "CHAT_MESSAGE_REACTION_NOTIFICATION_BODY" : "CHAT_MESSAGE_REACTION_NO_NAME_NOTIFICATION_BODY",
			bodyArgs: s.name ? JSON.stringify([s.name]) : undefined,
			translateBody: "true",
			action: `grindr://conversation?id=${row.conversationId}&senderId=${reactorId}`,
			channel: CHANNEL.chat,
			imageUrl: s.imageUrl,
			senderId: String(reactorId),
		},
		true,
	);
}

/** Withdraws the push of an unsent message. */
export async function notifyUnsend(row: MessageRow): Promise<void> {
	await enqueue(row.recipientId, { ...base(), action: `grindr://unsend?notificationId=${messageNotificationId(row.id)}`, channel: CHANNEL.chat }, false);
}

/** Read on one device (or blocked): withdraw that profile's notifications on the others. */
export async function notifyClear(userId: bigint, otherIds: bigint[]): Promise<void> {
	if (!otherIds.length) return;
	await enqueue(userId, { ...base(), action: `grindr://clear?profileIds=${otherIds.join(",")}`, channel: CHANNEL.chat }, false);
}

export async function notifyTap(senderId: bigint, recipientId: bigint): Promise<void> {
	if (!(await enabled()) || !(await settingOn(recipientId, "tapPushNotification"))) return;
	const s = await sender(senderId);
	await enqueue(
		recipientId,
		{ ...base(), title: s.title, translateTitle: s.translateTitle, body: "TAP_NOTIFICATION_BODY", translateBody: "true", action: "grindr://taps-inbox", channel: CHANNEL.tap, imageUrl: s.imageUrl, senderId: String(senderId) },
		true,
	);
}

/** "Your profile got views" — at most once an hour per user. */
export async function notifyViewed(viewedId: bigint): Promise<void> {
	if (!(await enabled()) || !(await settingOn(viewedId, "viewedProfilePushNotification"))) return;
	if ((await redis.set(`push:viewed:${viewedId}`, "1", "EX", 3600, "NX")) !== "OK") return;
	await enqueue(
		viewedId,
		{ ...base(), title: "VIEWED_PROFILE_NOTIFICATION_TITLE", translateTitle: "true", body: "VIEWED_PROFILE_NOTIFICATION_BODY", translateBody: "true", action: "grindr://growth-notification?type=viewed_profile", channel: CHANNEL.chat },
		true,
	);
}

/** New Right Now request for the author's post (same texts as the rightnow.v1.request event). */
export async function notifyRightNowRequest(authorId: bigint, payload: { title: string; body: string; imageUrl: string | null; action: string }): Promise<void> {
	await enqueue(
		authorId,
		{ ...base(), title: payload.title, translateTitle: "true", body: payload.body, translateBody: "true", action: payload.action, channel: CHANNEL.chat, imageUrl: payload.imageUrl ?? undefined },
		true,
	);
}

// --- Worker side ------------------------------------------------------------------

/** Sends a queued push to every device of the user; drops tokens FCM no longer knows. */
export async function deliverPush(job: PushJob): Promise<{ sent: number; skipped?: "connected" | "no_tokens" | "not_configured" }> {
	if (job.skipIfConnected && (await isConnected(job.userId))) return { sent: 0, skipped: "connected" };
	const sa = await loadServiceAccount();
	if (!sa) return { sent: 0, skipped: "not_configured" };
	const tokens = await db
		.select({ token: devices.fcmToken })
		.from(devices)
		.where(and(eq(devices.userId, BigInt(job.userId)), isNotNull(devices.fcmToken), isNull(devices.revokedAt)));
	if (!tokens.length) return { sent: 0, skipped: "no_tokens" };
	let sent = 0;
	const invalid: string[] = [];
	const errors: string[] = [];
	for (const { token } of tokens) {
		if (!token) continue;
		const r = await sendToToken(sa, token, job.data);
		if (r.ok) sent++;
		else if (r.invalidToken) invalid.push(token);
		else errors.push(r.error);
	}
	if (invalid.length) await db.update(devices).set({ fcmToken: null }).where(inArray(devices.fcmToken, invalid));
	// Transient failures (and nothing delivered): let BullMQ retry with backoff.
	if (!sent && errors.length) throw new Error(errors[0]);
	return { sent };
}
