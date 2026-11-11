import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { capValue } from "../entitlements/enforce";
import { db } from "../db/client";
import { albumContent, albumShares, albums, media } from "../db/schema";
import { errors } from "../lib/errors";
import { type MediaVariant, signMediaUrl } from "../lib/mediaUrls";
import { getServerSetting } from "../modules/settings/settings";

/**
 * Album access rules shared by the album routes and chat serialization.
 * A share is active while it exists and hasn't expired. Timed shares (10
 * minutes, 1 hour, 1 day) count from the moment they're shared; ONCE starts
 * its 30-minute viewing window at the recipient's first access.
 */

export type AlbumRow = typeof albums.$inferSelect;
export type ShareRow = typeof albumShares.$inferSelect;
export type ExpirationType = ShareRow["expirationType"];

export const EXPIRATION_BY_NUMBER: Record<number, ExpirationType> = { 0: "INDEFINITE", 1: "ONCE", 2: "TEN_MINUTES", 3: "ONE_HOUR", 4: "ONE_DAY" };
const EXPIRATION_MS: Record<ExpirationType, number | null> = { INDEFINITE: null, ONCE: 30 * 60_000, TEN_MINUTES: 10 * 60_000, ONE_HOUR: 3_600_000, ONE_DAY: 86_400_000 };

export function normalizeExpiration(v: unknown): ExpirationType | null {
	if (typeof v === "number") return EXPIRATION_BY_NUMBER[v] ?? null;
	if (typeof v === "string" && v in EXPIRATION_MS) return v as ExpirationType;
	return null;
}

export function isShareActive(share: ShareRow | null | undefined, now = Date.now()): share is ShareRow {
	return !!share && (share.expiresAt == null || share.expiresAt.getTime() > now);
}

export async function loadAlbum(albumId: number): Promise<AlbumRow | null> {
	if (!Number.isSafeInteger(albumId) || albumId <= 0) return null;
	const [row] = await db.select().from(albums).where(eq(albums.id, albumId)).limit(1);
	return row ?? null;
}

/** Owner's album or 403 (upstream answers 403 for foreign and missing albums alike). */
export async function ownAlbum(me: bigint, albumId: number): Promise<AlbumRow> {
	const album = await loadAlbum(albumId);
	if (!album || album.ownerId !== me) throw errors.forbidden("Action not permitted");
	return album;
}

export async function shareFor(albumId: number, profileId: bigint): Promise<ShareRow | null> {
	const [row] = await db.select().from(albumShares).where(and(eq(albumShares.albumId, albumId), eq(albumShares.profileId, profileId))).limit(1);
	return row ?? null;
}

/**
 * When a share made at `now` expires: timed shares count from sharing, ONCE
 * only from the first view (see startShareClock), INDEFINITE never.
 */
export function expiresAtOnShare(expirationType: ExpirationType, now = new Date()): Date | null {
	if (expirationType === "ONCE") return null;
	const ms = EXPIRATION_MS[expirationType];
	return ms == null ? null : new Date(now.getTime() + ms);
}

/**
 * Records the recipient's first access. For ONCE that starts its viewing
 * window; a timed share's expiry was already set when it was shared.
 */
export async function startShareClock(share: ShareRow, now = new Date()): Promise<ShareRow> {
	if (share.firstViewedAt) return share;
	const ms = EXPIRATION_MS[share.expirationType];
	const [updated] = await db
		.update(albumShares)
		.set({ firstViewedAt: now, expiresAt: share.expiresAt ?? (ms == null ? null : new Date(now.getTime() + ms)) })
		.where(and(eq(albumShares.albumId, share.albumId), eq(albumShares.profileId, share.profileId), sql`${albumShares.firstViewedAt} IS NULL`))
		.returning();
	return updated ?? (await shareFor(share.albumId, share.profileId)) ?? share;
}

// --- View limits ----------------------------------------------------------------

/**
 * Which shared albums (and videos in them) a recipient may open, from the
 * entitlements albums.maxViewableAlbums / albums.maxViewableVideos (per role
 * and user). The most recently shared albums come first; everything beyond
 * the limit is returned locked and empty (`albumViewable: false`).
 */
export type ViewPlan = { albumViewable: (albumId: number) => boolean; videoViewable: (contentId: number) => boolean };

const ALL: ViewPlan = { albumViewable: () => true, videoViewable: () => true };

export async function viewPlanFor(viewer: bigint): Promise<ViewPlan> {
	const [maxAlbums, maxVideos] = await Promise.all([capValue(viewer, "albums.maxViewableAlbums"), capValue(viewer, "albums.maxViewableVideos")]);
	if (!Number.isFinite(maxAlbums) && !Number.isFinite(maxVideos)) return ALL;
	const rows = await db
		.select({ id: albumShares.albumId })
		.from(albumShares)
		.where(and(eq(albumShares.profileId, viewer), sql`(${albumShares.expiresAt} IS NULL OR ${albumShares.expiresAt} > now())`))
		.orderBy(desc(albumShares.sharedAt), desc(albumShares.albumId));
	const ordered = rows.map((r) => r.id);
	const viewable = new Set(Number.isFinite(maxAlbums) ? ordered.slice(0, Math.max(0, maxAlbums)) : ordered);
	let videoOk: ((contentId: number) => boolean) = () => true;
	if (Number.isFinite(maxVideos)) {
		const content = await contentOf([...viewable]);
		const allowed = new Set<number>();
		for (const id of ordered) {
			if (!viewable.has(id)) continue;
			for (const c of content.get(id) ?? []) {
				if (c.kind === "video" && allowed.size < maxVideos) allowed.add(c.contentId);
			}
		}
		videoOk = (contentId) => allowed.has(contentId);
	}
	return { albumViewable: (albumId) => viewable.has(albumId), videoViewable: videoOk };
}

/** Recipient's view of an album's items: videos over the limit are left out. */
export function visibleItems(items: ContentItem[], plan: ViewPlan): ContentItem[] {
	return items.filter((c) => c.kind !== "video" || plan.videoViewable(c.contentId));
}

export type AccessResult = { album: AlbumRow; owner: boolean; share: ShareRow | null; locked: boolean };

/** Owner, or a recipient with an active share; 403 otherwise. */
export async function albumAccess(me: bigint, albumId: number, opts: { startClock?: boolean } = {}): Promise<AccessResult> {
	const album = await loadAlbum(albumId);
	if (!album) throw errors.forbidden("Action not permitted");
	if (album.ownerId === me) return { album, owner: true, share: null, locked: false };
	let share = await shareFor(albumId, me);
	if (!isShareActive(share)) throw errors.forbidden("Action not permitted");
	// Over the view limit: locked — no clock starts, no content is handed out.
	if (!(await viewPlanFor(me)).albumViewable(albumId)) return { album, owner: false, share, locked: true };
	if (opts.startClock) share = await startShareClock(share);
	if (!isShareActive(share)) throw errors.forbidden("Action not permitted");
	return { album, owner: false, share, locked: false };
}

// --- Content ------------------------------------------------------------------

export type ContentItem = {
	contentId: number;
	albumId: number;
	position: number;
	hash: string;
	kind: "image" | "video" | "audio";
	state: string;
	posterHash: string | null;
	createdAt: Date;
};

export async function contentOf(albumIds: number[]): Promise<Map<number, ContentItem[]>> {
	const out = new Map<number, ContentItem[]>();
	if (!albumIds.length) return out;
	const rows = await db
		.select({ contentId: albumContent.id, albumId: albumContent.albumId, position: albumContent.position, hash: media.hash, kind: media.kind, state: media.state, posterHash: media.posterHash, createdAt: albumContent.createdAt })
		.from(albumContent)
		.innerJoin(media, eq(media.hash, albumContent.mediaHash))
		.where(inArray(albumContent.albumId, albumIds))
		.orderBy(asc(albumContent.albumId), asc(albumContent.position), asc(albumContent.id));
	for (const r of rows) {
		const list = out.get(r.albumId) ?? [];
		list.push(r);
		out.set(r.albumId, list);
	}
	return out;
}

export const isProcessing = (c: Pick<ContentItem, "state">) => c.state === "processing" || c.state === "failed";
export const contentType = (c: Pick<ContentItem, "kind">) => (c.kind === "video" ? "video/mp4" : "image/jpeg");

export async function albumTtl(): Promise<number> {
	return (await getServerSetting<number>("media.url.albumTtlSec")) ?? 1800;
}

export async function signAlbumMedia(ownerId: bigint, hash: string, variant: MediaVariant | undefined, notAfterMs?: number) {
	return signMediaUrl({ uploaderProfileId: String(ownerId), mediaHash: hash, variant, ttlSeconds: await albumTtl(), notAfterMs });
}

/** AlbumContent(+WithHash/+WithRemainingViews). Processing videos carry no URLs. */
export async function serializeContent(ownerId: bigint, c: ContentItem, opts: { owner: boolean; notAfterMs?: number }) {
	const processing = isProcessing(c);
	const [cover, thumb, full] = processing
		? [null, null, null]
		: await Promise.all([signAlbumMedia(ownerId, c.hash, "blur", opts.notAfterMs), signAlbumMedia(ownerId, c.hash, "thumb", opts.notAfterMs), signAlbumMedia(ownerId, c.hash, undefined, opts.notAfterMs)]);
	return {
		contentId: c.contentId,
		contentType: contentType(c),
		coverUrl: cover?.url ?? null,
		thumbUrl: thumb?.url ?? null,
		url: full?.url ?? null,
		statusId: processing ? 3 : 1,
		processing,
		rejectionId: null,
		...(opts.owner ? { contentHash: c.hash } : { remainingViews: -1 }),
	};
}

export function counts(items: ContentItem[]) {
	return { imageCount: items.filter((c) => c.kind === "image").length, videoCount: items.filter((c) => c.kind === "video").length };
}

/** ISO 8601 without zone, like upstream ("2026-03-27T20:39:00"). */
export const isoLocal = (d: Date) => d.toISOString().slice(0, 19);

/**
 * albumNumber / totalAlbumsShared: position of each of `ownerId`'s albums
 * among those actively shared with `viewerId` (oldest album = 1).
 */
export async function albumNumbering(ownerId: bigint, viewerId: bigint): Promise<Map<number, { albumNumber: number; total: number }>> {
	const rows = await db
		.select({ id: albums.id })
		.from(albumShares)
		.innerJoin(albums, eq(albums.id, albumShares.albumId))
		.where(and(eq(albums.ownerId, ownerId), eq(albumShares.profileId, viewerId), sql`(${albumShares.expiresAt} IS NULL OR ${albumShares.expiresAt} > now())`))
		.orderBy(asc(albums.createdAt), asc(albums.id));
	return new Map(rows.map((r, i) => [r.id, { albumNumber: i + 1, total: rows.length }]));
}

// --- Chat message bodies (dynamic: computed per viewer at read time) ----------

/**
 * AlbumMessageBody for Album/ExpiringAlbum(V2) messages. The share is always
 * owner → recipient of the message; a newer share's settings apply to older
 * messages too (upstream behavior).
 */
export async function albumMessageBody(albumId: number, ownerId: bigint, recipientId: bigint, viewerId: bigint) {
	const album = await loadAlbum(albumId);
	const share = album && album.ownerId === ownerId ? await shareFor(albumId, recipientId) : null;
	// Locked by the recipient's view limit counts as not viewable (for both sides, like upstream).
	const active = !!album && isShareActive(share) && (await viewPlanFor(recipientId)).albumViewable(albumId);
	const base = { albumId, expiresAt: share?.expiresAt?.getTime() ?? null, expirationType: share?.expirationType ?? null };
	if (!active || !album || !share) {
		return { ...base, albumNumber: null, totalAlbumsShared: null, hasUnseenContent: false, coverUrl: null, ownerProfileId: null, isViewable: false, hasVideo: false, hasPhoto: false, viewableUntil: null };
	}
	const items = visibleItems((await contentOf([albumId])).get(albumId) ?? [], await viewPlanFor(recipientId));
	const numbering = (await albumNumbering(ownerId, recipientId)).get(albumId);
	const first = items.find((c) => !isProcessing(c));
	const cover = first ? await signAlbumMedia(ownerId, first.hash, "blur", share.expiresAt?.getTime()) : null;
	return {
		...base,
		albumNumber: numbering?.albumNumber ?? null,
		totalAlbumsShared: numbering?.total ?? null,
		hasUnseenContent: viewerId === recipientId && share.seenVersion < album.version,
		coverUrl: cover?.url ?? null,
		ownerProfileId: Number(ownerId),
		isViewable: true,
		hasVideo: items.some((c) => c.kind === "video"),
		hasPhoto: items.some((c) => c.kind === "image"),
		viewableUntil: share.expiresAt?.getTime() ?? null,
	};
}

/** AlbumContentReaction/Reply bodies; `viewable` follows the viewer's access. */
export async function albumReactionBody(stored: { albumId: number; albumContentId: number; albumContentReply?: string }, viewerId: bigint) {
	const album = await loadAlbum(stored.albumId);
	let viewable = false;
	let notAfter: number | undefined;
	if (album) {
		if (album.ownerId === viewerId) viewable = true;
		else {
			const share = await shareFor(album.id, viewerId);
			viewable = isShareActive(share) && (await viewPlanFor(viewerId)).albumViewable(album.id);
			notAfter = share?.expiresAt?.getTime();
		}
	}
	const item = viewable && album ? ((await contentOf([album.id])).get(album.id) ?? []).find((c) => c.contentId === stored.albumContentId) : undefined;
	const preview = item && !isProcessing(item) && album ? await signAlbumMedia(album.ownerId, item.hash, "thumb", notAfter) : null;
	return {
		albumId: stored.albumId,
		ownerProfileId: viewable && album ? Number(album.ownerId) : null,
		albumContentId: stored.albumContentId,
		previewUrl: preview?.url ?? null,
		expiresAt: preview?.expiresAt ?? null,
		viewable: viewable && !!item,
		...(stored.albumContentReply != null ? { albumContentReply: stored.albumContentReply, contentType: item ? contentType(item) : null } : {}),
	};
}

/** Validates an album reaction/reply: the recipient owns the album and shares it with the sender. */
export async function validateAlbumReaction(senderId: bigint, recipientId: bigint, albumId: number, contentId: number): Promise<void> {
	const album = await loadAlbum(albumId);
	if (!album || album.ownerId !== recipientId) throw errors.badRequest("Invalid request");
	if (!isShareActive(await shareFor(albumId, senderId))) throw errors.badRequest("Invalid request");
	const items = (await contentOf([albumId])).get(albumId) ?? [];
	if (!items.some((c) => c.contentId === contentId)) throw errors.badRequest("Invalid request");
}

/** Worker: removes expired timed shares and tells both sides to refresh their album messages. */
export async function sweepExpiredAlbumShares(publish: (owner: bigint, recipient: bigint) => Promise<void>): Promise<number> {
	const rows = (await db.execute(sql`
		DELETE FROM album_shares s USING albums a
		WHERE a.id = s.album_id AND s.ctid IN (SELECT ctid FROM album_shares WHERE expires_at < now() LIMIT 1000)
		RETURNING a.owner_id::text AS owner, s.profile_id::text AS recipient`)) as unknown as { owner: string; recipient: string }[];
	for (const r of rows) await publish(BigInt(r.owner), BigInt(r.recipient)).catch(() => undefined);
	return rows.length;
}
