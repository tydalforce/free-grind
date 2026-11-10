import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { db } from "../db/client";
import { chatDrawer, chatMediaUsage, media } from "../db/schema";
import { capValue, consume } from "../entitlements/enforce";
import { errors } from "../lib/errors";
import { MEDIA_VARIANTS, type MediaVariant, signMediaUrl, verifyMediaUrl } from "../lib/mediaUrls";
import { enforceRateLimit } from "../lib/rateLimit";
import { verifySignedUpload } from "../modules/devicekeys/signing";
import { getServerSetting } from "../modules/settings/settings";
import { payloadTooLarge, readBodyLimited } from "../media/body";
import { mediaMeta } from "../media/lookup";
import { storeUpload } from "../media/service";
import { purgeIfUnused } from "../media/retention";
import { objectFile, objectKey } from "../media/storage";
import { streamWithRange } from "../media/routes";
import { sniffKind } from "../media/video";
import { otherParticipant } from "./ids";

/** Technical ceiling for one chat upload; entitlements may set lower caps. */
const CHAT_UPLOAD_MAX_BYTES = 600 * 1024 * 1024;

async function chatTtl(): Promise<number> {
	return (await getServerSetting<number>("media.url.chatTtlSec")) ?? 900;
}

async function signOwn(ownerId: bigint, hash: string) {
	return signMediaUrl({ uploaderProfileId: String(ownerId), mediaHash: hash, ttlSeconds: await chatTtl() });
}

/** POST /v5/chat/media/upload (unsigned) and /v6 (device-key signed → takenOnGrindr). */
async function handleChatUpload(req: FastifyRequest, signedEndpoint: boolean) {
	const me = req.auth.userId;
	await enforceRateLimit(`upload:chat:${req.auth.profileId}`, 300, 3_600_000, { ip: req.ip, userId: req.auth.profileId });
	const q = z
		.object({ length: z.string().regex(/^\d{1,10}$/).optional(), looping: z.enum(["true", "false"]).optional(), takenOnGrindr: z.enum(["true", "false"]).optional() })
		.safeParse(req.query);
	if (!q.success) throw errors.badRequest("Invalid request");

	const [imageMax, videoMax] = await Promise.all([capValue(me, "chat.image.maxBytes"), capValue(me, "chat.video.maxBytes")]);
	const body = await readBodyLimited(req, Math.min(CHAT_UPLOAD_MAX_BYTES, Math.max(imageMax, videoMax)));
	const signed = await verifySignedUpload(req, body, { required: signedEndpoint });

	const declaredMime = typeof req.headers["content-type"] === "string" ? req.headers["content-type"] : null;
	const kind = sniffKind(body, declaredMime);
	if (!kind) throw errors.badRequest("Invalid request");
	if (kind === "image" && body.length > imageMax) throw payloadTooLarge();
	if (kind === "video" && body.length > videoMax) throw payloadTooLarge();
	const lengthMs = q.data.length ? Number(q.data.length) : null;
	if (kind !== "image" && lengthMs != null) {
		const maxMs = await capValue(me, kind === "video" ? "chat.video.maxDurationMs" : "chat.audio.maxDurationMs");
		if (lengthMs > maxMs) throw errors.badRequest(`length ${lengthMs} out of range for ${kind.toUpperCase()}`);
	}
	await consume(me, "chat.mediaUploads.perDay");

	const row = await storeUpload(body, {
		ownerId: me,
		purpose: "chat",
		accept: ["image", "video", "audio"],
		takenOnGrindr: signed || q.data.takenOnGrindr === "true",
		storeAsIs: true,
		declaredMime,
		durationMs: kind === "image" ? null : lengthMs,
	});
	const { url, expiresAt } = await signOwn(me, row.hash);
	return { mediaId: row.mediaId, mediaHash: row.hash, url, expiresAt };
}

type DrawerItem = { id: number; url: string; contentType: string; createdTs: number; used: boolean; takenOnGrindr: boolean };

async function listDrawer(me: bigint, conversationId: string | null): Promise<DrawerItem[]> {
	const rows = await db
		.select({ hash: media.hash, mediaId: media.mediaId, mime: media.mime, kind: media.kind, takenOnGrindr: media.takenOnGrindr, addedAt: chatDrawer.createdAt })
		.from(chatDrawer)
		.innerJoin(media, eq(media.hash, chatDrawer.mediaHash))
		.where(and(eq(chatDrawer.ownerId, me), isNull(media.deletedAt)))
		.orderBy(desc(chatDrawer.createdAt))
		.limit(500);
	let used = new Set<string>();
	if (conversationId && rows.length) {
		const u = await db
			.select({ hash: chatMediaUsage.mediaHash })
			.from(chatMediaUsage)
			.where(and(eq(chatMediaUsage.ownerId, me), eq(chatMediaUsage.conversationId, conversationId), inArray(chatMediaUsage.mediaHash, rows.map((r) => r.hash))));
		used = new Set(u.map((r) => r.hash));
	}
	return Promise.all(
		rows.map(async (r) => ({
			id: r.mediaId,
			url: (await signOwn(me, r.hash)).url,
			contentType: r.kind === "image" ? "image/jpeg" : r.mime,
			createdTs: r.addedAt.getTime(),
			used: used.has(r.hash),
			takenOnGrindr: r.takenOnGrindr,
		})),
	);
}

/** Path segment used instead of the author id for Right Now media. */
export const RIGHT_NOW_UPLOADER = "0";

const PRIVATE_PURPOSES = new Set(["chat", "album", "rightnow"]);

/**
 * GET /{uploaderProfileId}/{mediaHash}[/{thumb|blur}]?Expires&Signature&Key-Pair-Id —
 * signed private media (upstream CloudFront shape): the URL alone grants
 * access until it expires.
 */
async function serveSignedMedia(req: FastifyRequest, reply: FastifyReply) {
	const { uploader, hash, variant } = req.params as { uploader: string; hash: string; variant?: string };
	if (!/^\d{1,19}$/.test(uploader) || !/^[a-f0-9]{40,64}$/.test(hash)) return reply.code(404).send(errors.notFound().body);
	if (variant !== undefined && !(MEDIA_VARIANTS as readonly string[]).includes(variant)) return reply.code(404).send(errors.notFound().body);
	const q = req.query as Record<string, string | undefined>;
	const check = await verifyMediaUrl({ uploaderProfileId: uploader, mediaHash: hash, variant: variant as MediaVariant | undefined, expires: q.Expires, signature: q.Signature, keyPairId: q["Key-Pair-Id"] });
	if (!check.ok) return reply.code(403).header("cache-control", "no-store").send({ code: 403, message: "Forbidden" });
	const meta = await mediaMeta(hash);
	// Right Now media is signed under uploader "0": its URLs must not name the author (discreet posts).
	const ownerOk = uploader === RIGHT_NOW_UPLOADER ? meta?.purpose === "rightnow" : meta?.ownerId === uploader && meta?.purpose !== "rightnow";
	if (!meta || meta.deleted || !ownerOk || !PRIVATE_PURPOSES.has(meta.purpose) || meta.state !== "ready") return reply.code(404).send(errors.notFound().body);

	const remaining = Math.max(0, Number(q.Expires) - Math.floor(Date.now() / 1000));
	const cacheControl = `private, max-age=${remaining}`;
	reply.header("content-disposition", "inline");
	if (variant) {
		// Videos: previews come from their poster image.
		const imageHash = meta.kind === "video" ? meta.posterHash : meta.kind === "image" ? hash : null;
		if (!imageHash) return reply.code(404).send(errors.notFound().body);
		const file = objectFile(objectKey(meta.purpose, imageHash, variant === "thumb" ? "preview.jpg" : "blur.jpg"));
		if (!(await file.exists())) return reply.code(404).send(errors.notFound().body);
		reply.header("content-type", "image/jpeg").header("cache-control", cacheControl);
		return reply.send(file.stream());
	}
	if (meta.kind === "image") {
		const file = objectFile(objectKey(meta.purpose, hash, "master.jpg"));
		reply.header("content-type", "image/jpeg").header("cache-control", cacheControl);
		return reply.send(file.stream());
	}
	// Chat media is stored as uploaded; transcoded album videos live under video.mp4.
	const file = meta.kind === "video" && meta.purpose !== "chat" ? "video.mp4" : "original";
	return streamWithRange(req, reply, objectKey(meta.purpose, hash, file), meta.kind === "video" && file === "video.mp4" ? "video/mp4" : meta.mime, cacheControl);
}

export async function chatMediaRoutes(app: FastifyInstance): Promise<void> {
	app.post("/v5/chat/media/upload", { preHandler: app.authenticate, bodyLimit: CHAT_UPLOAD_MAX_BYTES }, (req) => handleChatUpload(req, false));
	app.post("/v6/chat/media/upload", { preHandler: app.authenticate, bodyLimit: CHAT_UPLOAD_MAX_BYTES }, (req) => handleChatUpload(req, true));

	app.get("/v4/chat/media/drawer", { preHandler: app.authenticate }, (req) => listDrawer(req.auth.userId, null));
	app.get("/v4/chat/media/drawer/:conversationId", { preHandler: app.authenticate }, (req) => {
		const { conversationId } = req.params as { conversationId: string };
		otherParticipant(conversationId, req.auth.userId);
		return listDrawer(req.auth.userId, conversationId);
	});
	app.put("/v4/chat/media/drawer/:mediaId", { preHandler: app.authenticate }, async (req) => {
		const mediaId = Number((req.params as { mediaId: string }).mediaId);
		if (!Number.isSafeInteger(mediaId)) throw errors.badRequest("Invalid request");
		const [row] = await db
			.select({ hash: media.hash })
			.from(media)
			.where(and(eq(media.mediaId, mediaId), eq(media.ownerId, req.auth.userId), eq(media.purpose, "chat"), isNull(media.deletedAt)))
			.limit(1);
		if (!row) throw errors.notFound();
		await db.insert(chatDrawer).values({ ownerId: req.auth.userId, mediaHash: row.hash }).onConflictDoNothing();
		return {};
	});
	app.delete("/v4/chat/media/drawer/:mediaId", { preHandler: app.authenticate }, async (req, reply) => {
		const mediaId = Number((req.params as { mediaId: string }).mediaId);
		if (Number.isSafeInteger(mediaId)) {
			const removed = (await db.execute(sql`
				DELETE FROM chat_drawer d USING media m
				WHERE d.owner_id = ${req.auth.userId} AND d.media_hash = m.hash AND m.media_id = ${mediaId}
				RETURNING d.media_hash AS hash`)) as unknown as { hash: string }[];
			// Deleted in the drawer → the file goes too, unless a sent message still shows it.
			await purgeIfUnused(removed.map((r) => r.hash));
		}
		return reply.code(202).send();
	});

	// Private media host route (cloudfront.net equivalent). Static API routes win
	// over this parametric one in the router, so it only catches /<digits>/<hash>.
	app.get("/:uploader/:hash", { config: { clientHeaders: "none" } }, serveSignedMedia);
	app.get("/:uploader/:hash/:variant", { config: { clientHeaders: "none" } }, serveSignedMedia);
}
