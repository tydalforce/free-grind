import { and, asc, desc, eq, isNull, lt, sql } from "drizzle-orm";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { db, dbRead } from "../../db/client";
import { albumContent, chatDrawer, media, profileMedia, profiles } from "../../db/schema";
import { ApiError } from "../../lib/errors";
import { purgeMedia } from "../../media/retention";
import { objectFile, objectKey } from "../../media/storage";
import { streamWithRange } from "../../media/routes";
import { invalidateProfileCard } from "../../profiles/cards";
import { audit } from "../audit";

const hashParam = z.object({ hash: z.string().regex(/^[a-f0-9]{32,64}$/) });

async function sendFile(reply: FastifyReply, key: string, type: string) {
	const file = objectFile(key);
	if (!(await file.exists())) return reply.code(404).send({ error: "not_found" });
	reply.header("content-type", type).header("cache-control", "private, no-store");
	return reply.send(file.stream());
}

/** Admin "Medien": recent uploads, where they're used, previews, deletion, storage per user. */
export async function adminMediaRoutes(app: FastifyInstance): Promise<void> {
	app.get("/admin/api/media", { preHandler: app.requireAdmin }, async (req) => {
		const q = z
			.object({
				purpose: z.enum(["profile", "chat", "album", "rightnow"]).optional(),
				kind: z.enum(["image", "video", "audio"]).optional(),
				ownerId: z.string().regex(/^\d{1,19}$/).optional(),
				deleted: z.enum(["true", "false"]).optional(),
				before: z.string().regex(/^\d+$/).optional(),
				limit: z.coerce.number().int().min(1).max(100).default(48),
			})
			.parse(req.query);
		const conds = [];
		if (q.purpose) conds.push(eq(media.purpose, q.purpose));
		if (q.kind) conds.push(eq(media.kind, q.kind));
		if (q.ownerId) conds.push(eq(media.ownerId, BigInt(q.ownerId)));
		conds.push(q.deleted === "true" ? sql`${media.deletedAt} IS NOT NULL` : isNull(media.deletedAt));
		if (q.before) conds.push(lt(media.mediaId, Number(q.before)));
		// Posters are an implementation detail of videos: not listed on their own.
		conds.push(sql`NOT EXISTS (SELECT 1 FROM media v WHERE v.poster_hash = ${media.hash})`);
		const rows = await dbRead
			.select({
				hash: media.hash,
				mediaId: media.mediaId,
				ownerId: media.ownerId,
				ownerName: profiles.displayName,
				kind: media.kind,
				purpose: media.purpose,
				state: media.state,
				bytes: media.bytes,
				width: media.width,
				height: media.height,
				durationMs: media.durationMs,
				takenOnGrindr: media.takenOnGrindr,
				createdAt: media.createdAt,
				deletedAt: media.deletedAt,
				inProfile: sql<boolean>`EXISTS (SELECT 1 FROM profile_media p WHERE p.media_hash = ${media.hash})`,
				albums: sql<number>`(SELECT count(*)::int FROM album_content c WHERE c.media_hash = ${media.hash})`,
				inDrawer: sql<boolean>`EXISTS (SELECT 1 FROM chat_drawer d WHERE d.media_hash = ${media.hash})`,
			})
			.from(media)
			.leftJoin(profiles, eq(profiles.userId, media.ownerId))
			.where(and(...conds))
			.orderBy(desc(media.mediaId))
			.limit(q.limit);
		return {
			media: rows.map((r) => ({ ...r, ownerId: String(r.ownerId) })),
			next: rows.length === q.limit ? String(rows[rows.length - 1]!.mediaId) : null,
		};
	});

	/** Small preview for the admin grid (image, or a video's poster). */
	app.get("/admin/api/media/:hash/preview", { preHandler: app.requireAdmin }, async (req, reply) => {
		const { hash } = hashParam.parse(req.params);
		const [row] = await db.select().from(media).where(eq(media.hash, hash)).limit(1);
		if (!row) return reply.code(404).send({ error: "not_found" });
		const imageHash = row.kind === "video" ? row.posterHash : row.kind === "image" ? row.hash : null;
		if (!imageHash) return reply.code(404).send({ error: "no_preview" });
		const variant = row.purpose === "profile" ? "thumb-320.jpg" : "preview.jpg";
		return sendFile(reply, objectKey(row.purpose, imageHash, variant), "image/jpeg");
	});

	/** The full file (image master, video, audio) for review. */
	app.get("/admin/api/media/:hash/file", { preHandler: app.requireAdmin }, async (req, reply) => {
		const { hash } = hashParam.parse(req.params);
		const [row] = await db.select().from(media).where(eq(media.hash, hash)).limit(1);
		if (!row) return reply.code(404).send({ error: "not_found" });
		if (row.kind === "image") return sendFile(reply, objectKey(row.purpose, hash, "master.jpg"), "image/jpeg");
		const transcoded = row.kind === "video" && row.purpose !== "chat" && row.state === "ready";
		return streamWithRange(req, reply, objectKey(row.purpose, hash, transcoded ? "video.mp4" : "original"), transcoded ? "video/mp4" : row.mime, "private, no-store");
	});

	/**
	 * Moderation delete: takes the file out of the profile, albums and drawer,
	 * then removes it from storage and revokes its URLs (chats showing it get
	 * an unavailable image).
	 */
	app.delete("/admin/api/media/:hash", { preHandler: app.requireAdmin }, async (req) => {
		const { hash } = hashParam.parse(req.params);
		const [row] = await db.select().from(media).where(eq(media.hash, hash)).limit(1);
		if (!row) throw new ApiError(404, { error: "not_found" });
		const owner = row.ownerId;
		const wasInProfile = (await db.delete(profileMedia).where(eq(profileMedia.mediaHash, hash)).returning({ u: profileMedia.userId })).length > 0;
		if (wasInProfile) {
			const [first] = await db.select({ h: profileMedia.mediaHash }).from(profileMedia).where(eq(profileMedia.userId, owner)).orderBy(asc(profileMedia.position)).limit(1);
			await db.update(profiles).set({ primaryMediaHash: first?.h ?? null, updatedAt: new Date() }).where(eq(profiles.userId, owner));
			await invalidateProfileCard(owner);
		}
		await db.delete(albumContent).where(eq(albumContent.mediaHash, hash));
		await db.delete(chatDrawer).where(eq(chatDrawer.mediaHash, hash));
		await purgeMedia([hash]);
		await audit(req.admin, "media.delete", `media:${hash}`, { ownerId: String(owner), purpose: row.purpose, kind: row.kind }, null);
		return { ok: true };
	});

	/** Who stores the most (live media only). */
	app.get("/admin/api/media/storage", { preHandler: app.requireAdmin }, async () => {
		const top = await dbRead
			.select({ ownerId: media.ownerId, name: profiles.displayName, bytes: sql<string>`sum(${media.bytes})`, files: sql<number>`count(*)::int` })
			.from(media)
			.leftJoin(profiles, eq(profiles.userId, media.ownerId))
			.where(isNull(media.deletedAt))
			.groupBy(media.ownerId, profiles.displayName)
			.orderBy(desc(sql`sum(${media.bytes})`))
			.limit(20);
		const [total] = await dbRead.select({ bytes: sql<string>`coalesce(sum(${media.bytes}), 0)`, files: sql<number>`count(*)::int` }).from(media).where(isNull(media.deletedAt));
		return { total: { bytes: Number(total?.bytes ?? 0), files: total?.files ?? 0 }, top: top.map((t) => ({ ...t, ownerId: String(t.ownerId), bytes: Number(t.bytes) })) };
	});
}
