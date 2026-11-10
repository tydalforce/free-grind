import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { config } from "../config";
import { db } from "../db/client";
import { media, profileMedia, profiles } from "../db/schema";
import { capValue, consume, isFeatureEnabled, requireEnabled } from "../entitlements/enforce";
import { evaluateFlags, isOn } from "../flags/engine";
import { ApiError, coded, errors } from "../lib/errors";
import { revokeMedia } from "../lib/mediaUrls";
import { enforceRateLimit } from "../lib/rateLimit";
import { verifySignedUpload } from "../modules/devicekeys/signing";
import { invalidateProfileCard } from "../profiles/cards";
import { readBodyLimited } from "./body";
import { parseThumbCoords, variantFor } from "./images";
import { forgetMediaMeta, mediaMeta } from "./lookup";
import { MEDIA_STATE_CODE, MEDIA_TYPE_CODE, storeUpload } from "./service";
import { deletePrefix, objectFile, objectKey } from "./storage";
import { sniffKind } from "./video";
import { mediaBase } from "../lib/publicUrls";

/** Technical ceiling for a single profile image upload (entitlements may lower it for videos). */
const PROFILE_IMAGE_MAX_BYTES = 25 * 1024 * 1024;

export function publicImageUrl(kind: "profile" | "thumb", size: string, hash: string): string {
	return `${mediaBase()}/images/${kind}/${size}/${hash}`;
}

async function profileVideosAllowed(req: FastifyRequest): Promise<boolean> {
	if (!(await isFeatureEnabled(req.auth.userId, "profile.videos.enabled"))) return false;
	// The flag gates the feature server-wide / per rollout; the JWT carries it too.
	if (req.auth.featureFlags.has("profile_videos")) return true;
	const flags = await evaluateFlags({ userId: req.auth.profileId, roles: req.auth.claims.roles.length ? req.auth.claims.roles : ["free"], geohash: null, platform: req.client.ua.platform, appVersion: req.client.ua.appVersion, accountCreatedAt: null });
	return flags.some((f) => f.key === "profile_videos" && isOn(f.value));
}

/** POST /v4|v5/media/upload (POST /v3/me/profile/images no longer exists upstream). */
async function handleProfileUpload(req: FastifyRequest, opts: { signed: boolean }) {
	await enforceRateLimit(`upload:profile:${req.auth.profileId}`, 60, 3_600_000, { ip: req.ip, userId: req.auth.profileId });
	const query = z.object({ thumbCoords: z.string().optional(), takenOnGrindr: z.enum(["true", "false"]).optional() }).parse(req.query);

	const allowVideo = await profileVideosAllowed(req);
	const videoMax = allowVideo ? await capValue(req.auth.userId, "profile.video.maxBytes") : 0;
	const body = await readBodyLimited(req, Math.max(PROFILE_IMAGE_MAX_BYTES, Number.isFinite(videoMax) ? videoMax : 500 * 1024 * 1024));
	const signed = await verifySignedUpload(req, body, { required: opts.signed });

	const kind = sniffKind(body);
	if (kind === "video") {
		if (!allowVideo) throw errors.tieredFeature("profile.videos.enabled");
		if (body.length > videoMax) throw new ApiError(413, { code: 413, message: "Payload too large" });
	} else if (body.length > PROFILE_IMAGE_MAX_BYTES) {
		throw new ApiError(413, { code: 413, message: "Payload too large" });
	}

	try {
		await consume(req.auth.userId, "profile.images.uploadsPerDay");
	} catch {
		// Upstream answer for the daily profile-photo limit.
		throw coded(403, 51, "ERR_EXCEED_PROFILE_IMAGE_DAILY_LIMIT");
	}

	const maxDurationSec = kind === "video" ? (await capValue(req.auth.userId, "profile.video.maxDurationMs")) / 1000 : Number.POSITIVE_INFINITY;
	const row = await storeUpload(body, {
		ownerId: req.auth.userId,
		purpose: "profile",
		accept: allowVideo ? ["image", "video"] : ["image"],
		takenOnGrindr: signed || query.takenOnGrindr === "true",
		thumbCoords: parseThumbCoords(query.thumbCoords),
		video: { maxDurationMs: Number.isFinite(maxDurationSec) ? maxDurationSec * 1000 : null, muteAudio: true },
	});

	const state = row.state === "ready" ? "1" : "0";
	const imageSizes = [
		...["320x320", "480x480", "1024x1024"].map((s) => ({ mediaHash: row.hash, fullUrl: publicImageUrl("profile", s, row.hash), state, thumbnail: false, size: Number(s.split("x")[0]) })),
		...["75x75", "320x320", "480x480"].map((s) => ({ mediaHash: row.hash, fullUrl: publicImageUrl("thumb", s, row.hash), state, thumbnail: true, size: Number(s.split("x")[0]) })),
	];
	const extension = row.kind === "video" ? { type: MEDIA_TYPE_CODE.video, videoUrl: `${mediaBase()}/videos/profile/${row.hash}.mp4`, processing: row.state === "processing" } : {};
	return !opts.signed
		? { hash: row.hash, mediaHash: row.hash, imageSizes, mediaId: row.mediaId, ...extension }
		: { hash: row.hash, imageSizes, ...extension };
}

async function loadProfileMedia(userId: bigint) {
	return db
		.select({ hash: media.hash, kind: media.kind, state: media.state, takenOnGrindr: media.takenOnGrindr, createdAt: media.createdAt, posterHash: media.posterHash, durationMs: media.durationMs, position: profileMedia.position })
		.from(profileMedia)
		.innerJoin(media, eq(media.hash, profileMedia.mediaHash))
		.where(and(eq(profileMedia.userId, userId), isNull(media.deletedAt)))
		.orderBy(asc(profileMedia.position));
}

export async function mediaRoutes(app: FastifyInstance): Promise<void> {
	app.post("/v4/media/upload", { preHandler: app.authenticate, bodyLimit: 600 * 1024 * 1024 }, (req) => handleProfileUpload(req, { signed: false }));
	app.post("/v5/media/upload", { preHandler: app.authenticate, bodyLimit: 600 * 1024 * 1024 }, (req) => handleProfileUpload(req, { signed: true }));

	app.get("/v3.1/me/profile/images", { preHandler: app.authenticate }, async (req) => {
		const { selected } = z.object({ selected: z.enum(["true", "false"]).optional() }).parse(req.query);
		const onProfile = await loadProfileMedia(req.auth.userId);
		let rows = onProfile.map((m) => ({ ...m, onProfile: true }));
		if (selected !== "true") {
			const others = await db
				.select({ hash: media.hash, kind: media.kind, state: media.state, takenOnGrindr: media.takenOnGrindr, createdAt: media.createdAt, posterHash: media.posterHash, durationMs: media.durationMs })
				.from(media)
				.where(and(eq(media.ownerId, req.auth.userId), eq(media.purpose, "profile"), isNull(media.deletedAt), sql`${media.kind} <> 'audio'`, sql`${media.hash} NOT IN (SELECT media_hash FROM profile_media WHERE user_id = ${req.auth.userId})`, sql`${media.hash} NOT IN (SELECT poster_hash FROM media WHERE owner_id = ${req.auth.userId} AND poster_hash IS NOT NULL)`))
				.orderBy(sql`${media.createdAt} DESC`)
				.limit(100);
			rows = [...rows, ...others.map((m) => ({ ...m, position: -1, onProfile: false }))];
		}
		return {
			medias: rows.map((m) => ({
				mediaHash: m.hash,
				type: MEDIA_TYPE_CODE[m.kind],
				state: MEDIA_STATE_CODE[m.state],
				takenOnGrindr: m.takenOnGrindr,
				createdAt: m.createdAt.getTime(),
				...(m.kind === "video" ? { videoUrl: `${mediaBase()}/videos/profile/${m.hash}.mp4`, posterHash: m.posterHash, durationMs: m.durationMs } : {}),
			})),
		};
	});

	/** Sets primary + ordered secondary media (videos allowed as our extension). */
	app.put("/v3/me/profile/images", { preHandler: app.authenticate }, async (req) => {
		const body = z
			.object({ primaryImageHash: z.string().nullable(), secondaryImageHashes: z.array(z.string()).nullable() })
			.safeParse(req.body);
		if (!body.success) throw errors.badRequest();
		const { primaryImageHash, secondaryImageHashes } = body.data;
		if (primaryImageHash && secondaryImageHashes === null) throw errors.badRequest("secondaryImageHashes must be an array");
		// Upstream drops a secondary equal to the primary; repeated ones are kept as sent — we de-duplicate.
		const ordered = [...new Set([primaryImageHash, ...(secondaryImageHashes ?? [])].filter((h): h is string => !!h))];

		const max = await capValue(req.auth.userId, "profile.images.max");
		if (ordered.length > max) throw errors.entitlementLimit("profile.images.max");

		const rows = ordered.length
			? await db.select().from(media).where(and(inArray(media.hash, ordered), eq(media.ownerId, req.auth.userId), isNull(media.deletedAt)))
			: [];
		const byHash = new Map(rows.map((r) => [r.hash, r]));
		const accepted = ordered.filter((h) => {
			const r = byHash.get(h);
			return r && r.purpose === "profile" && r.kind !== "audio" && r.state !== "failed";
		});
		const videos = accepted.filter((h) => byHash.get(h)!.kind === "video").length;
		if (videos > 0) {
			await requireEnabled(req.auth.userId, "profile.videos.enabled");
			if (videos > (await capValue(req.auth.userId, "profile.videos.max"))) throw errors.entitlementLimit("profile.videos.max");
		}
		await db.transaction(async (tx) => {
			await tx.delete(profileMedia).where(eq(profileMedia.userId, req.auth.userId));
			if (accepted.length) await tx.insert(profileMedia).values(accepted.map((h, position) => ({ userId: req.auth.userId, mediaHash: h, position })));
			await tx
				.update(profiles)
				.set({ primaryMediaHash: accepted[0] ?? null, updatedAt: new Date() })
				.where(eq(profiles.userId, req.auth.userId));
		});
		await invalidateProfileCard(req.auth.userId);
		return {};
	});

	/** Removes from the profile and deletes the media (S3 too), like upstream. */
	app.delete("/v3/me/profile/images", { preHandler: app.authenticate }, async (req) => {
		const body = z.object({ media_hashes: z.array(z.string()).max(50) }).safeParse(req.body);
		if (!body.success) throw errors.badRequest();
		const rows = await db
			.update(media)
			.set({ state: "deleted", deletedAt: new Date() })
			.where(and(inArray(media.hash, body.data.media_hashes.length ? body.data.media_hashes : ["-"]), eq(media.ownerId, req.auth.userId), eq(media.purpose, "profile")))
			.returning({ hash: media.hash, posterHash: media.posterHash });
		await db.delete(profileMedia).where(and(eq(profileMedia.userId, req.auth.userId), inArray(profileMedia.mediaHash, rows.length ? rows.map((r) => r.hash) : ["-"])));
		const [first] = await db.select({ h: profileMedia.mediaHash }).from(profileMedia).where(eq(profileMedia.userId, req.auth.userId)).orderBy(asc(profileMedia.position)).limit(1);
		await db.update(profiles).set({ primaryMediaHash: first?.h ?? null }).where(eq(profiles.userId, req.auth.userId));
		for (const r of rows) {
			await forgetMediaMeta(r.hash);
			await revokeMedia(r.hash);
			void deletePrefix(objectKey("profile", r.hash, "")).catch(() => undefined);
			if (r.posterHash) void deletePrefix(objectKey("profile", r.posterHash, "")).catch(() => undefined);
		}
		await invalidateProfileCard(req.auth.userId);
		return {};
	});

	// --- Public CDN (cdns.grindr.com equivalent) -----------------------------------

	const servePublicImage = async (req: FastifyRequest, reply: FastifyReply, kind: "profile" | "thumb") => {
		const { size, hash } = req.params as { size: string; hash: string };
		const variant = variantFor(kind, size);
		const meta = await mediaMeta(hash);
		// Public by hash like upstream's CDN: profile media, and Right Now photos
		// (the RightNowRequest chat message carries only their hash). Chat and
		// album media stay signed.
		if (!variant || !meta || meta.deleted || (meta.purpose !== "profile" && meta.purpose !== "rightnow")) return reply.code(404).send();
		if (meta.purpose === "rightnow" && meta.kind !== "image") return reply.code(404).send();
		const imageHash = meta.kind === "video" ? meta.posterHash : meta.hash;
		if (!imageHash) return reply.code(404).send();
		let file = objectFile(objectKey(meta.purpose, imageHash, variant));
		if (variant === "profile-2048.jpg" && !(await file.exists())) file = objectFile(objectKey(meta.purpose, imageHash, "profile-1024.jpg"));
		reply
			.header("content-type", "image/jpeg")
			.header("cache-control", "public, max-age=31536000, immutable")
			.header("x-content-type-options", "nosniff");
		return reply.send(file.stream());
	};

	app.get("/images/profile/:size/:hash", { config: { clientHeaders: "none" } }, (req, reply) => servePublicImage(req, reply, "profile"));
	app.get("/images/thumb/:size/:hash", { config: { clientHeaders: "none" } }, (req, reply) => servePublicImage(req, reply, "thumb"));

	/** Profile videos (our extension): public like profile photos, with Range support. */
	app.get("/videos/profile/:file", { config: { clientHeaders: "none" } }, async (req, reply) => {
		const m = /^([a-f0-9]{40})\.mp4$/.exec((req.params as { file: string }).file);
		const meta = m ? await mediaMeta(m[1]!) : null;
		if (!meta || meta.deleted || meta.kind !== "video" || meta.purpose !== "profile" || meta.state !== "ready") return reply.code(404).send();
		return streamWithRange(req, reply, objectKey("profile", meta.hash, "video.mp4"), "video/mp4", "public, max-age=31536000, immutable");
	});

}

/** Streams an S3 object honoring a single `Range: bytes=a-b` request. */
export async function streamWithRange(req: FastifyRequest, reply: FastifyReply, key: string, contentType: string, cacheControl: string) {
	const file = objectFile(key);
	const stat = await file.stat().catch(() => null);
	if (!stat) return reply.code(404).send();
	const size = stat.size;
	reply.header("accept-ranges", "bytes").header("content-type", contentType).header("cache-control", cacheControl).header("x-content-type-options", "nosniff");
	const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ""));
	if (!range) {
		reply.header("content-length", String(size));
		return reply.send(file.stream());
	}
	let start = range[1] ? Number(range[1]) : size - Number(range[2]);
	let end = range[1] && range[2] ? Number(range[2]) : size - 1;
	if (!range[1]) end = size - 1;
	start = Math.max(0, start);
	end = Math.min(size - 1, end);
	if (start > end) return reply.code(416).header("content-range", `bytes */${size}`).send();
	reply.code(206).header("content-range", `bytes ${start}-${end}/${size}`).header("content-length", String(end - start + 1));
	return reply.send(file.slice(start, end + 1).stream());
}
