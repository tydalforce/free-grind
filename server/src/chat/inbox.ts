import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/client";
import { conversationMembers, messages } from "../db/schema";
import { isFeatureEnabled } from "../entitlements/enforce";
import { displayedDistance } from "../geo/obfuscate";
import { errors } from "../lib/errors";
import { getServerSetting } from "../modules/settings/settings";
import { getProfileCards } from "../profiles/cards";
import { getRelations, isBlockedEitherWay } from "../profiles/relations";
import { otherParticipant, parseMessageId } from "./ids";
import { buildPreview } from "./serialize";
import { loadMessages, serializeWithReplies } from "./service";

const INBOX_PAGE_SIZE = 50;

export const inboxFiltersSchema = z
	.object({
		unreadOnly: z.boolean().optional(),
		chemistryOnly: z.boolean().optional(),
		favoritesOnly: z.boolean().optional(),
		rightNowOnly: z.boolean().optional(),
		onlineNowOnly: z.boolean().optional(),
		distanceMeters: z.number().nonnegative().nullable().optional(),
		positions: z.array(z.number().int()).max(20).optional(),
		includeReactionUnreads: z.boolean().optional(),
	})
	.partial()
	.nullable()
	.optional();

type InboxRow = {
	conversation_id: string;
	other_id: string;
	pinned: boolean;
	muted: boolean;
	unread_count: number;
	last_activity_at: Date | string;
	preview_message_id: string | null;
	last_seen: string | null;
	online_until: string | null;
	sexual_position: number | null;
	distance: number | null;
	favorite: boolean;
	right_now: "HOSTING" | "NOT_HOSTING" | null;
};

async function distanceFormat() {
	return { roundMeters: (await getServerSetting<number>("distance.roundMeters")) ?? 100 };
}

/** Active, non-discreet Right Now posts (subquery). */
const ACTIVE_RIGHT_NOW = sql.raw(`(SELECT author_id, hosting FROM rightnow_posts WHERE status = 'ACTIVE' AND (expiration IS NULL OR expiration > now()) AND is_discreet <> 'TRUE')`);

/** POST /v4/inbox (+ /v3 alias). Upstream page model: 1-based `page`, `nextPage`. */
export async function listInbox(me: bigint, page: number, rawFilters: unknown) {
	const filters = inboxFiltersSchema.parse(rawFilters) ?? {};
	// Paid filters upstream; ours follow chat.inboxFilters (unread/favorites stay free).
	const advanced = await isFeatureEnabled(me, "chat.inboxFilters");
	const rel = await getRelations(String(me));
	const blocked = [...rel.blocked];

	const conds = [sql`m.user_id = ${me}`, sql`m.last_activity_at IS NOT NULL`, sql`u.deleted_at IS NULL`];
	if (blocked.length) conds.push(sql`m.other_id <> ALL(${`{${blocked.join(",")}}`}::bigint[])`);
	if (filters.unreadOnly) conds.push(sql`m.unread_count > 0`);
	if (filters.favoritesOnly) conds.push(sql`f.target_id IS NOT NULL`);
	// Chemistry (Grindr's matching) doesn't exist on our server: nothing matches.
	if (filters.chemistryOnly) conds.push(sql`false`);
	if (advanced) {
		// An active Right Now post; discreet ones never point back to the profile.
		if (filters.rightNowOnly) conds.push(sql`EXISTS (SELECT 1 FROM ${ACTIVE_RIGHT_NOW} r WHERE r.author_id = m.other_id)`);
		if (filters.onlineNowOnly) conds.push(sql`p.online_until > now() AND p.incognito = false`);
		if (filters.distanceMeters != null) conds.push(sql`ST_DWithin(p.public_location, me.public_location, ${filters.distanceMeters})`);
		if (filters.positions?.length) conds.push(sql`p.sexual_position = ANY(${`{${filters.positions.join(",")}}`}::smallint[])`);
	}
	const where = sql.join(conds, sql` AND `);
	const from = sql`
		FROM conversation_members m
		JOIN users u ON u.id = m.other_id
		LEFT JOIN profiles p ON p.user_id = m.other_id
		LEFT JOIN profiles me ON me.user_id = ${me}
		LEFT JOIN favorites f ON f.owner_id = ${me} AND f.target_id = m.other_id`;

	const safePage = Math.max(1, Math.min(page, 10_000));
	const [rows, [count]] = await Promise.all([
		db.execute(sql`
			SELECT m.conversation_id, m.other_id::text AS other_id, m.pinned, m.muted, m.unread_count, m.last_activity_at, m.preview_message_id,
			       CASE WHEN p.incognito THEN NULL ELSE (extract(epoch FROM p.last_seen_at) * 1000)::bigint END AS last_seen,
			       CASE WHEN p.incognito THEN NULL ELSE (extract(epoch FROM p.online_until) * 1000)::bigint END AS online_until,
			       (SELECT CASE WHEN count(*) = 0 THEN NULL WHEN bool_or(r.hosting) THEN 'HOSTING' ELSE 'NOT_HOSTING' END FROM ${ACTIVE_RIGHT_NOW} r WHERE r.author_id = m.other_id) AS right_now,
			       p.sexual_position,
			       ST_Distance(p.public_location, me.public_location) AS distance,
			       (f.target_id IS NOT NULL) AS favorite
			${from}
			WHERE ${where}
			ORDER BY m.pinned DESC, m.last_activity_at DESC
			LIMIT ${INBOX_PAGE_SIZE + 1} OFFSET ${(safePage - 1) * INBOX_PAGE_SIZE}`) as unknown as Promise<InboxRow[]>,
		db.execute(sql`SELECT count(*)::int AS n ${from} WHERE ${where}`) as unknown as Promise<{ n: number }[]>,
	]);

	const pageRows = rows.slice(0, INBOX_PAGE_SIZE);
	const [cards, previews, fmt] = await Promise.all([
		getProfileCards(pageRows.map((r) => r.other_id)),
		loadMessages(pageRows.map((r) => r.preview_message_id).filter((x): x is string => !!x)),
		distanceFormat(),
	]);

	const entries = pageRows.map((r) => {
		const card = cards.get(r.other_id);
		const preview = r.preview_message_id ? previews.get(r.preview_message_id) : null;
		const distance = card?.showDistance && r.distance != null ? displayedDistance(Number(r.distance), { roundMeters: fmt.roundMeters, approximate: card.approximateDistance }) : null;
		return {
			type: "full_conversation_v1",
			data: {
				conversationId: r.conversation_id,
				name: card?.displayName ?? "",
				participants: [
					{
						profileId: Number(r.other_id),
						primaryMediaHash: card?.primaryMediaHash ?? null,
						lastOnline: r.last_seen == null ? null : Number(r.last_seen),
						onlineUntil: r.online_until == null ? null : Number(r.online_until),
						distanceMetres: distance,
						position: card?.showPosition ? (r.sexual_position ?? null) : null,
						isInAList: false,
						hasDatingPotential: false,
						isOnPrep: false,
						age: card?.showAge ? card.age : null,
						aboutMe: card?.aboutMe ?? null,
					},
				],
				lastActivityTimestamp: new Date(r.last_activity_at).getTime(),
				unreadCount: r.unread_count,
				preview: buildPreview(preview && !preview.hiddenFor.includes(me) ? preview : null),
				muted: r.muted,
				pinned: r.pinned,
				favorite: r.favorite,
				context: null,
				onlineUntil: null,
				translatable: false,
				rightNow: r.right_now ?? "NOT_ACTIVE",
				rightNowStatus: "NONE",
				hasUnreadThrob: false,
				isTopConnection: false,
				smartLabel: null,
			},
		};
	});

	return {
		entries,
		showsFreeHeaderLabel: false,
		totalFullConversations: count?.n ?? entries.length,
		totalPartialConversations: 0,
		maxDisplayLockCount: 99,
		nextPage: rows.length > INBOX_PAGE_SIZE ? safePage + 1 : null,
	};
}

/** GET /v5/chat/conversation/{cid}/message — newest page before `pageKey`, oldest first. */
export async function listMessagesPage(me: bigint, conversationId: string, opts: { pageKey?: string; limit?: number; includeProfile: boolean }) {
	const { other } = otherParticipant(conversationId, me);
	const cards = await getProfileCards([other]);
	const card = cards.get(String(other));
	// Upstream: blocked either way or the other account is gone → 403.
	if (!card || card.deleted || (await isBlockedEitherWay(String(me), String(other)))) throw errors.forbidden("Action not permitted");

	const limit = Math.max(1, Math.min(opts.limit ?? 50, 100));
	const [mine, theirs] = await Promise.all([
		db.select().from(conversationMembers).where(and(eq(conversationMembers.conversationId, conversationId), eq(conversationMembers.userId, me))).limit(1),
		db.select().from(conversationMembers).where(and(eq(conversationMembers.conversationId, conversationId), eq(conversationMembers.userId, other))).limit(1),
	]);
	const clearedAt = mine[0]?.clearedAt ?? null;

	const conds = [eq(messages.conversationId, conversationId), sql`NOT (${me}::bigint = ANY(${messages.hiddenFor}))`];
	if (clearedAt) conds.push(sql`${messages.createdAt} > ${clearedAt.toISOString()}::timestamptz`);
	if (opts.pageKey) {
		const pk = parseMessageId(opts.pageKey);
		if (!pk) throw errors.badRequest("Invalid request");
		conds.push(sql`(${messages.createdAt}, ${messages.id}) < (${new Date(pk.ts).toISOString()}::timestamptz, ${opts.pageKey})`);
	}
	const rows = await db
		.select()
		.from(messages)
		.where(and(...conds))
		.orderBy(sql`${messages.createdAt} DESC, ${messages.id} DESC`)
		.limit(limit);
	rows.reverse();

	let profile: Record<string, unknown> | null = null;
	if (opts.includeProfile) {
		const [geo] = (await db.execute(sql`
			SELECT (extract(epoch FROM p.online_until) * 1000)::bigint AS online_until, ST_Distance(p.public_location, me.public_location) AS distance
			FROM profiles p LEFT JOIN profiles me ON me.user_id = ${me}
			WHERE p.user_id = ${other}`)) as unknown as { online_until: string | null; distance: number | null }[];
		const fmt = await distanceFormat();
		profile = {
			profileId: Number(other),
			name: card.displayName ?? "",
			mediaHash: card.primaryMediaHash,
			onlineUntil: geo?.online_until == null ? null : Number(geo.online_until),
			distance: card.showDistance && geo?.distance != null ? displayedDistance(Number(geo.distance), { roundMeters: fmt.roundMeters, approximate: card.approximateDistance }) : null,
			showDistance: card.showDistance,
		};
	}

	return {
		lastReadTimestamp: theirs[0]?.lastReadAt ?? null,
		messages: await serializeWithReplies(rows, me),
		metadata: { translate: false, hasSharedAlbums: false, isInAList: false, summary: null },
		profile,
	};
}

/** GET /v5/chat/media/shared/images/with-me/{cid}: non-expiring images the other side sent me. */
export async function sharedImagesWithMe(me: bigint, conversationId: string) {
	const { other } = otherParticipant(conversationId, me);
	const rows = await db
		.select()
		.from(messages)
		.where(and(eq(messages.conversationId, conversationId), eq(messages.senderId, other), eq(messages.type, "Image"), eq(messages.unsent, false), sql`NOT (${me}::bigint = ANY(${messages.hiddenFor}))`))
		.orderBy(sql`${messages.createdAt} DESC`)
		.limit(200);
	const serialized = await serializeWithReplies(rows, me);
	return {
		images: serialized.map((m, i) => {
			const body = (m.body ?? {}) as { mediaId?: number; url?: string; takenOnGrindr?: boolean | null };
			return { mediaId: body.mediaId, url: body.url ?? null, expiresAt: expiresFromUrl(body.url), takenOnGrindr: body.takenOnGrindr ?? false, createdTs: rows[i]!.createdAt.getTime() };
		}),
	};
}

function expiresFromUrl(url: string | undefined): number | null {
	const m = url ? /[?&]Expires=(\d+)/.exec(url) : null;
	return m ? Number(m[1]) * 1000 : null;
}

