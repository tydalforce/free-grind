import multipart from "@fastify/multipart";
import { and, asc, count, eq, inArray, isNull, min, ne, sql } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { db } from "../db/client";
import { albumContent, albumContentViews, albumShares, albums, chatDrawer, media } from "../db/schema";
import { allowedValues, capValue, checkCap, consume, isFeatureEnabled, peek, release, requireEnabled } from "../entitlements/enforce";
import { resolveEntitlement } from "../entitlements/resolve";
import { displayedDistance } from "../geo/obfuscate";
import { errors } from "../lib/errors";
import { enforceRateLimit } from "../lib/rateLimit";
import { payloadTooLarge } from "../media/body";
import { publicImageUrl } from "../media/routes";
import { storeUpload } from "../media/service";
import { purgeIfUnused } from "../media/retention";
import { objectFile, objectKey } from "../media/storage";
import { sniffKind } from "../media/video";
import { getServerSetting } from "../modules/settings/settings";
import { getProfileCards } from "../profiles/cards";
import { getRelations, isBlockedEitherWay } from "../profiles/relations";
import { refreshDynamicBoth, sendSystemMessage } from "../chat/service";
import {
	type ContentItem,
	albumAccess,
	albumNumbering,
	contentOf,
	contentType,
	counts,
	isProcessing,
	isShareActive,
	isoLocal,
	normalizeExpiration,
	ownAlbum,
	serializeContent,
	shareFor,
	signAlbumMedia,
	startShareClock,
	viewPlanFor,
	visibleItems,
} from "./access";

/** Technical ceiling for one album upload request (the client's own limit is lower). */
const ALBUM_UPLOAD_MAX_BYTES = 600 * 1024 * 1024;
/** "Unlimited" in the numeric limit fields the client expects. */
const INT_MAX = 2_147_483_647;
const asInt = (n: number) => (Number.isFinite(n) ? Math.min(n, INT_MAX) : INT_MAX);

const albumNameSchema = z.object({ albumName: z.union([z.string(), z.number(), z.null()]).optional() });
function albumName(body: unknown): string | null {
	const r = albumNameSchema.safeParse(body ?? {});
	if (!r.success) throw errors.badRequest("Invalid request");
	const v = r.data.albumName;
	if (v == null) return null;
	const s = String(v);
	// Upstream: max 255 UTF-8 bytes.
	if (Buffer.byteLength(s, "utf8") > 255) throw errors.badRequest("Invalid request");
	return s;
}

const idParam = (v: string) => {
	const n = Number(v);
	if (!Number.isSafeInteger(n) || n <= 0) throw errors.forbidden("Action not permitted");
	return n;
};

async function bumpVersion(albumId: number): Promise<void> {
	await db.update(albums).set({ version: sql`${albums.version} + 1`, updatedAt: new Date() }).where(eq(albums.id, albumId));
}

async function activeShareCount(albumIds: number[]): Promise<Map<number, number>> {
	if (!albumIds.length) return new Map();
	const rows = await db
		.select({ albumId: albumShares.albumId, n: count() })
		.from(albumShares)
		.where(and(inArray(albumShares.albumId, albumIds), sql`(${albumShares.expiresAt} IS NULL OR ${albumShares.expiresAt} > now())`))
		.groupBy(albumShares.albumId);
	return new Map(rows.map((r) => [r.albumId, Number(r.n)]));
}

/** Copies a stored image (e.g. from the chat drawer) into an album as its own file. */
async function addToAlbum(albumId: number, mediaHash: string, isFresh: boolean): Promise<number> {
	const [existing] = await db.select({ id: albumContent.id }).from(albumContent).where(and(eq(albumContent.albumId, albumId), eq(albumContent.mediaHash, mediaHash))).limit(1);
	if (existing) return existing.id;
	const [first] = await db.select({ p: min(albumContent.position) }).from(albumContent).where(eq(albumContent.albumId, albumId));
	const position = (first?.p ?? 1) - 1;
	const [row] = await db.insert(albumContent).values({ albumId, mediaHash, position, isFresh }).onConflictDoNothing().returning({ id: albumContent.id });
	await bumpVersion(albumId);
	if (row) return row.id;
	const [again] = await db.select({ id: albumContent.id }).from(albumContent).where(and(eq(albumContent.albumId, albumId), eq(albumContent.mediaHash, mediaHash))).limit(1);
	return again!.id;
}

async function albumStorageBytes(ownerId: bigint): Promise<number> {
	const [row] = await db
		.select({ n: sql<string>`coalesce(sum(${media.bytes}), 0)` })
		.from(media)
		.where(and(eq(media.ownerId, ownerId), eq(media.purpose, "album"), isNull(media.deletedAt)));
	return Number(row?.n ?? 0);
}

/** Item caps: total, photos, videos (a video still processing doesn't count, like upstream). */
async function checkItemCaps(me: bigint, items: ContentItem[], adding: "image" | "video"): Promise<void> {
	const images = items.filter((c) => c.kind === "image").length;
	const readyVideos = items.filter((c) => c.kind === "video" && !isProcessing(c)).length;
	await checkCap(me, "albums.maxItemsPerAlbum", images + readyVideos);
	if (adding === "image") await checkCap(me, "albums.maxImagesPerAlbum", images);
	else await checkCap(me, "albums.maxVideosPerAlbum", readyVideos);
}

async function myAlbumsResponse(me: bigint) {
	const rows = await db.select().from(albums).where(eq(albums.ownerId, me)).orderBy(asc(albums.createdAt), asc(albums.id));
	const ids = rows.map((r) => r.id);
	const [content, shared] = await Promise.all([contentOf(ids), activeShareCount(ids)]);
	return {
		albums: await Promise.all(
			rows.map(async (a) => {
				const items = content.get(a.id) ?? [];
				return {
					albumId: a.id,
					albumName: a.name,
					profileId: Number(me),
					version: a.version,
					sharedCount: shared.get(a.id) ?? 0,
					createdAt: isoLocal(a.createdAt),
					updatedAt: isoLocal(a.updatedAt),
					content: await Promise.all(items.map((c) => serializeContent(me, c, { owner: true }))),
					isShareable: items.some((c) => !isProcessing(c)),
				};
			}),
		),
	};
}

async function albumDetails(req: FastifyRequest) {
	const me = req.auth.userId;
	const albumId = idParam((req.params as { id: string }).id);
	const { album, owner, share, locked } = await albumAccess(me, albumId, { startClock: true });
	const all = (await contentOf([albumId])).get(albumId) ?? [];
	// Over the view limit: the album comes back empty and not viewable.
	const items = owner ? all : locked ? [] : visibleItems(all, await viewPlanFor(me));
	const notAfterMs = share?.expiresAt?.getTime();
	const numbering = owner ? null : (await albumNumbering(album.ownerId, me)).get(albumId);
	const shared = (await activeShareCount([albumId])).get(albumId) ?? 0;
	return {
		albumId: album.id,
		albumNumber: numbering?.albumNumber ?? null,
		totalAlbumsShared: numbering?.total ?? null,
		hasUnseenContent: !owner && !locked && !!share && share.seenVersion < album.version,
		albumName: album.name,
		profileId: Number(album.ownerId),
		albumViewable: !locked,
		sharedCount: shared,
		createdAt: isoLocal(album.createdAt),
		updatedAt: isoLocal(album.updatedAt),
		content: await Promise.all(items.map((c) => serializeContent(album.ownerId, c, { owner, notAfterMs }))),
		isShareable: owner && items.some((c) => !isProcessing(c)),
		contentCount: counts(items),
	};
}

export async function albumRoutes(app: FastifyInstance): Promise<void> {
	await app.register(multipart, { limits: { files: 1, fields: 10, fileSize: ALBUM_UPLOAD_MAX_BYTES } });
	const auth = { preHandler: app.authenticate };

	app.get("/v1/albums", auth, (req) => myAlbumsResponse(req.auth.userId));
	app.get("/v2/albums/:id", auth, albumDetails);
	app.get("/v1/albums/:id", auth, albumDetails);

	app.post("/v2/albums", auth, async (req) => {
		const name = albumName(req.body);
		const [n] = await db.select({ n: count() }).from(albums).where(eq(albums.ownerId, req.auth.userId));
		await checkCap(req.auth.userId, "albums.maxCount", Number(n?.n ?? 0));
		const [row] = await db.insert(albums).values({ ownerId: req.auth.userId, name }).returning();
		return { albumId: row!.id, albumName: row!.name };
	});

	app.put("/v2/albums/:id", auth, async (req) => {
		const album = await ownAlbum(req.auth.userId, idParam((req.params as { id: string }).id));
		const name = albumName(req.body);
		await db.update(albums).set({ name, updatedAt: new Date() }).where(eq(albums.id, album.id));
		return { albumId: album.id, albumName: name };
	});

	app.delete("/v1/albums/:id", auth, async (req) => {
		const album = await ownAlbum(req.auth.userId, idParam((req.params as { id: string }).id));
		const recipients = await db.select({ p: albumShares.profileId, expirationType: albumShares.expirationType }).from(albumShares).where(eq(albumShares.albumId, album.id));
		const hashes = ((await contentOf([album.id])).get(album.id) ?? []).map((c) => c.hash);
		await db.delete(albums).where(eq(albums.id, album.id));
		await purgeIfUnused(hashes);
		// Deleting unshares it from everyone: both sides' album messages change.
		for (const r of recipients) await refreshDynamicBoth(album.ownerId, r.p, r.expirationType);
		return {};
	});

	// --- Content ---------------------------------------------------------------

	app.post("/v1/albums/:id/content", { ...auth, bodyLimit: ALBUM_UPLOAD_MAX_BYTES }, async (req) => {
		const me = req.auth.userId;
		const album = await ownAlbum(me, idParam((req.params as { id: string }).id));
		await enforceRateLimit(`upload:album:${req.auth.profileId}`, 300, 3_600_000, { ip: req.ip, userId: req.auth.profileId });
		const q = z.object({ width: z.string().regex(/^\d+$/).optional(), height: z.string().regex(/^\d+$/).optional(), isFresh: z.string().optional() }).safeParse(req.query);
		if (!q.success) throw errors.badRequest("Invalid request");
		if (!req.isMultipart()) throw errors.badRequest("Invalid request");

		const [imageMax, videoMax] = await Promise.all([capValue(me, "albums.image.maxBytes"), capValue(me, "albums.video.maxBytes")]);
		const limit = Math.min(ALBUM_UPLOAD_MAX_BYTES, Math.max(imageMax, videoMax));
		const declared = Number(req.headers["content-length"] ?? Number.NaN);
		if (Number.isFinite(declared) && declared > limit + 64 * 1024) throw payloadTooLarge();
		let body: Buffer | null = null;
		for await (const part of req.parts({ limits: { fileSize: limit } })) {
			if (part.type === "file" && part.fieldname === "content" && !body) {
				try {
					body = await part.toBuffer();
				} catch {
					throw payloadTooLarge();
				}
			} else if (part.type === "file") {
				part.file.resume();
			}
		}
		if (!body) throw errors.badRequest("Invalid request");

		const kind = sniffKind(body);
		if (kind !== "image" && kind !== "video") throw errors.badRequest("Invalid request");
		if (kind === "video" && (!q.data.width || !q.data.height)) throw errors.badRequest("Invalid request");
		if (body.length > (kind === "video" ? videoMax : imageMax)) throw payloadTooLarge();

		const items = (await contentOf([album.id])).get(album.id) ?? [];
		await checkItemCaps(me, items, kind);
		await checkCap(me, "albums.maxStorageBytes", await albumStorageBytes(me), body.length);
		await consume(me, "albums.uploadsPerDay");

		const maxMs = await capValue(me, "albums.video.maxDurationMs");
		const row = await storeUpload(body, {
			ownerId: me,
			purpose: "album",
			accept: ["image", "video"],
			takenOnGrindr: false,
			video: { maxDurationMs: Number.isFinite(maxMs) ? maxMs : null, muteAudio: false },
		});
		const contentId = await addToAlbum(album.id, row.hash, q.data.isFresh === "true");
		return { contentId, contentUrl: null };
	});

	app.post("/v1/albums/:id/content/order", auth, async (req) => {
		const album = await ownAlbum(req.auth.userId, idParam((req.params as { id: string }).id));
		const b = z.object({ contentIds: z.array(z.coerce.number().int()).max(1000) }).safeParse(req.body);
		if (!b.success) throw errors.badRequest("Invalid request");
		const items = (await contentOf([album.id])).get(album.id) ?? [];
		const ids = b.data.contentIds;
		const known = new Set(items.map((c) => c.contentId));
		if (ids.length !== known.size || new Set(ids).size !== ids.length || !ids.every((id) => known.has(id))) throw errors.badRequest("Invalid request");
		await db.transaction(async (tx) => {
			for (const [position, id] of ids.entries()) await tx.update(albumContent).set({ position }).where(and(eq(albumContent.id, id), eq(albumContent.albumId, album.id)));
		});
		await db.update(albums).set({ updatedAt: new Date() }).where(eq(albums.id, album.id));
		return {};
	});

	const ownContent = async (req: FastifyRequest) => {
		const { id, cid } = req.params as { id: string; cid: string };
		const album = await ownAlbum(req.auth.userId, idParam(id));
		const item = ((await contentOf([album.id])).get(album.id) ?? []).find((c) => c.contentId === Number(cid));
		if (!item) throw errors.forbidden("Action not permitted");
		return { album, item };
	};

	app.delete("/v1/albums/:id/content/:cid", auth, async (req, reply) => {
		const { album, item } = await ownContent(req);
		if (isProcessing(item)) return reply.code(400).send();
		await db.delete(albumContent).where(eq(albumContent.id, item.contentId));
		// Deleted in the album → the file goes too (unless another album still has it).
		await purgeIfUnused([item.hash]);
		await db.update(albums).set({ updatedAt: new Date() }).where(eq(albums.id, album.id));
		return {};
	});

	app.get("/v1/albums/:id/content/:cid/processing", auth, async (req) => {
		const { item } = await ownContent(req);
		return { processing: isProcessing(item) };
	});

	app.get("/v1/albums/:id/content/:cid/poster", auth, async (req) => {
		const { id, cid } = req.params as { id: string; cid: string };
		const { album, share, locked } = await albumAccess(req.auth.userId, idParam(id));
		if (locked) throw errors.forbidden("Action not permitted");
		const item = ((await contentOf([album.id])).get(album.id) ?? []).find((c) => c.contentId === Number(cid));
		if (!item) throw errors.forbidden("Action not permitted");
		if (isProcessing(item)) return { posterUrl: null, blurredPosterUrl: null };
		const notAfter = share?.expiresAt?.getTime();
		const [poster, blurred] = await Promise.all([signAlbumMedia(album.ownerId, item.hash, "thumb", notAfter), signAlbumMedia(album.ownerId, item.hash, "blur", notAfter)]);
		return { posterUrl: poster.url, blurredPosterUrl: blurred.url };
	});

	/** Drawer → album: separate copies; videos are refused (upstream 400). */
	app.post("/v1/albums/:id/content/chat/list-by-id", auth, async (req, reply) => {
		const me = req.auth.userId;
		const album = await ownAlbum(me, idParam((req.params as { id: string }).id));
		const b = z.object({ ids: z.array(z.coerce.number().int()).min(1).max(100) }).safeParse(req.body);
		if (!b.success) throw errors.badRequest("Invalid request");
		const isFresh = (req.query as { isFresh?: string }).isFresh === "true";
		const rows = await db
			.select({ hash: media.hash, kind: media.kind, purpose: media.purpose })
			.from(chatDrawer)
			.innerJoin(media, eq(media.hash, chatDrawer.mediaHash))
			.where(and(eq(chatDrawer.ownerId, me), inArray(media.mediaId, b.data.ids), isNull(media.deletedAt)));
		if (rows.length !== new Set(b.data.ids).size || rows.some((r) => r.kind !== "image")) return reply.code(400).send();
		for (const r of rows) {
			const items = (await contentOf([album.id])).get(album.id) ?? [];
			// Unlike uploads, every item counts toward the total here.
			await checkCap(me, "albums.maxItemsPerAlbum", items.length);
			await checkCap(me, "albums.maxImagesPerAlbum", items.filter((c) => c.kind === "image").length);
			const bytes = Buffer.from(await objectFile(objectKey(r.purpose, r.hash, "master.jpg")).arrayBuffer());
			const copy = await storeUpload(bytes, { ownerId: me, purpose: "album", accept: ["image"], takenOnGrindr: false });
			await addToAlbum(album.id, copy.hash, isFresh);
		}
		return {};
	});

	// --- Limits --------------------------------------------------------------------

	app.get("/v1/albums/storage", auth, async (req) => {
		const me = req.auth.userId;
		const cap = (k: string) => capValue(me, k);
		const [maxAlbums, items, images, videos, shares, viewable, viewableVideos, imageBytes, videoBytes, maxVideoMs, minVideoMs, shareable] = await Promise.all([
			cap("albums.maxCount"), cap("albums.maxItemsPerAlbum"), cap("albums.maxImagesPerAlbum"), cap("albums.maxVideosPerAlbum"),
			cap("albums.maxSharesPerAlbum"), cap("albums.maxViewableAlbums"), cap("albums.maxViewableVideos"),
			cap("albums.image.maxBytes"), cap("albums.video.maxBytes"), cap("albums.video.maxDurationMs"), cap("albums.video.minDurationMs"), cap("albums.maxShareableAlbums"),
		]);
		const maxContentSize = Math.min(ALBUM_UPLOAD_MAX_BYTES, Math.max(imageBytes, videoBytes));
		const role = req.auth.claims.roles[0];
		return {
			subscriptionType: role ? `${role[0]!.toUpperCase()}${role.slice(1)}Albums` : "FreeAlbums",
			maxAlbums: asInt(maxAlbums),
			maxContentItemsPerAlbum: asInt(Math.min(items, images)),
			maxShares: asInt(shares),
			maxViewableAlbums: asInt(viewable),
			maxViewableVideos: asInt(viewableVideos),
			maxContentSize,
			// Upstream labels MiB as "MB".
			maxContentSizeHumanReadable: `${(maxContentSize / 1024 / 1024).toFixed(2)} MB`,
			maxVideoLength: Number.isFinite(maxVideoMs) ? maxVideoMs : INT_MAX,
			minVideoLength: Number.isFinite(minVideoMs) ? minVideoMs : 0,
			maxShareableAlbums: asInt(shareable),
			maxVideosPerAlbum: asInt(videos),
		};
	});

	app.get("/v4/pics/expiring/status", auth, async (req) => expiringStatus(req.auth.userId, "chat.expiringImages.enabled", "chat.expiringImages.perDay"));
	app.get("/v4/videos/expiring/status", auth, async (req) => expiringStatus(req.auth.userId, "chat.expiringVideos.enabled", "chat.expiringVideos.perDay"));
	app.get("/v4/albums/expiring/status", auth, async (req) => expiringStatus(req.auth.userId, "albums.expiringShares", "albums.expiringShares.perDay"));
	app.get("/v1/pics/limited/status", auth, async () => ({ total: INT_MAX, available: INT_MAX }));

	// --- Shares --------------------------------------------------------------------

	app.get("/v1/albums/:id/shares", auth, async (req) => {
		const album = await ownAlbum(req.auth.userId, idParam((req.params as { id: string }).id));
		const rows = await db
			.select({ p: albumShares.profileId })
			.from(albumShares)
			.where(and(eq(albumShares.albumId, album.id), sql`(${albumShares.expiresAt} IS NULL OR ${albumShares.expiresAt} > now())`));
		return { profileIds: rows.map((r) => Number(r.p)) };
	});

	app.post("/v4/albums/:id/shares", auth, async (req) => {
		const me = req.auth.userId;
		const album = await ownAlbum(me, idParam((req.params as { id: string }).id));
		const b = z
			.object({ profiles: z.array(z.object({ profileId: z.union([z.number().int(), z.string().regex(/^\d{1,19}$/)]), expirationType: z.union([z.string(), z.number().int()]) })).min(1).max(100) })
			.safeParse(req.body);
		if (!b.success) throw errors.badRequest("Invalid request");
		await requireEnabled(me, "albums.share");

		const targets: { profileId: bigint; expirationType: NonNullable<ReturnType<typeof normalizeExpiration>> }[] = [];
		for (const p of b.data.profiles) {
			const expirationType = normalizeExpiration(p.expirationType);
			if (!expirationType) throw errors.badRequest("Invalid request");
			const profileId = BigInt(p.profileId);
			if (profileId === me) throw errors.badRequest("Invalid request");
			targets.push({ profileId, expirationType });
		}
		if (targets.some((t) => t.expirationType !== "INDEFINITE")) {
			await requireEnabled(me, "albums.expiringShares");
			const allowed = await allowedValues(me, "albums.allowedExpirationTypes");
			if (allowed && targets.some((t) => !allowed.includes(t.expirationType))) throw errors.tieredFeature("albums.allowedExpirationTypes");
		}

		const cards = await getProfileCards(targets.map((t) => t.profileId));
		const valid: typeof targets = [];
		for (const t of targets) {
			const card = cards.get(String(t.profileId));
			if (!card || card.deleted || (await isBlockedEitherWay(String(me), String(t.profileId)))) continue;
			valid.push(t);
		}
		const existing = new Set((await db.select({ p: albumShares.profileId }).from(albumShares).where(eq(albumShares.albumId, album.id))).map((r) => String(r.p)));
		const fresh = valid.filter((t) => !existing.has(String(t.profileId)));
		if (fresh.length) {
			await checkCap(me, "albums.maxSharesPerAlbum", existing.size, fresh.length);
			if (!existing.size) {
				const [shared] = await db
					.select({ n: sql<number>`count(DISTINCT ${albumShares.albumId})::int` })
					.from(albumShares)
					.innerJoin(albums, eq(albums.id, albumShares.albumId))
					.where(and(eq(albums.ownerId, me), ne(albums.id, album.id)));
				await checkCap(me, "albums.maxShareableAlbums", shared?.n ?? 0);
			}
			await consume(me, "albums.sharesPerDay", fresh.length);
		}
		// Every expiring share (re-shares too: each one sends a new ExpiringAlbumV2) counts against the expiring allowance.
		const expiringCount = valid.filter((t) => t.expirationType !== "INDEFINITE").length;
		if (expiringCount) {
			try {
				await consume(me, "albums.expiringShares.perDay", expiringCount);
			} catch (e) {
				if (fresh.length) await release(me, "albums.sharesPerDay", fresh.length).catch(() => undefined);
				throw e;
			}
		}

		for (const t of valid) {
			// Re-sharing renews the share; its settings apply to earlier album messages too.
			const reshare = existing.has(String(t.profileId));
			await db
				.insert(albumShares)
				.values({ albumId: album.id, profileId: t.profileId, expirationType: t.expirationType })
				.onConflictDoUpdate({ target: [albumShares.albumId, albumShares.profileId], set: { expirationType: t.expirationType, sharedAt: new Date(), firstViewedAt: null, expiresAt: null } });
			const type = t.expirationType === "INDEFINITE" ? "Album" : "ExpiringAlbumV2";
			await sendSystemMessage(me, t.profileId, type, { albumId: album.id });
			// Earlier album messages now carry the new share's state (expiration, viewable again).
			if (reshare) await refreshDynamicBoth(me, t.profileId, t.expirationType);
		}
		return {};
	});

	app.put("/v1/albums/:id/unshares", auth, async (req) => {
		const album = await ownAlbum(req.auth.userId, idParam((req.params as { id: string }).id));
		const b = z.object({ profiles: z.array(z.object({ profileId: z.union([z.number().int(), z.string().regex(/^\d{1,19}$/)]), shareId: z.unknown().optional() })).max(500) }).safeParse(req.body);
		if (!b.success) throw errors.badRequest("Invalid request");
		const ids = b.data.profiles.map((p) => BigInt(p.profileId));
		if (ids.length) {
			const removed = await db
				.delete(albumShares)
				.where(and(eq(albumShares.albumId, album.id), inArray(albumShares.profileId, ids)))
				.returning({ p: albumShares.profileId, expirationType: albumShares.expirationType });
			for (const r of removed) await refreshDynamicBoth(album.ownerId, r.p, r.expirationType);
		}
		return {};
	});

	/** The recipient drops a share of someone else's album; 403 once it's gone (upstream). */
	app.put("/v1/albums/:id/shares/remove", auth, async (req) => {
		const albumId = idParam((req.params as { id: string }).id);
		const removed = await db
			.delete(albumShares)
			.where(and(eq(albumShares.albumId, albumId), eq(albumShares.profileId, req.auth.userId)))
			.returning({ albumId: albumShares.albumId, expirationType: albumShares.expirationType });
		if (!removed.length) throw errors.forbidden("Action not permitted");
		const [album] = await db.select({ ownerId: albums.ownerId }).from(albums).where(eq(albums.id, albumId));
		// Both sides: the recipient's other devices show the message too.
		if (album) await refreshDynamicBoth(album.ownerId, req.auth.userId, removed[0]!.expirationType);
		return {};
	});

	/** Records the opening of a shared album: starts a timed share; a second ONCE view is refused. */
	app.get("/v3/albums/:id/view", auth, async (req) => {
		const me = req.auth.userId;
		const albumId = idParam((req.params as { id: string }).id);
		const album = await ownAlbum(me, albumId).catch(() => null);
		if (album) return {};
		const share = await shareFor(albumId, me);
		if (!isShareActive(share)) throw errors.forbidden("Action not permitted");
		if (share.expirationType === "ONCE" && share.firstViewedAt) throw errors.forbidden("Action not permitted");
		if (!(await viewPlanFor(me)).albumViewable(albumId)) throw errors.forbidden("Action not permitted");
		const started = await startShareClock(share);
		const [owner] = await db.select({ ownerId: albums.ownerId, version: albums.version }).from(albums).where(eq(albums.id, albumId));
		if (owner) {
			await db.update(albumShares).set({ seenVersion: owner.version }).where(and(eq(albumShares.albumId, albumId), eq(albumShares.profileId, me)));
			// Viewed: a timed share's clock started and hasUnseenContent cleared.
			await refreshDynamicBoth(owner.ownerId, me, started.expirationType);
		}
		return {};
	});

	app.post("/v1/albums/:id/view/content/:cid", auth, async (req) => {
		const { id, cid } = req.params as { id: string; cid: string };
		const { album, owner, locked } = await albumAccess(req.auth.userId, idParam(id), { startClock: true });
		if (locked) throw errors.forbidden("Action not permitted");
		const contentId = Number(cid);
		if (!owner && Number.isSafeInteger(contentId)) {
			await db
				.insert(albumContentViews)
				.values({ albumId: album.id, profileId: req.auth.userId, contentId, views: 1 })
				.onConflictDoUpdate({ target: [albumContentViews.albumId, albumContentViews.profileId, albumContentViews.contentId], set: { views: sql`${albumContentViews.views} + 1` } });
		}
		return { remainingViews: -1 };
	});

	/** Albums `profileId` shares with me. */
	app.get("/v2/albums/shares/:profileId", auth, async (req) => {
		const me = req.auth.userId;
		const p = (req.params as { profileId: string }).profileId;
		if (!/^\d{1,19}$/.test(p)) throw errors.badRequest("Invalid request");
		const ownerId = BigInt(p);
		if (await isBlockedEitherWay(String(me), p)) return { albums: [] };
		return { albums: await sharedWithMe(me, [ownerId]) };
	});

	app.post("/v2/albums/shares", auth, async (req) => {
		const b = z.object({ profileId: z.union([z.number().int(), z.string().regex(/^\d{1,19}$/)]) }).safeParse(req.body);
		if (!b.success) throw errors.badRequest("Invalid request");
		const other = BigInt(b.data.profileId);
		const me = req.auth.userId;
		const [hasAlbum] = await db
			.select({ id: albums.id })
			.from(albums)
			.innerJoin(albumContent, eq(albumContent.albumId, albums.id))
			.where(eq(albums.ownerId, other))
			.limit(1);
		const shared = (await sharedWithMe(me, [other])).length > 0;
		const blocked = await isBlockedEitherWay(String(me), String(other));
		return { profileId: Number(other), hasAlbum: !blocked && !!hasAlbum, hasSharedWithMe: !blocked && shared };
	});

	app.post("/v3/pressie-albums/feed", auth, async (req) => {
		const me = req.auth.userId;
		const f = z.object({ isFavorite: z.boolean().optional(), isOnline: z.boolean().optional(), onlyVideo: z.boolean().optional(), blur: z.boolean().optional() }).partial().nullable().optional().parse(req.body ?? {}) ?? {};
		const rel = await getRelations(String(me));
		const shareRows = await db
			.select({ albumId: albumShares.albumId, ownerId: albums.ownerId })
			.from(albumShares)
			.innerJoin(albums, eq(albums.id, albumShares.albumId))
			.where(and(eq(albumShares.profileId, me), sql`(${albumShares.expiresAt} IS NULL OR ${albumShares.expiresAt} > now())`));
		let owners = [...new Set(shareRows.map((r) => r.ownerId))].filter((o) => !rel.blocked.has(String(o)));
		if (f.isFavorite) owners = owners.filter((o) => rel.favorites.has(String(o)));
		const list = await sharedWithMe(me, owners);
		const cards = await getProfileCards(owners);
		const online = f.isOnline ? await onlineSet(owners) : null;
		const geo = await distancesKm(me, owners);
		const sharedAlbums = list
			.filter((a) => (!f.onlyVideo || a.contentCount.videoCount > 0) && (!online || online.has(String(a.profileId))) && (a.content || !a.albumViewable))
			.map((a) => {
				const card = cards.get(String(a.profileId));
				return {
					albumId: a.albumId,
					albumNumber: a.albumNumber,
					totalAlbumsShared: a.totalAlbumsShared,
					hasUnseenContent: a.hasUnseenContent,
					albumViewable: a.albumViewable,
					albumVersion: a.version,
					expiresAt: a.expiresAt,
					name: a.albumName,
					ownerProfileId: a.profileId,
					imageCount: a.contentCount.imageCount,
					videoCount: a.contentCount.videoCount,
					coverContent: a.content
						? { id: a.content.contentId, contentType: a.content.contentType, location: a.content.coverUrl, status: a.content.statusId === 1 ? "ACTIVE" : "PROCESSING" }
						: { id: 0, contentType: "image/jpeg", location: null, status: "LOCKED" },
					profile: { profileId: a.profileId, name: card?.displayName ?? "", profileUrl: card?.primaryMediaHash ? publicImageUrl("thumb", "320x320", card.primaryMediaHash) : null, onlineUntil: geo.get(String(a.profileId))?.onlineUntil ?? null, distanceKm: card?.showDistance ? (geo.get(String(a.profileId))?.km ?? null) : null },
				};
			});
		const mine = await db.select({ id: albums.id }).from(albums).where(eq(albums.ownerId, me)).orderBy(asc(albums.createdAt));
		const content = await contentOf(mine.map((m) => m.id));
		const nonEmpty = mine.filter((m) => (content.get(m.id) ?? []).length > 0);
		// One entry per profile: its newest viewable item, or PAYWALL when all of
		// its albums are over the view limit (then without content, like a locked album).
		const byOwner = new Map<number, typeof sharedAlbums>();
		for (const a of sharedAlbums) byOwner.set(a.ownerProfileId, [...(byOwner.get(a.ownerProfileId) ?? []), a]);
		const profileFeeds = [...byOwner.entries()].map(([ownerId, list]) => {
			const open = list.filter((a) => a.albumViewable && a.coverContent.location);
			const newest = open.sort((x, y) => (y.albumVersion ?? 0) - (x.albumVersion ?? 0))[0];
			return {
				profileId: ownerId,
				paywallStatus: open.length ? "ALLOW" : "PAYWALL",
				seen: !list.some((a) => a.hasUnseenContent),
				content: newest
					? { contentId: newest.coverContent.id, contentType: newest.coverContent.contentType, coverUrl: newest.coverContent.location }
					: { contentId: 0, contentType: "image/jpeg", coverUrl: null },
				profile: list[0]!.profile,
			};
		});
		return {
			profileFeeds,
			sharedAlbums,
			nonEmptyPersonalAlbumCount: nonEmpty.length,
			emptyAlbumId: mine.find((m) => !(content.get(m.id) ?? []).length)?.id ?? null,
		};
	});
}

/**
 * /v4/{pics,videos,albums}/expiring/status: the tightest window's size and what's
 * left of it; INT_MAX for both when unlimited, 0/0 when the feature is off.
 */
async function expiringStatus(me: bigint, enabledKey: string, quotaKey: string) {
	if (!(await isFeatureEnabled(me, enabledKey))) return { total: 0, available: 0 };
	const { value } = await resolveEntitlement(me, quotaKey);
	const r = await peek(me, quotaKey);
	if (!Number.isFinite(r.remaining) || typeof value !== "object" || !value || !("windows" in value) || !value.windows.length) return { total: INT_MAX, available: INT_MAX };
	const total = Math.min(...value.windows.map((w) => (w.window === "refill" ? w.max : w.count)));
	return { total, available: Math.max(0, Math.min(total, r.remaining)) };
}

/** AlbumsSharedByProfile entries for the given owners' albums actively shared with `me`. */
async function sharedWithMe(me: bigint, owners: bigint[]) {
	if (!owners.length) return [];
	const rows = await db
		.select({ album: albums, share: albumShares })
		.from(albumShares)
		.innerJoin(albums, eq(albums.id, albumShares.albumId))
		.where(and(eq(albumShares.profileId, me), inArray(albums.ownerId, owners), sql`(${albumShares.expiresAt} IS NULL OR ${albumShares.expiresAt} > now())`))
		.orderBy(asc(albums.createdAt), asc(albums.id));
	const content = await contentOf(rows.map((r) => r.album.id));
	const plan = await viewPlanFor(me);
	const numberingByOwner = new Map<string, Map<number, { albumNumber: number; total: number }>>();
	for (const o of new Set(rows.map((r) => String(r.album.ownerId)))) numberingByOwner.set(o, await albumNumbering(BigInt(o), me));
	return Promise.all(
		rows.map(async ({ album, share }) => {
			const viewable = plan.albumViewable(album.id);
			// Locked (over the view limit): returned empty — no content, counts or URLs.
			const items = viewable ? visibleItems(content.get(album.id) ?? [], plan) : [];
			const first = items.find((c) => !isProcessing(c));
			const n = numberingByOwner.get(String(album.ownerId))?.get(album.id);
			const notAfter = share.expiresAt?.getTime();
			const [cover, thumb] = first ? await Promise.all([signAlbumMedia(album.ownerId, first.hash, "blur", notAfter), signAlbumMedia(album.ownerId, first.hash, "thumb", notAfter)]) : [null, null];
			return {
				albumId: album.id,
				albumNumber: n?.albumNumber ?? null,
				totalAlbumsShared: n?.total ?? null,
				hasUnseenContent: viewable && share.seenVersion < album.version,
				albumName: null as string | null,
				profileId: Number(album.ownerId),
				albumViewable: viewable,
				expiresAt: share.expiresAt?.getTime() ?? null,
				expirationType: share.expirationType,
				version: album.version,
				content: first ? { contentId: first.contentId, contentType: contentType(first), coverUrl: cover!.url, thumbUrl: thumb!.url, statusId: 1 } : null,
				contentCount: counts(items),
			};
		}),
	);
}

async function onlineSet(ids: bigint[]): Promise<Set<string>> {
	if (!ids.length) return new Set();
	const rows = (await db.execute(sql`SELECT user_id::text AS id FROM profiles WHERE user_id = ANY(${`{${ids.join(",")}}`}::bigint[]) AND online_until > now()`)) as unknown as { id: string }[];
	return new Set(rows.map((r) => r.id));
}

async function distancesKm(me: bigint, ids: bigint[]): Promise<Map<string, { km: number | null; onlineUntil: number | null }>> {
	if (!ids.length) return new Map();
	const round = (await getServerSetting<number>("distance.roundMeters")) ?? 100;
	const rows = (await db.execute(sql`
		SELECT p.user_id::text AS id, ST_Distance(p.public_location, me.public_location) AS d, (extract(epoch FROM p.online_until) * 1000)::bigint AS ou
		FROM profiles p LEFT JOIN profiles me ON me.user_id = ${me}
		WHERE p.user_id = ANY(${`{${ids.join(",")}}`}::bigint[])`)) as unknown as { id: string; d: number | null; ou: string | null }[];
	return new Map(rows.map((r) => [r.id, { km: r.d == null ? null : displayedDistance(Number(r.d), { roundMeters: round, approximate: false }) / 1000, onlineUntil: r.ou == null ? null : Number(r.ou) }]));
}

