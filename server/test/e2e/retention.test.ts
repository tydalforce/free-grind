import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import sharp from "sharp";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app";
import { db } from "../../src/db/client";
import { media } from "../../src/db/schema";
import { sweepExpiringMedia } from "../../src/media/retention";
import { objectFile, objectKey } from "../../src/media/storage";
import { setServerSetting } from "../../src/modules/settings/settings";
import { clientHeaders, registerAndLogin } from "../helpers";

type Session = Awaited<ReturnType<typeof registerAndLogin>>;

let app: FastifyInstance;
beforeAll(async () => {
	app = await buildApp();
});
afterAll(async () => {
	await setServerSetting("media.retention.expiringDays", 1, { actor: "test" });
	await app.close();
});

const h = (s: Session) => clientHeaders({ deviceId: s.deviceId, token: s.sessionId });

async function jpeg(seed: number): Promise<Buffer> {
	const raw = Buffer.from(Array.from({ length: 80 * 60 * 3 }, (_, i) => (i * seed * 7919 + seed) % 256));
	return sharp(raw, { raw: { width: 80, height: 60, channels: 3 } }).jpeg({ quality: 95 }).toBuffer();
}

async function chatUpload(s: Session, seed: number) {
	const res = await app.inject({ method: "POST", url: "/v5/chat/media/upload", headers: { ...h(s), "content-type": "image/jpeg" }, payload: await jpeg(seed) });
	expect(res.statusCode).toBe(200);
	return res.json() as { mediaId: number; mediaHash: string };
}

const send = (from: Session, to: Session, type: string, body: object) =>
	app.inject({ method: "POST", url: "/v4/chat/message/send", headers: h(from), payload: { type, target: { type: "Direct", targetId: Number(to.profileId) }, body } });

async function state(hash: string) {
	const [row] = await db.select({ deletedAt: media.deletedAt, purpose: media.purpose }).from(media).where(eq(media.hash, hash));
	const fileExists = row ? await objectFile(objectKey(row.purpose, hash, "master.jpg")).exists() : false;
	return { deleted: !!row?.deletedAt, fileExists };
}

describe("media retention", () => {
	test("expiring pics are removed after retention unless kept in the drawer or used by a normal message", async () => {
		const a = await registerAndLogin(app);
		const b = await registerAndLogin(app);
		const plain = await chatUpload(a, 31); // only expiring → goes
		const inDrawer = await chatUpload(a, 37); // expiring but in drawer → stays
		const alsoNormal = await chatUpload(a, 41); // expiring + regular image → stays
		await app.inject({ method: "PUT", url: `/v4/chat/media/drawer/${inDrawer.mediaId}`, headers: h(a) });
		for (const m of [plain, inDrawer, alsoNormal]) expect((await send(a, b, "ExpiringImage", { mediaId: m.mediaId, expiring: true })).statusCode).toBe(201);
		expect((await send(a, b, "Image", { mediaId: alsoNormal.mediaId })).statusCode).toBe(201);

		// Fresh: nothing is old enough yet.
		await sweepExpiringMedia();
		expect((await state(plain.mediaHash)).deleted).toBe(false);

		await setServerSetting("media.retention.expiringDays", 0.00001, { actor: "test" }); // ~0.9 s
		await Bun.sleep(1200);
		await sweepExpiringMedia();
		expect(await state(plain.mediaHash)).toEqual({ deleted: true, fileExists: false });
		expect(await state(inDrawer.mediaHash)).toEqual({ deleted: false, fileExists: true });
		expect(await state(alsoNormal.mediaHash)).toEqual({ deleted: false, fileExists: true });
	});

	test("drawer media stays until deleted in the drawer; a file still shown in a chat survives that", async () => {
		const a = await registerAndLogin(app);
		const b = await registerAndLogin(app);
		const unused = await chatUpload(a, 43);
		const sent = await chatUpload(a, 47);
		for (const m of [unused, sent]) await app.inject({ method: "PUT", url: `/v4/chat/media/drawer/${m.mediaId}`, headers: h(a) });
		await send(a, b, "Image", { mediaId: sent.mediaId });

		for (const m of [unused, sent]) expect((await app.inject({ method: "DELETE", url: `/v4/chat/media/drawer/${m.mediaId}`, headers: h(a) })).statusCode).toBe(202);
		expect(await state(unused.mediaHash)).toEqual({ deleted: true, fileExists: false });
		expect(await state(sent.mediaHash)).toEqual({ deleted: false, fileExists: true });
	});

	test("album media goes when deleted in the album (item or whole album)", async () => {
		const a = await registerAndLogin(app);
		const albumId = (await app.inject({ method: "POST", url: "/v2/albums", headers: h(a), payload: { albumName: "x" } })).json().albumId as number;
		const upload = async (seed: number) => {
			const boundary = "----fgretention";
			const payload = Buffer.concat([
				Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="content"; filename="a.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`),
				await jpeg(seed),
				Buffer.from(`\r\n--${boundary}--\r\n`),
			]);
			const res = await app.inject({ method: "POST", url: `/v1/albums/${albumId}/content?width=80&height=60`, headers: { ...h(a), "content-type": `multipart/form-data; boundary=${boundary}` }, payload });
			return res.json().contentId as number;
		};
		const c1 = await upload(53);
		await upload(59);
		const hashes = ((await app.inject({ method: "GET", url: "/v1/albums", headers: h(a) })).json().albums[0].content as { contentId: number; contentHash: string }[]).map((c) => [c.contentId, c.contentHash] as const);
		const hash1 = hashes.find(([id]) => id === c1)![1];
		const hash2 = hashes.find(([id]) => id !== c1)![1];

		expect((await app.inject({ method: "DELETE", url: `/v1/albums/${albumId}/content/${c1}`, headers: h(a) })).statusCode).toBe(200);
		expect(await state(hash1)).toEqual({ deleted: true, fileExists: false });
		expect(await state(hash2)).toEqual({ deleted: false, fileExists: true });
		expect((await app.inject({ method: "DELETE", url: `/v1/albums/${albumId}`, headers: h(a) })).statusCode).toBe(200);
		expect(await state(hash2)).toEqual({ deleted: true, fileExists: false });
	});
});
