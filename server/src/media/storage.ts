import { z } from "zod";

/**
 * S3-compatible object storage (SeaweedFS locally; R2/B2/AWS in production)
 * via Bun's built-in S3 client. The bucket is private: everything is served
 * through our own media routes (signed / viewer-bound where private).
 */
const env = z
	.object({
		S3_ENDPOINT: z.string().url().default("http://localhost:8333"),
		S3_REGION: z.string().default("us-east-1"),
		S3_BUCKET: z.string().default("freegrind-media"),
		S3_ACCESS_KEY_ID: z.string().default("freegrind"),
		S3_SECRET_ACCESS_KEY: z.string().default("freegrind-secret"),
	})
	.parse(process.env);

export const s3 = new Bun.S3Client({
	endpoint: env.S3_ENDPOINT,
	region: env.S3_REGION,
	bucket: env.S3_BUCKET,
	accessKeyId: env.S3_ACCESS_KEY_ID,
	secretAccessKey: env.S3_SECRET_ACCESS_KEY,
});

/** Key layout: <purpose>/<hash[0..2]>/<hash>/<variant> — spreads keys, groups variants. */
export function objectKey(purpose: string, hash: string, variant: string): string {
	return `${purpose}/${hash.slice(0, 2)}/${hash}/${variant}`;
}

export async function putObject(key: string, data: Uint8Array | Blob, contentType: string): Promise<void> {
	await s3.write(key, data, { type: contentType });
}

export function objectFile(key: string) {
	return s3.file(key);
}

export async function deletePrefix(prefix: string): Promise<void> {
	let token: string | undefined;
	do {
		const page = await s3.list({ prefix, continuationToken: token, maxKeys: 1000 });
		await Promise.all((page.contents ?? []).map((o) => s3.delete(o.key)));
		token = page.isTruncated ? page.nextContinuationToken : undefined;
	} while (token);
}
