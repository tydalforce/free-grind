import { createHash } from "node:crypto";
import sharp from "sharp";
import { errors } from "../lib/errors";
import { objectKey, putObject } from "./storage";

/**
 * Image pipeline: decode (bomb-safe) → auto-rotate → strip all metadata
 * (EXIF/GPS) → normalized JPEG master → content hash → pre-generated
 * variants (never resized on the fly):
 *   profile/{320,480,1024,2048}  fit inside the square, one side == size
 *   thumb/{75,320,480}           square crop from thumbCoords (or centered)
 */

export const PROFILE_SIZES = [320, 480, 1024, 2048] as const;
export const THUMB_SIZES = [75, 320, 480] as const;
const MAX_INPUT_PIXELS = 60_000_000;
const MASTER_MAX_EDGE = 2048;
const ACCEPTED = new Set(["jpeg", "png", "webp", "heif", "gif", "avif"]);
/** Upstream refuses tiny files ("Bytes too few"). */
const MIN_BYTES = 1024;

/** [y2, x1, x2, y1] in source pixels (upstream RectFString order: bottom, left, right, top). */
export type ThumbCoords = [number, number, number, number];

export function parseThumbCoords(value: unknown): ThumbCoords | null {
	if (typeof value !== "string") return null;
	const parts = value.split(",").map((p) => Number(p.trim()));
	if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n) || n < 0)) return null;
	const [y2, x1, x2, y1] = parts as ThumbCoords;
	if (x2 <= x1 || y2 <= y1) return null;
	return [y2, x1, x2, y1];
}

export function isSquare(c: ThumbCoords): boolean {
	const [y2, x1, x2, y1] = c;
	return Math.abs(y2 - y1 - (x2 - x1)) <= 1;
}

export type ProcessedImage = { hash: string; width: number; height: number; bytes: number; master: Buffer };

/** Normalizes and stores an image plus all variants. Returns the content hash. */
/**
 * `hashSalt` (the owner id) makes hashes owner-scoped: two users uploading the
 * same picture get different hashes — no cross-user collisions, and identical
 * hashes can't be used to link accounts.
 */
export async function processImage(input: Buffer, opts: { purpose: string; hashSalt: string; thumbCoords?: ThumbCoords | null }): Promise<ProcessedImage> {
	if (input.length < MIN_BYTES) throw errors.badRequest("Bytes too few");
	let meta: sharp.Metadata;
	try {
		meta = await sharp(input, { limitInputPixels: MAX_INPUT_PIXELS, failOn: "error" }).metadata();
	} catch {
		throw errors.badRequest("Unsupported or corrupt image");
	}
	if (!meta.format || !ACCEPTED.has(meta.format)) throw errors.badRequest("Unsupported image format");

	// rotate() applies EXIF orientation; output carries no metadata (sharp strips by default).
	const master = await sharp(input, { limitInputPixels: MAX_INPUT_PIXELS, animated: false })
		.rotate()
		.resize({ width: MASTER_MAX_EDGE, height: MASTER_MAX_EDGE, fit: "inside", withoutEnlargement: true })
		.jpeg({ quality: 88, mozjpeg: true })
		.toBuffer({ resolveWithObject: true });

	const hash = createHash("sha1").update(`${opts.hashSalt}:`).update(master.data).digest("hex");
	const { width, height } = master.info;

	// Thumb coords refer to the uploaded (oriented) image; scale them to the master.
	const orientedWidth = meta.orientation && meta.orientation >= 5 ? (meta.height ?? width) : (meta.width ?? width);
	const scale = width / orientedWidth;
	const crop = squareCrop(opts.thumbCoords ?? null, width, height, scale);

	const writes: Promise<void>[] = [putObject(objectKey(opts.purpose, hash, "master.jpg"), master.data, "image/jpeg")];
	for (const size of PROFILE_SIZES) {
		if (size === 2048 && Math.max(width, height) < 2048) continue;
		writes.push(
			sharp(master.data)
				.resize({ width: size, height: size, fit: "inside", withoutEnlargement: true })
				.jpeg({ quality: 85, mozjpeg: true })
				.toBuffer()
				.then((buf) => putObject(objectKey(opts.purpose, hash, `profile-${size}.jpg`), buf, "image/jpeg")),
		);
	}
	for (const size of THUMB_SIZES) {
		writes.push(
			sharp(master.data)
				.extract(crop)
				.resize({ width: size, height: size, fit: "cover" })
				.jpeg({ quality: 82, mozjpeg: true })
				.toBuffer()
				.then((buf) => putObject(objectKey(opts.purpose, hash, `thumb-${size}.jpg`), buf, "image/jpeg")),
		);
	}
	if (opts.purpose !== "profile") {
		// Private media: an unblurred preview and a blurred cover (album thumbUrl / coverUrl).
		writes.push(
			sharp(master.data)
				.resize({ width: 640, height: 640, fit: "inside", withoutEnlargement: true })
				.jpeg({ quality: 82, mozjpeg: true })
				.toBuffer()
				.then((buf) => putObject(objectKey(opts.purpose, hash, "preview.jpg"), buf, "image/jpeg")),
			sharp(master.data)
				.resize({ width: 160, height: 160, fit: "inside" })
				.blur(12)
				.jpeg({ quality: 70 })
				.toBuffer()
				.then((buf) => putObject(objectKey(opts.purpose, hash, "blur.jpg"), buf, "image/jpeg")),
		);
	}
	await Promise.all(writes);
	return { hash, width, height, bytes: master.data.length, master: master.data };
}

function squareCrop(c: ThumbCoords | null, width: number, height: number, scale: number): sharp.Region {
	if (c && isSquare(c)) {
		const [y2, x1, x2, y1] = c.map((v) => Math.round(v * scale)) as ThumbCoords;
		const left = Math.max(0, Math.min(x1, width - 1));
		const top = Math.max(0, Math.min(y1, height - 1));
		const side = Math.max(1, Math.min(x2 - x1, y2 - y1, width - left, height - top));
		return { left, top, width: side, height: side };
	}
	const side = Math.min(width, height);
	return { left: Math.floor((width - side) / 2), top: Math.floor((height - side) / 2), width: side, height: side };
}

/** Picks the stored variant for a requested `{size}` ("480x480"). */
export function variantFor(kind: "profile" | "thumb", size: string): string | null {
	const m = /^(\d{2,4})x(\d{2,4})$/.exec(size);
	if (!m || m[1] !== m[2]) return null;
	const n = Number(m[1]);
	const list: readonly number[] = kind === "profile" ? PROFILE_SIZES : THUMB_SIZES;
	if (!list.includes(n)) return null;
	return `${kind}-${n}.jpg`;
}
