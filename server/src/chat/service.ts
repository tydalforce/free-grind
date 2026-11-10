import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/client";
import { chatMediaUsage, conversationMembers, conversations, media, messages, users } from "../db/schema";
import { allowedValues, capValue, checkCap, consume, durationSeconds, isFeatureEnabled, release, requireEnabled } from "../entitlements/enforce";
import { errors, problem } from "../lib/errors";
import { getProfileCard } from "../profiles/cards";
import { isBlockedEitherWay } from "../profiles/relations";
import { publishToUser } from "../realtime/bus";
import { notifyClear, notifyNewMessage, notifyReaction, notifyUnsend } from "../push/notify";
import { validateAlbumReaction } from "../albums/access";
import { conversationIdFor, newMessageId, otherParticipant, parseMessageId } from "./ids";
import { type MessageRow, type Reaction, UNLIMITED_VIEWS, serializeMessage } from "./serialize";

/**
 * Chat domain logic shared by REST and the WebSocket gateway. Every mutation
 * commits first, then fans out per recipient (each serialized for its viewer,
 * because media URLs are signed for one viewer).
 */

// --- Loading ------------------------------------------------------------------

/** Loads messages by upstream id; the id's timestamp pins the partition. */
export async function loadMessages(ids: string[]): Promise<Map<string, MessageRow>> {
	const parsed = [...new Set(ids)].map((id) => ({ id, p: parseMessageId(id) })).filter((x) => x.p);
	if (!parsed.length) return new Map();
	const rows = await db
		.select()
		.from(messages)
		.where(
			sql`(${messages.id}, ${messages.createdAt}) IN (${sql.join(
				parsed.map((x) => sql`(${x.id}, ${new Date(x.p!.ts).toISOString()}::timestamptz)`),
				sql`, `,
			)})`,
		);
	return new Map(rows.map((r) => [r.id, r]));
}

export async function loadMessage(id: string): Promise<MessageRow | null> {
	return (await loadMessages([id])).get(id) ?? null;
}

/** Message of this conversation that `viewer` can still see, or null. */
async function visibleMessage(conversationId: string, messageId: string, viewer: bigint): Promise<MessageRow | null> {
	const row = await loadMessage(messageId);
	if (!row || row.conversationId !== conversationId || row.hiddenFor.includes(viewer)) return null;
	return row;
}

export async function serializeWithReplies(rows: MessageRow[], viewer: bigint, opts: { grantedViewFor?: Set<string> } = {}) {
	const replyIds = rows.map((r) => r.replyToId).filter((x): x is string => !!x);
	const replies = replyIds.length ? await loadMessages(replyIds) : new Map<string, MessageRow>();
	return Promise.all(
		rows.map((r) => serializeMessage(r, viewer, { replyTo: r.replyToId ? (replies.get(r.replyToId) ?? null) : null, grantedView: opts.grantedViewFor?.has(r.id) })),
	);
}

async function fanoutMessage(row: MessageRow): Promise<void> {
	const replyTo = row.replyToId ? await loadMessage(row.replyToId) : null;
	await Promise.all(
		[row.senderId, row.recipientId].map(async (uid) => {
			if (row.hiddenFor.includes(uid)) return;
			await publishToUser(uid, "chat.v1.message_sent", await serializeMessage(row, uid, { replyTo }));
		}),
	);
}

// --- Send -----------------------------------------------------------------------

export const sendSchema = z.object({
	type: z.string().min(1).max(40),
	target: z.object({ type: z.enum(["Direct", "Group", "HumanWingman"]), targetId: z.union([z.number().int(), z.string().regex(/^\d{1,19}$/)]) }),
	body: z.record(z.string(), z.unknown()).nullable(),
	replyToMessageId: z.string().max(80).nullable().optional(),
	ref: z.unknown().optional(),
});

/** Types a client may send (album messages arrive via album sharing, milestone 5). */
const SENDABLE = new Set(["Text", "Location", "Gaymoji", "Giphy", "ProfilePhotoReply", "Image", "ExpiringImage", "Audio", "Video", "AlbumContentReaction", "AlbumContentReply"]);
const GIPHY_HOST = /^https:\/\/media[0-4]?\.giphy\.com\//;

type MediaRow = typeof media.$inferSelect;
type Charge = { key: string; n: number };

async function chatMedia(sender: bigint, body: Record<string, unknown>, kind: MediaRow["kind"]): Promise<MediaRow> {
	const mediaId = Number(body.mediaId);
	if (!Number.isSafeInteger(mediaId) || mediaId <= 0) throw errors.badRequest("Invalid request");
	const [row] = await db.select().from(media).where(and(eq(media.mediaId, mediaId), eq(media.ownerId, sender))).limit(1);
	if (!row || row.deletedAt || row.purpose !== "chat" || row.kind !== kind || row.state !== "ready") throw errors.badRequest("Invalid request");
	return row;
}

const str = (v: unknown, max: number) => (typeof v === "string" && v.length > 0 && v.length <= max ? v : null);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Validates the client body and builds the stored (viewer-independent) body. */
async function buildBody(sender: bigint, recipient: bigint, type: string, body: Record<string, unknown> | null, charges: Charge[]): Promise<{ stored: Record<string, unknown>; mediaHash: string | null }> {
	const b = body ?? {};
	const bad = () => errors.badRequest("Invalid request");
	switch (type) {
		case "Text": {
			const text = str(b.text, 5000);
			if (!text || !text.trim()) throw bad();
			return { stored: { text }, mediaHash: null };
		}
		case "Location": {
			const lat = num(b.lat);
			const lon = num(b.lon);
			if (lat == null || lon == null || Math.abs(lat) > 90 || Math.abs(lon) > 180) throw bad();
			return { stored: { lat, lon }, mediaHash: null };
		}
		case "Gaymoji": {
			const imageHash = str(b.imageHash, 200);
			if (!imageHash || !/^gaymoji\/[\w.\- ]+$/.test(imageHash)) throw bad();
			return { stored: { imageHash }, mediaHash: null };
		}
		case "Giphy": {
			const id = str(b.id, 100);
			const urlPath = str(b.urlPath, 1000);
			const stillPath = str(b.stillPath, 1000);
			const previewPath = str(b.previewPath, 1000) ?? urlPath;
			if (!id || !urlPath || !stillPath || ![urlPath, stillPath, previewPath].every((u) => u && GIPHY_HOST.test(u))) throw bad();
			return { stored: { id, urlPath, stillPath, previewPath, width: num(b.width) ?? 0, height: num(b.height) ?? 0, imageHash: `giphy/${id}` }, mediaHash: null };
		}
		case "ProfilePhotoReply": {
			const imageHash = str(b.imageHash, 128);
			const reply = str(b.photoContentReply, 5000);
			if (!imageHash || !reply) throw bad();
			return { stored: { imageHash, photoContentReply: reply }, mediaHash: null };
		}
		case "Image": {
			const m = await chatMedia(sender, b, "image");
			return { stored: { mediaId: m.mediaId, mediaHash: m.hash, width: m.width, height: m.height, takenOnGrindr: m.takenOnGrindr, createdAt: m.createdAt.getTime() }, mediaHash: m.hash };
		}
		case "ExpiringImage": {
			await requireEnabled(sender, "chat.expiringImages.enabled");
			const m = await chatMedia(sender, b, "image");
			// Upstream: the server picks 10 s and one view; admins may only lower them.
			const durationMs = Math.min(10_000, (await capValue(sender, "chat.expiring.durationSec")) * 1000);
			const maxViews = 1;
			charges.push({ key: "chat.expiringImages.perDay", n: 1 });
			return { stored: { mediaId: m.mediaId, mediaHash: m.hash, width: m.width, height: m.height, durationMs, maxViews }, mediaHash: m.hash };
		}
		case "Audio": {
			const m = await chatMedia(sender, b, "audio");
			return { stored: { mediaId: m.mediaId, mediaHash: m.hash, contentType: m.mime, length: m.durationMs }, mediaHash: m.hash };
		}
		case "Video": {
			await requireEnabled(sender, "chat.video.send");
			const m = await chatMedia(sender, b, "video");
			let maxViews: number | null = b.maxViews == null ? null : Number(b.maxViews);
			if (maxViews != null && (!Number.isSafeInteger(maxViews) || maxViews < 0)) throw bad();
			if (maxViews != null && maxViews >= UNLIMITED_VIEWS) maxViews = null;
			if (maxViews != null) {
				await requireEnabled(sender, "chat.expiringVideos.enabled");
				maxViews = Math.min(maxViews, await capValue(sender, "chat.expiring.maxViews"));
				charges.push({ key: "chat.expiringVideos.perDay", n: 1 });
			}
			return { stored: { mediaId: m.mediaId, mediaHash: m.hash, contentType: m.mime, length: m.durationMs ?? 0, maxViews, looping: b.looping === true }, mediaHash: m.hash };
		}
		case "AlbumContentReaction":
		case "AlbumContentReply": {
			const albumId = Number(b.albumId);
			const albumContentId = Number(b.albumContentId);
			if (!Number.isSafeInteger(albumId) || !Number.isSafeInteger(albumContentId)) throw bad();
			await validateAlbumReaction(sender, recipient, albumId, albumContentId);
			if (type === "AlbumContentReaction") return { stored: { albumId, albumContentId }, mediaHash: null };
			const reply = str(b.albumContentReply, 5000);
			if (!reply) throw bad();
			return { stored: { albumId, albumContentId, albumContentReply: reply }, mediaHash: null };
		}
		default:
			throw bad();
	}
}

export type SendInput = z.infer<typeof sendSchema>;

export async function sendMessage(senderId: bigint, input: SendInput, opts: { allowReply: boolean }): Promise<Record<string, unknown>> {
	if (input.target.type !== "Direct") throw errors.badRequest("Invalid request");
	// Upstream: replyToMessageId only works over the WebSocket; HTTP answers 400.
	if (input.replyToMessageId && !opts.allowReply) throw errors.badRequest("Invalid request");
	const recipientId = BigInt(input.target.targetId);
	if (recipientId === senderId) throw errors.badRequest("Invalid request");
	if (!SENDABLE.has(input.type)) throw errors.badRequest("Invalid request");

	const allowed = await allowedValues(senderId, "chat.messageTypes");
	if (allowed && !allowed.includes(input.type)) throw errors.tieredFeature("chat.messageTypes");

	const recipient = await getProfileCard(recipientId);
	if (!recipient || recipient.deleted) throw errors.forbidden("Action not permitted");
	if (await isBlockedEitherWay(String(senderId), String(recipientId))) throw errors.forbidden("Action not permitted");

	const conversationId = conversationIdFor(senderId, recipientId);
	let replyToId: string | null = null;
	if (input.replyToMessageId) {
		const target = await visibleMessage(conversationId, input.replyToMessageId, senderId);
		if (!target) throw errors.badRequest("Invalid request");
		replyToId = target.id;
	}

	const charges: Charge[] = [{ key: "chat.messagesPerMinute", n: 1 }];
	const { stored, mediaHash } = await buildBody(senderId, recipientId, input.type, input.body, charges);
	const [existing] = await db.select({ id: conversations.id }).from(conversations).where(eq(conversations.id, conversationId)).limit(1);
	if (!existing) charges.push({ key: "chat.newConversationsPerDay", n: 1 });

	const charged: Charge[] = [];
	try {
		for (const c of charges) {
			await consume(senderId, c.key, c.n);
			charged.push(c);
		}
	} catch (e) {
		for (const c of charged) await release(senderId, c.key, c.n).catch(() => undefined);
		throw e;
	}

	let row: MessageRow;
	try {
		row = await persistMessage({ senderId, recipientId, type: input.type, body: stored, mediaHash, replyToId });
	} catch (e) {
		for (const c of charged) await release(senderId, c.key, c.n).catch(() => undefined);
		throw e;
	}

	await fanoutMessage(row).catch(() => undefined);
	await notifyNewMessage(row).catch(() => undefined);
	const replyTo = row.replyToId ? await loadMessage(row.replyToId) : null;
	return serializeMessage(row, senderId, { replyTo });
}

/** Inserts a message (creating the conversation on first contact) and updates both inbox rows. */
async function persistMessage(m: { senderId: bigint; recipientId: bigint; type: string; body: Record<string, unknown>; mediaHash: string | null; replyToId: string | null }): Promise<MessageRow> {
	const { senderId, recipientId } = m;
	const conversationId = conversationIdFor(senderId, recipientId);
	const { id, ts } = newMessageId();
	const createdAt = new Date(ts);
	const [low, high] = senderId < recipientId ? [senderId, recipientId] : [recipientId, senderId];
	return db.transaction(async (tx) => {
		await tx
			.insert(conversations)
			.values({ id: conversationId, userLow: low, userHigh: high, lastMessageAt: createdAt })
			.onConflictDoUpdate({ target: conversations.id, set: { lastMessageAt: createdAt } });
		const [inserted] = await tx
			.insert(messages)
			.values({ id, conversationId, senderId, recipientId, type: m.type, body: m.body, mediaHash: m.mediaHash, replyToId: m.replyToId, createdAt })
			.returning();
		await tx
			.insert(conversationMembers)
			.values({ conversationId, userId: senderId, otherId: recipientId, lastActivityAt: createdAt, previewMessageId: id })
			.onConflictDoUpdate({ target: [conversationMembers.conversationId, conversationMembers.userId], set: { lastActivityAt: createdAt, previewMessageId: id } });
		await tx
			.insert(conversationMembers)
			.values({ conversationId, userId: recipientId, otherId: senderId, lastActivityAt: createdAt, previewMessageId: id, unreadCount: 1 })
			.onConflictDoUpdate({
				target: [conversationMembers.conversationId, conversationMembers.userId],
				set: { lastActivityAt: createdAt, previewMessageId: id, unreadCount: sql`${conversationMembers.unreadCount} + 1` },
			});
		if (m.mediaHash) await tx.insert(chatMediaUsage).values({ ownerId: senderId, conversationId, mediaHash: m.mediaHash }).onConflictDoNothing();
		return inserted!;
	});
}

/**
 * Server-generated messages (album shares): no client validation or chat
 * quotas, but blocks still apply. Fans out like any message.
 */
export async function sendSystemMessage(senderId: bigint, recipientId: bigint, type: string, body: Record<string, unknown>): Promise<MessageRow | null> {
	if (await isBlockedEitherWay(String(senderId), String(recipientId))) return null;
	const row = await persistMessage({ senderId, recipientId, type, body, mediaHash: null, replyToId: null });
	await fanoutMessage(row).catch(() => undefined);
	await notifyNewMessage(row).catch(() => undefined);
	return row;
}

/** chat.v1.refresh_dynamic: album shared/unshared/expired/viewed. */
export async function refreshDynamic(userId: bigint, otherId: bigint, messageType = "Album"): Promise<void> {
	await publishToUser(userId, "chat.v1.refresh_dynamic", { conversationId: conversationIdFor(userId, otherId), messageType }).catch(() => undefined);
}

// --- Mutations ----------------------------------------------------------------

/** Upstream answers 500 for unknown/foreign messages on these endpoints. */
const messageNotFound = () => problem(500, "internal_error", "message not found");

export async function unsendMessage(me: bigint, conversationId: string, messageId: string): Promise<void> {
	otherParticipant(conversationId, me);
	if (!(await isFeatureEnabled(me, "chat.unsend"))) {
		throw problem(402, "tiered_feature", `profile ${me} feature UnsentMessage`, { profileId: Number(me), featureValue: "UnsentMessage" });
	}
	const row = await visibleMessage(conversationId, messageId, me);
	if (!row || row.senderId !== me) throw messageNotFound();
	if (row.unsent) return;
	const maxAge = await durationSeconds(me, "chat.unsend.maxAgeSec");
	if (Number.isFinite(maxAge) && Date.now() - row.createdAt.getTime() > maxAge * 1000) throw errors.entitlementLimit("chat.unsend.maxAgeSec");
	await consume(me, "chat.unsend.perDay");
	const [updated] = await db
		.update(messages)
		.set({ unsent: true, body: null, reactions: [] })
		.where(and(eq(messages.id, row.id), eq(messages.createdAt, row.createdAt)))
		.returning();
	if (updated) await fanoutMessage(updated).catch(() => undefined);
	await notifyUnsend(row).catch(() => undefined);
}

/** Recomputes a member's inbox preview after their preview message disappeared for them. */
async function refreshPreview(conversationId: string, userId: bigint): Promise<void> {
	const [member] = await db.select().from(conversationMembers).where(and(eq(conversationMembers.conversationId, conversationId), eq(conversationMembers.userId, userId))).limit(1);
	if (!member) return;
	const [latest] = await db
		.select({ id: messages.id })
		.from(messages)
		.where(
			and(
				eq(messages.conversationId, conversationId),
				sql`NOT (${userId}::bigint = ANY(${messages.hiddenFor}))`,
				member.clearedAt ? sql`${messages.createdAt} > ${member.clearedAt.toISOString()}::timestamptz` : sql`true`,
			),
		)
		.orderBy(sql`${messages.createdAt} DESC`)
		.limit(1);
	await db
		.update(conversationMembers)
		.set({ previewMessageId: latest?.id ?? null })
		.where(and(eq(conversationMembers.conversationId, conversationId), eq(conversationMembers.userId, userId)));
}

export async function deleteMessageForMe(me: bigint, conversationId: string, messageId: string): Promise<void> {
	otherParticipant(conversationId, me);
	await requireEnabled(me, "chat.delete");
	const row = await loadMessage(messageId);
	if (!row || row.conversationId !== conversationId) throw messageNotFound();
	if (row.hiddenFor.includes(me)) return;
	await db
		.update(messages)
		.set({ hiddenFor: sql`array_append(${messages.hiddenFor}, ${me}::bigint)` })
		.where(and(eq(messages.id, row.id), eq(messages.createdAt, row.createdAt)));
	await refreshPreview(conversationId, me);
	await publishToUser(me, "chat.v1.message_deleted", { conversationId, messageId }).catch(() => undefined);
}

export async function reactToMessage(me: bigint, conversationId: string, messageId: string, reactionType: number): Promise<void> {
	otherParticipant(conversationId, me);
	await requireEnabled(me, "chat.reactions");
	const row = await visibleMessage(conversationId, messageId, me);
	if (!row || row.unsent) throw messageNotFound();
	const reactions = (row.reactions as Reaction[]) ?? [];
	if (reactions.some((r) => r.profileId === Number(me) && r.reactionType === reactionType)) return;
	const [updated] = await db
		.update(messages)
		.set({ reactions: [...reactions.filter((r) => r.profileId !== Number(me)), { profileId: Number(me), reactionType }] })
		.where(and(eq(messages.id, row.id), eq(messages.createdAt, row.createdAt)))
		.returning();
	if (updated) await fanoutMessage(updated).catch(() => undefined);
	if (updated) await notifyReaction(updated, me).catch(() => undefined);
}

export async function sendTyping(me: bigint, conversationId: string, status: "Typing" | "Cleared"): Promise<void> {
	const { other } = otherParticipant(conversationId, me);
	const [conv] = await db.select({ id: conversations.id }).from(conversations).where(eq(conversations.id, conversationId)).limit(1);
	if (!conv) throw errors.forbidden("Action not permitted");
	if (!(await isFeatureEnabled(me, "chat.typingIndicator"))) return;
	if (await isBlockedEitherWay(String(me), String(other))) return;
	await publishToUser(other, "chat.v1.typing_status", { conversationId, profileId: String(me), status });
}

export async function markRead(me: bigint, conversationId: string, messageId: string): Promise<void> {
	const { other } = otherParticipant(conversationId, me);
	if (!parseMessageId(messageId)) throw errors.badRequest("Invalid request");
	const [member] = await db.select().from(conversationMembers).where(and(eq(conversationMembers.conversationId, conversationId), eq(conversationMembers.userId, me))).limit(1);
	if (!member) return;
	// Unread always resets; only a real message moves the "Read" position.
	const row = await visibleMessage(conversationId, messageId, me);
	const readTs = row ? row.createdAt.getTime() : null;
	const moved = readTs != null && (member.lastReadAt == null || readTs > member.lastReadAt);
	await db
		.update(conversationMembers)
		.set({ unreadCount: 0, ...(moved ? { lastReadAt: readTs } : {}) })
		.where(and(eq(conversationMembers.conversationId, conversationId), eq(conversationMembers.userId, me)));
	const ts = moved ? readTs : (member.lastReadAt ?? Date.now());
	const payload = { conversationId, profileId: String(me), timestamp: ts };
	await publishToUser(me, "chat.v1.conversation_read", payload).catch(() => undefined);
	// Read here: withdraw this chat's notifications on my other devices.
	if (member.unreadCount > 0) await notifyClear(me, [other]).catch(() => undefined);
	// The sender only sees read receipts with the entitlement (upstream: paid).
	if (moved && (await isFeatureEnabled(other, "chat.readReceipts")) && !(await isBlockedEitherWay(String(me), String(other)))) {
		await publishToUser(other, "chat.v1.conversation_read", payload).catch(() => undefined);
	}
}

/** Pin/mute work on conversations that don't exist yet too (upstream). */
async function ensureMember(me: bigint, conversationId: string): Promise<void> {
	const { conv, other } = otherParticipant(conversationId, me);
	const [exists] = await db.select({ id: users.id }).from(users).where(eq(users.id, other)).limit(1);
	if (!exists) throw errors.notFound();
	await db.insert(conversations).values({ id: conversationId, userLow: conv.low, userHigh: conv.high }).onConflictDoNothing();
	await db.insert(conversationMembers).values({ conversationId, userId: me, otherId: other }).onConflictDoNothing();
}

export async function setPinned(me: bigint, conversationId: string, pinned: boolean): Promise<void> {
	await ensureMember(me, conversationId);
	if (pinned) {
		const [row] = await db.select({ pinned: conversationMembers.pinned }).from(conversationMembers).where(and(eq(conversationMembers.conversationId, conversationId), eq(conversationMembers.userId, me)));
		if (!row?.pinned) {
			const [count] = await db.select({ n: sql<number>`count(*)::int` }).from(conversationMembers).where(and(eq(conversationMembers.userId, me), eq(conversationMembers.pinned, true)));
			await checkCap(me, "chat.pinned.max", count?.n ?? 0);
		}
	}
	await db.update(conversationMembers).set({ pinned }).where(and(eq(conversationMembers.conversationId, conversationId), eq(conversationMembers.userId, me)));
}

export async function setMuted(me: bigint, conversationId: string, muted: boolean): Promise<void> {
	await ensureMember(me, conversationId);
	await db.update(conversationMembers).set({ muted }).where(and(eq(conversationMembers.conversationId, conversationId), eq(conversationMembers.userId, me)));
}

/** Deletes on my side only: older messages stay hidden for me, the inbox entry goes away. */
export async function deleteConversationForMe(me: bigint, conversationId: string): Promise<void> {
	otherParticipant(conversationId, me);
	await db
		.update(conversationMembers)
		.set({ clearedAt: new Date(), lastActivityAt: null, previewMessageId: null, unreadCount: 0 })
		.where(and(eq(conversationMembers.conversationId, conversationId), eq(conversationMembers.userId, me)));
}

/**
 * Single message for the viewer. A recipient opening an expiring image/video
 * uses one view here (atomically) and gets a URL valid for the view duration.
 */
export async function getSingleMessage(me: bigint, conversationId: string, messageId: string): Promise<Record<string, unknown>> {
	otherParticipant(conversationId, me);
	let row = await visibleMessage(conversationId, messageId, me);
	if (!row) throw errors.notFound();
	const granted = new Set<string>();
	const b = (row.body ?? {}) as { maxViews?: number | null };
	const isVideo = row.type === "Video" || row.type === "PrivateVideo" || row.type === "NonExpiringVideo";
	if (row.recipientId === me && !row.unsent && (row.type === "ExpiringImage" || isVideo)) {
		const maxViews = row.type === "ExpiringImage" ? Number(b.maxViews ?? 1) : b.maxViews == null ? null : Number(b.maxViews);
		if (maxViews == null) {
			granted.add(row.id);
		} else {
			const [used] = await db
				.update(messages)
				.set({ viewsUsed: sql`${messages.viewsUsed} + 1` })
				.where(and(eq(messages.id, row.id), eq(messages.createdAt, row.createdAt), sql`${messages.viewsUsed} < ${maxViews}`))
				.returning();
			if (used) {
				row = used;
				granted.add(row.id);
			}
		}
	}
	const [message] = await serializeWithReplies([row], me, { grantedViewFor: granted });
	return message!;
}

export async function messagesById(me: bigint, conversationId: string, ids: string[]): Promise<Record<string, unknown>[]> {
	otherParticipant(conversationId, me);
	const rows = [...(await loadMessages(ids)).values()]
		.filter((r) => r.conversationId === conversationId && !r.hiddenFor.includes(me))
		.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
	return serializeWithReplies(rows, me);
}

export async function conversationIdsWith(me: bigint, others: bigint[]): Promise<string[]> {
	if (!others.length) return [];
	const rows = await db
		.select({ id: conversationMembers.conversationId })
		.from(conversationMembers)
		.where(and(eq(conversationMembers.userId, me), inArray(conversationMembers.otherId, others)));
	return rows.map((r) => r.id);
}

/**
 * Blocking deletes the conversation for both sides (upstream: "Blocking a
 * user automatically deletes the conversation for both of you") — messages,
 * inbox rows and drawer usage are removed server-side.
 */
export async function deleteConversationForBoth(a: bigint, b: bigint): Promise<void> {
	const conversationId = conversationIdFor(a, b);
	await db.transaction(async (tx) => {
		await tx.delete(messages).where(eq(messages.conversationId, conversationId));
		await tx.delete(chatMediaUsage).where(eq(chatMediaUsage.conversationId, conversationId));
		// Members go with it (ON DELETE CASCADE).
		await tx.delete(conversations).where(eq(conversations.id, conversationId));
	});
}

/**
 * Block/unblock hook (blocks API, milestone 6): upstream sends
 * chat.v1.conversation.delete to both sides for either change.
 */
export async function notifyBlockChanged(a: bigint, b: bigint): Promise<void> {
	const conversationIds = [conversationIdFor(a, b)];
	await Promise.all([publishToUser(a, "chat.v1.conversation.delete", { conversationIds }), publishToUser(b, "chat.v1.conversation.delete", { conversationIds })]);
	await Promise.all([notifyClear(a, [b]), notifyClear(b, [a])]).catch(() => undefined);
}
