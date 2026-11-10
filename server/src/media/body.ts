import type { FastifyRequest } from "fastify";
import { ApiError } from "../lib/errors";

/** 413 the way the client's upload code expects it (src-tauri/src/upload/video.rs). */
export const payloadTooLarge = () => new ApiError(413, { code: 413, message: "Payload too large" });

/**
 * Reads a raw upload body, refusing early via Content-Length and aborting
 * mid-stream once `maxBytes` is exceeded, so oversized files never reach S3.
 */
export async function readBodyLimited(req: FastifyRequest, maxBytes: number): Promise<Buffer> {
	const declared = Number(req.headers["content-length"] ?? Number.NaN);
	if (Number.isFinite(declared) && declared > maxBytes) throw payloadTooLarge();
	const body = req.body as NodeJS.ReadableStream | Buffer | undefined;
	if (!body) return Buffer.alloc(0);
	if (Buffer.isBuffer(body)) {
		if (body.length > maxBytes) throw payloadTooLarge();
		return body;
	}
	const chunks: Buffer[] = [];
	let total = 0;
	for await (const chunk of body) {
		const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
		total += buf.length;
		if (total > maxBytes) {
			(body as NodeJS.ReadableStream & { destroy?: () => void }).destroy?.();
			throw payloadTooLarge();
		}
		chunks.push(buf);
	}
	return Buffer.concat(chunks, total);
}
