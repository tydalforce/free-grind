import { sql } from "drizzle-orm";
import { redis } from "../cache/redis";
import { db } from "../db/client";
import { pushQueue } from "../jobs/queues";
import { publicImageUrl } from "../media/routes";
import { getProfileCards } from "../profiles/cards";
import { loadServiceAccount } from "./fcm";

/**
 * "Growth" pushes the app offers toggles for (/v5/push-settings):
 *  - favoritePushNotification: a favorite came online (several within an hour → one "multiple" push)
 *  - tappedPushNotification: someone I tapped (last 7 days) came online
 *  - mediaRecipientPushNotification: someone I sent pics/videos to came online
 *  - recommendedPushNotification: a profile nearby I haven't talked to came online
 *  - unreadChatsPushNotification: reminder about unread chats
 * Each is throttled per recipient and skipped while their app is connected.
 * Payloads follow upstream: translated title/body keys, a growth-notification deeplink.
 */

const CHANNEL = "id_grindr_notifications_channel_individual_v2";
const RECOMMEND_RADIUS_M = 3000;
const RECOMMEND_MAX = 10;
const FANOUT_LIMIT = 500;

type GrowthType = "favorite_online" | "multiple_favorites_online" | "tapped_online" | "media_recipient_online" | "recommended_online" | "unread_chats";

const KEYS: Record<GrowthType, string> = {
	favorite_online: "FAVORITE_ONLINE_NOTIFICATION",
	multiple_favorites_online: "MULTIPLE_FAVORITES_ONLINE_NOTIFICATION",
	tapped_online: "TAPPED_ONLINE_NOTIFICATION",
	media_recipient_online: "MEDIA_RECIPIENT_ONLINE_NOTIFICATION",
	recommended_online: "RECOMMENDED_ONLINE_NOTIFICATION",
	unread_chats: "UNREAD_CHATS_NOTIFICATION",
};

async function growthPush(recipient: string, type: GrowthType, profile: { id: string; imageUrl?: string } | null): Promise<void> {
	const key = KEYS[type];
	const data: Record<string, string> = {
		version: "2",
		notificationId: crypto.randomUUID(),
		timestamp: String(Date.now()),
		title: `${key}_TITLE`,
		translateTitle: "true",
		body: `${key}_BODY`,
		translateBody: "true",
		action: profile ? `grindr://growth-notification?type=${type}&profileID=${profile.id}` : `grindr://growth-notification?type=${type}`,
		channel: CHANNEL,
	};
	if (profile) data.senderId = profile.id;
	if (profile?.imageUrl) data.imageUrl = profile.imageUrl;
	await pushQueue.add("push", { userId: recipient, data, skipIfConnected: true });
}

/** Sets a throttle key; true when this push may go out now. */
async function once(key: string, seconds: number): Promise<boolean> {
	return (await redis.set(key, "1", "EX", seconds, "NX")) === "OK";
}

/** Recipients with the setting on (null = on), excluding blocks either way. */
async function eligible(ids: string[], column: string, subject: string): Promise<string[]> {
	if (!ids.length) return [];
	const rows = (await db.execute(sql`
		SELECT r.id FROM unnest(${`{${ids.join(",")}}`}::bigint[]) AS r(id)
		LEFT JOIN push_settings s ON s.user_id = r.id
		WHERE coalesce(${sql.raw(`s.${column}`)}, true)
		  AND NOT EXISTS (SELECT 1 FROM blocks b WHERE (b.owner_id = r.id AND b.target_id = ${subject}::bigint) OR (b.owner_id = ${subject}::bigint AND b.target_id = r.id))
		  AND EXISTS (SELECT 1 FROM devices d WHERE d.user_id = r.id AND d.fcm_token IS NOT NULL AND d.revoked_at IS NULL)`)) as unknown as { id: string }[];
	return rows.map((r) => String(r.id));
}

/** Worker: `userId` just came online — tell the people who care. */
export async function notifyCameOnline(userId: string): Promise<number> {
	if (!(await loadServiceAccount())) return 0;
	const card = (await getProfileCards([userId])).get(userId);
	if (!card || card.deleted || card.banned) return 0;
	const profile = { id: userId, imageUrl: card.primaryMediaHash ? publicImageUrl("thumb", "320x320", card.primaryMediaHash) : undefined };
	const notified = new Set<string>([userId]);
	let sent = 0;

	// Favorites (a favorite push wins over the other kinds for the same person).
	const favOwners = (await db.execute(sql`SELECT owner_id::text AS id FROM favorites WHERE target_id = ${userId}::bigint LIMIT ${FANOUT_LIMIT}`)) as unknown as { id: string }[];
	for (const owner of await eligible(favOwners.map((r) => r.id), "favorite_push", userId)) {
		notified.add(owner);
		if (!(await once(`push:fav:${owner}:${userId}`, 12 * 3600))) continue;
		if (await once(`push:fav:any:${owner}`, 3600)) await growthPush(owner, "favorite_online", profile);
		else if (await once(`push:fav:multi:${owner}`, 3600)) await growthPush(owner, "multiple_favorites_online", null);
		else continue;
		sent++;
	}

	// People who tapped them in the last 7 days.
	const tappers = (await db.execute(sql`
		SELECT sender_id::text AS id FROM taps WHERE recipient_id = ${userId}::bigint AND created_at > now() - interval '7 days' LIMIT ${FANOUT_LIMIT}`)) as unknown as { id: string }[];
	for (const t of await eligible(tappers.map((r) => r.id).filter((id) => !notified.has(id)), "tapped_push", userId)) {
		notified.add(t);
		if (!(await once(`push:tapped:${t}:${userId}`, 24 * 3600))) continue;
		await growthPush(t, "tapped_online", profile);
		sent++;
	}

	// People who sent them pictures/videos in a chat.
	const senders = (await db.execute(sql`
		SELECT DISTINCT m.user_id::text AS id
		FROM conversation_members m
		JOIN chat_media_usage u ON u.owner_id = m.user_id AND u.conversation_id = m.conversation_id
		WHERE m.other_id = ${userId}::bigint LIMIT ${FANOUT_LIMIT}`)) as unknown as { id: string }[];
	for (const s of await eligible(senders.map((r) => r.id).filter((id) => !notified.has(id)), "media_recipient_push", userId)) {
		notified.add(s);
		if (!(await once(`push:media:${s}:${userId}`, 24 * 3600))) continue;
		await growthPush(s, "media_recipient_online", profile);
		sent++;
	}

	// Nearby profiles without a chat with them yet ("your type is nearby"), at most one a day each.
	const nearby = (await db.execute(sql`
		SELECT p.user_id::text AS id
		FROM profiles me
		JOIN profiles p ON p.user_id <> me.user_id AND p.public_location IS NOT NULL
		  AND ST_DWithin(p.public_location, me.public_location, ${RECOMMEND_RADIUS_M})
		WHERE me.user_id = ${userId}::bigint AND me.public_location IS NOT NULL AND me.primary_media_hash IS NOT NULL
		  AND NOT EXISTS (SELECT 1 FROM conversation_members c WHERE c.user_id = p.user_id AND c.other_id = me.user_id)
		  AND NOT EXISTS (SELECT 1 FROM hides h WHERE h.owner_id = p.user_id AND h.target_id = me.user_id)
		ORDER BY p.public_location <-> me.public_location
		LIMIT ${RECOMMEND_MAX * 3}`)) as unknown as { id: string }[];
	let recommended = 0;
	for (const r of await eligible(nearby.map((x) => x.id).filter((id) => !notified.has(id)), "recommended_push", userId)) {
		if (recommended >= RECOMMEND_MAX) break;
		if (!(await once(`push:rec:${r}`, 24 * 3600))) continue;
		await growthPush(r, "recommended_online", profile);
		recommended++;
		sent++;
	}
	return sent;
}

/** Worker (hourly): unread chats waiting for 6 h – 7 days and not seen since → one reminder a day. */
export async function sweepUnreadChatReminders(limit = 1000): Promise<number> {
	if (!(await loadServiceAccount())) return 0;
	const rows = (await db.execute(sql`
		SELECT DISTINCT m.user_id::text AS id
		FROM conversation_members m
		JOIN profiles p ON p.user_id = m.user_id
		WHERE m.unread_count > 0 AND NOT m.muted
		  AND m.last_activity_at < now() - interval '6 hours' AND m.last_activity_at > now() - interval '7 days'
		  AND p.last_seen_at < m.last_activity_at
		LIMIT ${limit}`)) as unknown as { id: string }[];
	let sent = 0;
	for (const id of await eligible(rows.map((r) => r.id), "unread_chats_push", "0")) {
		if (!(await once(`push:unread:${id}`, 24 * 3600))) continue;
		await growthPush(id, "unread_chats", null);
		sent++;
	}
	return sent;
}
