import { and, desc, eq, gt, inArray, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { deleteConversationForBoth, notifyBlockChanged } from "../chat/service";
import { db } from "../db/client";
import { blocks, favorites, profileViews, profiles, reports, taps, users } from "../db/schema";
import { capValue, checkCap, consume } from "../entitlements/enforce";
import { touchOnline } from "../geo/location";
import { errors } from "../lib/errors";
import { getProfileCards } from "../profiles/cards";
import { presenceOf } from "../profiles/presence";
import { getRelations, invalidateRelations, isBlockedEitherWay } from "../profiles/relations";
import { publishToUser } from "../realtime/bus";
import { notifyTap, notifyViewed } from "../push/notify";

/** Blocks, taps, views and reports (plan phase 5). */

const idParam = (v: unknown) => {
	if (typeof v !== "string" || !/^\d{1,19}$/.test(v)) throw errors.badRequest("Invalid request");
	return BigInt(v);
};

async function userExists(id: bigint): Promise<boolean> {
	const [row] = await db.select({ id: users.id }).from(users).where(and(eq(users.id, id), sql`${users.deletedAt} IS NULL`)).limit(1);
	return !!row;
}

async function hideViewedMe(id: bigint): Promise<boolean> {
	const [row] = await db.select({ h: profiles.hideViewedMe, i: profiles.incognito }).from(profiles).where(eq(profiles.userId, id)).limit(1);
	return !!row?.h;
}

/** A view repeated within this window updates the row but sends no new event. */
const VIEW_EVENT_COOLDOWN_MS = 10 * 60_000;
/** Upstream answers a repeated tap with 400; we treat one per day as "repeated". */
const TAP_REPEAT_WINDOW_MS = 24 * 3_600_000;

export async function interactionRoutes(app: FastifyInstance): Promise<void> {
	const auth = { preHandler: app.authenticate };

	// --- Blocks ------------------------------------------------------------------

	app.get("/v3.1/me/blocks", auth, async (req) => {
		const me = req.auth.userId;
		const [mine, byOthers] = await Promise.all([
			db.select({ t: blocks.targetId }).from(blocks).where(eq(blocks.ownerId, me)).orderBy(desc(blocks.createdAt)),
			db.select({ o: blocks.ownerId }).from(blocks).where(eq(blocks.targetId, me)),
		]);
		return { blocking: mine.map((r) => ({ profileId: Number(r.t), blockedTime: 0 })), blockedBy: byOthers.map((r) => String(r.o)) };
	});

	app.post("/v3/me/blocks/:profileId", auth, async (req) => {
		const me = req.auth.userId;
		const target = idParam((req.params as { profileId: string }).profileId);
		if (target === me) throw errors.badRequest("Invalid request");
		if (!(await userExists(target))) throw errors.notFound();
		const [already] = await db.select({ t: blocks.targetId }).from(blocks).where(and(eq(blocks.ownerId, me), eq(blocks.targetId, target))).limit(1);
		if (!already) {
			const [n] = await db.select({ n: sql<number>`count(*)::int` }).from(blocks).where(eq(blocks.ownerId, me));
			await checkCap(me, "blocks.max", n?.n ?? 0);
			await db.insert(blocks).values({ ownerId: me, targetId: target }).onConflictDoNothing();
			// Blocking also ends a favorite (and its note) on my side.
			await db.delete(favorites).where(and(eq(favorites.ownerId, me), eq(favorites.targetId, target)));
			await deleteConversationForBoth(me, target);
			await invalidateRelations(me, target);
			await notifyBlockChanged(me, target).catch(() => undefined);
		}
		return { updateTime: 0 };
	});

	app.delete("/v3/me/blocks/:profileId", auth, async (req) => {
		const me = req.auth.userId;
		const target = idParam((req.params as { profileId: string }).profileId);
		const removed = await db.delete(blocks).where(and(eq(blocks.ownerId, me), eq(blocks.targetId, target))).returning({ t: blocks.targetId });
		if (removed.length) {
			await invalidateRelations(me, target);
			await notifyBlockChanged(me, target).catch(() => undefined);
		}
		return {};
	});

	app.delete("/v3/me/blocks", auth, async (req) => {
		const me = req.auth.userId;
		const removed = await db.delete(blocks).where(eq(blocks.ownerId, me)).returning({ t: blocks.targetId });
		await invalidateRelations(me, ...removed.map((r) => r.t));
		for (const r of removed) await notifyBlockChanged(me, r.t).catch(() => undefined);
		return {};
	});

	// --- Taps --------------------------------------------------------------------

	app.post("/v2/taps/add", auth, async (req) => {
		const me = req.auth.userId;
		const b = z.object({ recipientId: z.union([z.number().int(), z.string().regex(/^\d{1,19}$/)]), tapType: z.coerce.number().int() }).safeParse(req.body);
		if (!b.success) throw errors.badRequest("Invalid request");
		const recipient = BigInt(b.data.recipientId);
		if (recipient === me || !(await userExists(recipient))) throw errors.badRequest("Invalid request");
		if (await isBlockedEitherWay(String(me), String(recipient))) throw errors.badRequest("Invalid request");
		const [recent] = await db
			.select({ t: taps.createdAt })
			.from(taps)
			.where(and(eq(taps.senderId, me), eq(taps.recipientId, recipient), gt(taps.createdAt, new Date(Date.now() - TAP_REPEAT_WINDOW_MS))))
			.limit(1);
		if (recent) throw errors.badRequest("Invalid request");
		await consume(me, "taps.perDay");
		const now = new Date();
		await db
			.insert(taps)
			.values({ senderId: me, recipientId: recipient, tapType: b.data.tapType, createdAt: now })
			.onConflictDoUpdate({ target: [taps.senderId, taps.recipientId], set: { tapType: b.data.tapType, createdAt: now } });
		const [back] = await db.select({ t: taps.tapType }).from(taps).where(and(eq(taps.senderId, recipient), eq(taps.recipientId, me))).limit(1);
		const isMutual = !!back;

		const card = (await getProfileCards([me])).get(String(me));
		const payload = {
			timestamp: now.getTime(),
			senderId: Number(me),
			recipientId: Number(recipient),
			tapType: b.data.tapType,
			senderProfileImageHash: card?.primaryMediaHash ?? null,
			senderDisplayName: card?.displayName ?? null,
			isMutual,
		};
		for (const uid of [recipient, me]) {
			await publishToUser(uid, "tap.v1.tap_sent", payload).catch(() => undefined);
			await publishToUser(uid, "tap.v2.tap_sent", payload).catch(() => undefined);
		}
		await notifyTap(me, recipient).catch(() => undefined);
		return { isMutual };
	});

	const receivedTaps = async (me: bigint) => {
		await touchOnline(me);
		const rel = await getRelations(String(me));
		const rows = await db.select().from(taps).where(eq(taps.recipientId, me)).orderBy(desc(taps.createdAt)).limit(500);
		const visible = rows.filter((r) => !rel.blocked.has(String(r.senderId)));
		const ids = visible.map((r) => r.senderId);
		const [cards, presence, mineBack] = await Promise.all([
			getProfileCards(ids),
			presenceOf(me, ids),
			ids.length ? db.select({ r: taps.recipientId }).from(taps).where(and(eq(taps.senderId, me), inArray(taps.recipientId, ids))) : Promise.resolve([]),
		]);
		const tappedBack = new Set(mineBack.map((r) => String(r.r)));
		return visible
			.filter((r) => !cards.get(String(r.senderId))?.deleted)
			.map((r) => {
				const id = String(r.senderId);
				const card = cards.get(id);
				const p = presence.get(id);
				return {
					profileId: Number(id),
					displayName: card?.displayName ?? null,
					profileImageMediaHash: card?.primaryMediaHash ?? null,
					distance: p?.distance ?? null,
					isFavorite: rel.favorites.has(id),
					onlineUntil: p?.onlineUntil ?? null,
					timestamp: r.createdAt.getTime(),
					tapType: r.tapType,
					lastOnline: p?.lastSeen ?? null,
					isBoosting: false,
					isMutual: tappedBack.has(id),
					rightNowType: p?.rightNow ?? "NOT_ACTIVE",
					isViewable: true,
					rightNowStatus: p && p.rightNow !== "NOT_ACTIVE" ? "ACTIVE" : "NONE",
					hasChatted: false,
					unreadMessageCount: 0,
					isOnPrep: false,
					receivedDuringBoost: false,
					tapped: tappedBack.has(id),
				};
			});
	};

	app.get("/v2/taps/received", auth, async (req) => ({ profiles: (await receivedTaps(req.auth.userId)).map(({ tapped: _t, ...p }) => p) }));
	app.get("/v3/taps/received", auth, async (req) => {
		const withTapped = (req.query as { withTappedSent?: string }).withTappedSent === "true";
		return { items: (await receivedTaps(req.auth.userId)).map(({ tapped, ...p }) => ({ type: "tap_profile_v1", data: withTapped ? { ...p, tapped } : p })) };
	});

	app.get("/v1/interactions/taps/sent", auth, async (req) => {
		const rows = await db.select().from(taps).where(eq(taps.senderId, req.auth.userId)).orderBy(desc(taps.createdAt)).limit(500);
		return rows.map((r) => ({ senderId: Number(r.senderId), receiverId: Number(r.recipientId), tapType: r.tapType, sentOn: r.createdAt.getTime(), deleted: false, readOn: null }));
	});

	// --- Views -------------------------------------------------------------------

	const recordView = async (viewer: bigint, viewed: bigint) => {
		if (viewer === viewed) return;
		const [viewerProfile] = await db.select({ h: profiles.hideViewedMe, i: profiles.incognito }).from(profiles).where(eq(profiles.userId, viewer)).limit(1);
		// Hidden viewers and incognito profiles leave no trace (upstream).
		if (viewerProfile?.h || viewerProfile?.i) return;
		if (await hideViewedMe(viewed)) return;
		if (await isBlockedEitherWay(String(viewer), String(viewed))) return;
		const now = new Date();
		const [prev] = await db.select({ at: profileViews.lastViewedAt }).from(profileViews).where(and(eq(profileViews.viewerId, viewer), eq(profileViews.viewedId, viewed))).limit(1);
		await db
			.insert(profileViews)
			.values({ viewerId: viewer, viewedId: viewed, lastViewedAt: now })
			.onConflictDoUpdate({ target: [profileViews.viewerId, profileViews.viewedId], set: { lastViewedAt: now, count: sql`${profileViews.count} + 1` } });
		if (prev && now.getTime() - prev.at.getTime() < VIEW_EVENT_COOLDOWN_MS) return;
		const [n] = await db.select({ n: sql<number>`count(*)::int` }).from(profileViews).where(eq(profileViews.viewedId, viewed));
		const card = (await getProfileCards([viewer])).get(String(viewer));
		await publishToUser(viewed, "viewed_me.v1.new_view_received", {
			viewedCount: n?.n ?? 1,
			mostRecent: { profileId: String(viewer), photoHash: card?.primaryMediaHash ?? null, timestamp: now.getTime() },
		}).catch(() => undefined);
		await notifyViewed(viewed).catch(() => undefined);
	};

	for (const path of ["/v4/views/:profileId", "/v5/views/:profileId"]) {
		app.post(path, auth, async (req) => {
			const viewed = idParam((req.params as { profileId: string }).profileId);
			await recordView(req.auth.userId, viewed);
			return {};
		});
	}

	app.get("/v6/views/eyeball", auth, async (req) => {
		const me = req.auth.userId;
		if (await hideViewedMe(me)) return { viewedCount: 0, mostRecent: null };
		const rel = await getRelations(String(me));
		const rows = await db.select().from(profileViews).where(eq(profileViews.viewedId, me)).orderBy(desc(profileViews.lastViewedAt)).limit(1000);
		const visible = rows.filter((r) => !rel.blocked.has(String(r.viewerId)));
		const first = visible[0];
		const card = first ? (await getProfileCards([first.viewerId])).get(String(first.viewerId)) : null;
		return {
			viewedCount: visible.length,
			mostRecent: first ? { profileId: String(first.viewerId), photoHash: card?.primaryMediaHash ?? null, timestamp: first.lastViewedAt.getTime() } : null,
		};
	});

	app.get("/v7/views/list", auth, async (req) => {
		const me = req.auth.userId;
		const empty = { totalViewers: 0, previews: [], profiles: [], ttl: 0, lastDistanceInKm: null, lastProfileId: null, upsells: null };
		if (await hideViewedMe(me)) return empty;
		const rel = await getRelations(String(me));
		const rows = (await db.select().from(profileViews).where(eq(profileViews.viewedId, me)).orderBy(desc(profileViews.lastViewedAt)).limit(500)).filter((r) => !rel.blocked.has(String(r.viewerId)));
		const ids = rows.map((r) => r.viewerId);
		const [cards, presence] = await Promise.all([getProfileCards(ids), presenceOf(me, ids)]);
		const live = rows.filter((r) => !cards.get(String(r.viewerId))?.deleted);
		const visibleCount = await capValue(me, "viewedMe.visibleCount");
		const entry = (r: (typeof live)[number]) => {
			const id = String(r.viewerId);
			const card = cards.get(id);
			const p = presence.get(id);
			return {
				distance: p?.distance ?? null,
				profileImageMediaHash: card?.primaryMediaHash ?? null,
				isFavorite: rel.favorites.has(id),
				lastViewed: r.lastViewedAt.getTime(),
				seen: r.lastViewedAt.getTime(),
				rightNow: p?.rightNow ?? "NOT_ACTIVE",
				sexualPosition: p?.sexualPosition ?? null,
				foundVia: null,
				isInBadNeighborhood: false,
				isViewedMeFreshFace: false,
				isSecretAdmirer: false,
				viewedCount: { totalCount: r.count, maxDisplayCount: 99 },
				rightNowStatus: p && p.rightNow !== "NOT_ACTIVE" ? "ACTIVE" : "NONE",
				isOnPrep: false,
				_card: card,
				_p: p,
				_id: id,
			};
		};
		const full = live.slice(0, Number.isFinite(visibleCount) ? visibleCount : live.length).map(entry);
		const masked = live.slice(full.length).map(entry);
		const strip = <T extends { _card: unknown; _p: unknown; _id: unknown }>({ _card, _p, _id, ...rest }: T) => rest;
		return {
			totalViewers: live.length,
			previews: masked.map(strip),
			profiles: full.map((e) => ({
				...strip(e),
				profileId: e._id,
				displayName: e._card?.displayName ?? null,
				onlineUntil: e._p?.onlineUntil ?? null,
				age: e._card?.showAge ? e._card.age : null,
				showAge: e._card?.showAge ?? true,
				showDistance: e._card?.showDistance ?? true,
				approximateDistance: e._card?.approximateDistance ?? false,
				lastChatTimestamp: 0,
				isNew: false,
				lastUpdatedTime: e._card?.lastUpdatedTime ?? 0,
				medias: (e._card?.medias ?? []).map((m) => ({ mediaHash: m.mediaHash, type: m.kind === "video" ? 2 : 1, state: 1, reason: null, takenOnGrindr: m.takenOnGrindr, createdAt: m.createdAt })),
				hasFaceRecognition: false,
				isIncognito: false,
				boosting: false,
				showUnlockReward: false,
				unreadMessageCount: 0,
				hasChatted: false,
			})),
			ttl: 0,
			lastDistanceInKm: null,
			lastProfileId: null,
			upsells: null,
		};
	});

	// --- Reports -----------------------------------------------------------------

	const reportBody = z.object({
		reason: z.union([z.string(), z.number()]).optional(),
		comment: z.string().max(5000).optional().nullable(),
		locations: z.array(z.unknown()).max(20).optional().nullable(),
		albumInfo: z.unknown().optional(),
		rightNowInfo: z.unknown().optional(),
		storyInfo: z.unknown().optional(),
		captchaToken: z.unknown().optional(),
	});
	for (const path of ["/v3.1/flags/:profileId", "/v4/flags/:profileId", "/v5/flags/:profileId"]) {
		app.post(path, auth, async (req) => {
			const target = idParam((req.params as { profileId: string }).profileId);
			const b = reportBody.safeParse(req.body ?? {});
			if (!b.success || target === req.auth.userId) throw errors.badRequest("Invalid request");
			if (!(await userExists(target))) throw errors.notFound();
			const context = { albumInfo: b.data.albumInfo ?? null, rightNowInfo: b.data.rightNowInfo ?? null, storyInfo: b.data.storyInfo ?? null };
			await db
				.insert(reports)
				.values({ reporterId: req.auth.userId, profileId: target, reason: b.data.reason != null ? String(b.data.reason) : null, comment: b.data.comment ?? null, locations: b.data.locations ?? null, context })
				.onConflictDoUpdate({ target: [reports.reporterId, reports.profileId], set: { reason: b.data.reason != null ? String(b.data.reason) : null, comment: b.data.comment ?? null, locations: b.data.locations ?? null, context, status: "PENDING", createdAt: new Date() } });
			return {};
		});
		app.get(path, auth, async (req, reply) => {
			const target = idParam((req.params as { profileId: string }).profileId);
			const [row] = await db.select().from(reports).where(and(eq(reports.reporterId, req.auth.userId), eq(reports.profileId, target))).limit(1);
			if (!row) return reply.code(404).send(errors.notFound().body);
			return { status: row.status, createTime: row.createdAt.getTime() };
		});
	}

}
