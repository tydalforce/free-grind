import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import http from "node:http";
import { randomBytes } from "node:crypto";
import sharp from "sharp";
import WebSocket from "ws";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app";
import { invalidate } from "../../src/cache/local";
import { db } from "../../src/db/client";
import { blocks, entitlementUserOverrides } from "../../src/db/schema";
import { invalidateRelations } from "../../src/profiles/relations";
import { sql } from "drizzle-orm";
import { clientHeaders, registerAndLogin } from "../helpers";

type Session = Awaited<ReturnType<typeof registerAndLogin>>;
type Msg = Record<string, any>;

let app: FastifyInstance;
let base = "";

beforeAll(async () => {
	app = await buildApp();
	await app.listen({ port: 0, host: "127.0.0.1" });
	const addr = app.server.address();
	base = typeof addr === "object" && addr ? `127.0.0.1:${addr.port}` : "";
});
afterAll(async () => {
	// See main.ts: with WebSockets, Bun's server.close() never resolves.
	await Promise.race([app.close(), Bun.sleep(1500)]);
});

const h = (s: Session) => clientHeaders({ deviceId: s.deviceId, token: s.sessionId });
const cid = (a: Session, b: Session) => {
	const [x, y] = [BigInt(a.profileId), BigInt(b.profileId)];
	return x < y ? `${x}:${y}` : `${y}:${x}`;
};

/** A test socket that records every frame and can wait for one matching a predicate. */
class Client {
	frames: Msg[] = [];
	closeCode: number | null = null;
	private waiters: { pred: (m: Msg) => boolean; resolve: (m: Msg) => void }[] = [];
	constructor(readonly ws: WebSocket) {
		ws.on("message", (data) => {
			const m = JSON.parse(String(data)) as Msg;
			this.frames.push(m);
			this.waiters = this.waiters.filter((w) => (w.pred(m) ? (w.resolve(m), false) : true));
		});
		ws.on("close", (code) => {
			this.closeCode = code;
		});
	}
	static async open(s: Session): Promise<Client> {
		const ws = new WebSocket(`ws://${base}/v1/ws`, { headers: h(s) });
		const c = new Client(ws);
		await c.next((m) => m.type === "ws.connection.established");
		return c;
	}
	next(pred: (m: Msg) => boolean, timeoutMs = 3000): Promise<Msg> {
		const seen = this.frames.find(pred);
		if (seen) {
			this.frames.splice(this.frames.indexOf(seen), 1);
			return Promise.resolve(seen);
		}
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("timed out waiting for frame")), timeoutMs);
			this.waiters.push({
				pred,
				resolve: (m) => {
					clearTimeout(timer);
					this.frames.splice(this.frames.indexOf(m), 1);
					resolve(m);
				},
			});
		});
	}
	command(s: Session, type: string, payload: unknown, ref = crypto.randomUUID()) {
		this.ws.send(JSON.stringify({ type, ref, token: s.sessionId, payload }));
		return this.next((m) => m.type === `${type}.response` && m.ref === ref);
	}
	close() {
		this.ws.close();
	}
}

async function sendText(from: Session, to: Session, text: string) {
	const res = await app.inject({ method: "POST", url: "/v4/chat/message/send", headers: h(from), payload: { type: "Text", target: { type: "Direct", targetId: Number(to.profileId) }, body: { text } } });
	expect(res.statusCode).toBe(201);
	return res.json() as Msg;
}

async function page(viewer: Session, other: Session, qs = "") {
	const res = await app.inject({ method: "GET", url: `/v5/chat/conversation/${cid(viewer, other)}/message${qs}`, headers: h(viewer) });
	return res;
}

async function inbox(viewer: Session, filters: Record<string, unknown> = {}) {
	const res = await app.inject({ method: "POST", url: "/v4/inbox?page=1", headers: h(viewer), payload: filters });
	expect(res.statusCode).toBe(200);
	return res.json() as { entries: { type: string; data: Msg }[]; nextPage: number | null };
}

async function jpeg(): Promise<Buffer> {
	// Noise so the JPEG is above upstream's minimum size.
	const raw = Buffer.from(Array.from({ length: 64 * 48 * 3 }, () => Math.floor(Math.random() * 256)));
	return sharp(raw, { raw: { width: 64, height: 48, channels: 3 } }).jpeg({ quality: 95 }).toBuffer();
}

async function override(s: Session, key: string, value: unknown) {
	await db.insert(entitlementUserOverrides).values({ userId: BigInt(s.profileId), key, value }).onConflictDoUpdate({ target: [entitlementUserOverrides.userId, entitlementUserOverrides.key], set: { value } });
	await invalidate("entitlement-user", s.profileId);
}

describe("chat over REST + WebSocket", () => {
	test("inbox: Right Now status and filter; incognito hides online state", async () => {
		const a = await registerAndLogin(app);
		const host = await registerAndLogin(app);
		const plain = await registerAndLogin(app);
		const discreet = await registerAndLogin(app);
		for (const s of [host, plain, discreet]) await sendText(s, a, "hi");
		await db.execute(sql`INSERT INTO rightnow_posts (author_id, status, hosting, anchor, is_discreet, expiration)
			VALUES (${BigInt(host.profileId)}, 'ACTIVE', true, ST_SetSRID(ST_MakePoint(0, 0), 4326)::geography, 'FALSE', now() + interval '1 hour'),
			       (${BigInt(discreet.profileId)}, 'ACTIVE', false, ST_SetSRID(ST_MakePoint(0, 0), 4326)::geography, 'TRUE', now() + interval '1 hour')`);

		const all = (await inbox(a)).entries;
		const of = (s: Session) => all.find((e) => e.data.participants[0].profileId === Number(s.profileId))!.data as unknown as Record<string, unknown>;
		expect(of(host).rightNow).toBe("HOSTING");
		expect(of(plain).rightNow).toBe("NOT_ACTIVE");
		expect(of(discreet).rightNow).toBe("NOT_ACTIVE");
		expect((await inbox(a, { rightNowOnly: true })).entries.map((e) => e.data.participants[0].profileId)).toEqual([Number(host.profileId)]);

		// plain goes incognito: no online state in the inbox, not in "online now".
		await db.execute(sql`UPDATE profiles SET incognito = true, online_until = now() + interval '10 minutes' WHERE user_id = ${BigInt(plain.profileId)}`);
		const after = (await inbox(a)).entries.find((e) => e.data.participants[0].profileId === Number(plain.profileId))!.data;
		expect(after.participants[0]).toMatchObject({ onlineUntil: null, lastOnline: null });
		expect((await inbox(a, { onlineNowOnly: true })).entries.map((e) => e.data.participants[0].profileId)).not.toContain(Number(plain.profileId));
	});

	test("send, receive live, inbox, read receipts, typing, reactions, replies over WS", async () => {
		const a = await registerAndLogin(app);
		const b = await registerAndLogin(app);
		const wa = await Client.open(a);
		const wb = await Client.open(b);

		const sent = await sendText(a, b, "Hallo B");
		expect(sent).toMatchObject({ conversationId: cid(a, b), senderId: Number(a.profileId), type: "Text", chat1Type: "text", unsent: false, body: { text: "Hallo B" }, dynamic: false });
		expect(sent.messageId).toMatch(/^\d+:[0-9a-f-]{36}$/);
		expect(sent.timestamp).toBe(Number(sent.messageId.split(":")[0]));

		const live = await wb.next((m) => m.type === "chat.v1.message_sent");
		expect(live.ref).toBeNull();
		expect(live.notificationId).toMatch(/[0-9a-f-]{36}/);
		expect(live.payload.messageId).toBe(sent.messageId);
		await wa.next((m) => m.type === "chat.v1.message_sent" && m.payload.messageId === sent.messageId);

		const ib = await inbox(b);
		expect(ib.entries).toHaveLength(1);
		expect(ib.entries[0]!.type).toBe("full_conversation_v1");
		expect(ib.entries[0]!.data).toMatchObject({ conversationId: cid(a, b), unreadCount: 1, pinned: false, muted: false });
		expect(ib.entries[0]!.data.participants[0].profileId).toBe(Number(a.profileId));
		expect(ib.entries[0]!.data.preview).toMatchObject({ conversationId: { value: cid(a, b) }, messageId: sent.messageId, type: "Text", text: "Hallo B", senderId: Number(a.profileId) });

		// Read: unread resets, the sender gets the receipt, the reader's other devices too.
		const read = await app.inject({ method: "POST", url: `/v4/chat/conversation/${cid(a, b)}/read/${sent.messageId}`, headers: h(b) });
		expect(read.statusCode).toBe(200);
		const receipt = await wa.next((m) => m.type === "chat.v1.conversation_read");
		expect(receipt.payload).toEqual({ conversationId: cid(a, b), profileId: b.profileId, timestamp: sent.timestamp });
		await wb.next((m) => m.type === "chat.v1.conversation_read");
		expect((await inbox(b)).entries[0]!.data.unreadCount).toBe(0);
		expect((await page(a, b)).json().lastReadTimestamp).toBe(sent.timestamp);
		// Invalid message id format → 400 like upstream.
		expect((await app.inject({ method: "POST", url: `/v4/chat/conversation/${cid(a, b)}/read/nope`, headers: h(b) })).statusCode).toBe(400);

		// Typing reaches the other side only.
		expect((await app.inject({ method: "POST", url: "/v4/chatstatus/typing", headers: h(b), payload: { conversationId: cid(a, b), status: "Typing" } })).statusCode).toBe(200);
		const typing = await wa.next((m) => m.type === "chat.v1.typing_status");
		expect(typing.payload).toEqual({ conversationId: cid(a, b), profileId: b.profileId, status: "Typing" });

		// Reply via the WS command (HTTP rejects replyToMessageId like upstream).
		const httpReply = await app.inject({ method: "POST", url: "/v4/chat/message/send", headers: h(b), payload: { type: "Text", target: { type: "Direct", targetId: Number(a.profileId) }, body: { text: "x" }, replyToMessageId: sent.messageId } });
		expect(httpReply.statusCode).toBe(400);
		const res = await wb.command(b, "chat.v1.message.send", { type: "Text", target: { type: "Direct", targetId: Number(a.profileId) }, body: { text: "Antwort" }, replyToMessageId: sent.messageId });
		expect(res.status).toBe(201);
		expect(res.payload.replyToMessage.messageId).toBe(sent.messageId);
		expect(res.payload.body).toEqual({ text: "Antwort" });
		const liveReply = await wa.next((m) => m.type === "chat.v1.message_sent" && m.payload.messageId === res.payload.messageId);
		expect(liveReply.payload.replyToMessage.body.text).toBe("Hallo B");

		// Reaction → message_sent with the reaction for both.
		expect((await app.inject({ method: "POST", url: "/v4/chat/message/reaction", headers: h(b), payload: { conversationId: cid(a, b), messageId: sent.messageId, reactionType: 1 } })).statusCode).toBe(200);
		const reacted = await wa.next((m) => m.type === "chat.v1.message_sent" && m.payload.messageId === sent.messageId);
		expect(reacted.payload.reactions).toEqual([{ profileId: Number(b.profileId), reactionType: 1 }]);

		// Unknown command → ws.error; foreign/invalid token → close 4401.
		wb.ws.send(JSON.stringify({ type: "nope", ref: "1", token: b.sessionId }));
		await wb.next((m) => m.type === "ws.error");
		wb.ws.send(JSON.stringify({ type: "chat.v1.message.send", ref: "2", token: a.sessionId, payload: {} }));
		await new Promise((r) => setTimeout(r, 300));
		expect(wb.closeCode).toBe(4401);
		wa.close();
	});

	test("WS handshake without a valid session is refused", async () => {
		const s = await registerAndLogin(app);
		// Raw upgrade request: the refusal is a plain HTTP response before any upgrade.
		const [host, port] = base.split(":");
		const status = await new Promise<number>((resolve, reject) => {
			const req = http.request({
				host,
				port: Number(port),
				path: "/v1/ws",
				headers: { ...h(s), authorization: "Grindr3 bogus", connection: "Upgrade", upgrade: "websocket", "sec-websocket-version": "13", "sec-websocket-key": randomBytes(16).toString("base64") },
			});
			req.on("response", (res) => {
				res.resume();
				resolve(res.statusCode ?? 0);
			});
			req.on("upgrade", (res, socket) => {
				socket.destroy();
				resolve(res.statusCode ?? 101);
			});
			req.on("error", reject);
			req.end();
		});
		expect(status).toBe(401);
	});

	test("message paging with pageKey, delete for me, delete conversation, unsend + entitlement", async () => {
		const a = await registerAndLogin(app);
		const b = await registerAndLogin(app);
		const sent: Msg[] = [];
		for (let i = 0; i < 5; i++) {
			sent.push(await sendText(a, b, `m${i}`));
			await new Promise((r) => setTimeout(r, 3));
		}
		const first = (await page(b, a, "?limit=3")).json();
		expect(first.messages.map((m: Msg) => m.body.text)).toEqual(["m2", "m3", "m4"]);
		const older = (await page(b, a, `?limit=3&pageKey=${encodeURIComponent(first.messages[0].messageId)}`)).json();
		expect(older.messages.map((m: Msg) => m.body.text)).toEqual(["m0", "m1"]);
		const withProfile = (await page(b, a, "?profile=true")).json();
		expect(withProfile.profile).toMatchObject({ profileId: Number(a.profileId) });
		expect(withProfile.metadata).toMatchObject({ hasSharedAlbums: false });

		// Delete for me: gone for B only; B's preview falls back to the previous message.
		expect((await app.inject({ method: "POST", url: "/v4/chat/message/delete", headers: h(b), payload: { conversationId: cid(a, b), messageId: sent[4]!.messageId } })).statusCode).toBe(200);
		expect((await page(b, a)).json().messages).toHaveLength(4);
		expect((await page(a, b)).json().messages).toHaveLength(5);
		expect((await inbox(b)).entries[0]!.data.preview.text).toBe("m3");

		// message-by-id: oldest first, hidden ones left out.
		const byId = await app.inject({ method: "POST", url: `/v4/chat/conversation/${cid(a, b)}/message-by-id`, headers: h(b), payload: { messageIds: [sent[4]!.messageId, sent[1]!.messageId, sent[0]!.messageId] } });
		expect(byId.json().messages.map((m: Msg) => m.body.text)).toEqual(["m0", "m1"]);

		// Unsend: body null, unsent true; the preview disappears like upstream.
		expect((await app.inject({ method: "POST", url: "/v4/chat/message/unsend", headers: h(a), payload: { conversationId: cid(a, b), messageId: sent[3]!.messageId } })).statusCode).toBe(200);
		const after = (await page(b, a)).json().messages as Msg[];
		expect(after.find((m) => m.messageId === sent[3]!.messageId)).toMatchObject({ unsent: true, body: null, chat1Type: "retracted" });
		expect((await inbox(b)).entries[0]!.data.preview).toBeNull();
		// Only own messages; repeated unsend is fine.
		expect((await app.inject({ method: "POST", url: "/v4/chat/message/unsend", headers: h(b), payload: { conversationId: cid(a, b), messageId: sent[2]!.messageId } })).statusCode).toBe(500);
		expect((await app.inject({ method: "POST", url: "/v4/chat/message/unsend", headers: h(a), payload: { conversationId: cid(a, b), messageId: sent[3]!.messageId } })).statusCode).toBe(200);

		await override(a, "chat.unsend", false);
		const denied = await app.inject({ method: "POST", url: "/v4/chat/message/unsend", headers: h(a), payload: { conversationId: cid(a, b), messageId: sent[2]!.messageId } });
		expect(denied.statusCode).toBe(402);
		expect(denied.json()).toMatchObject({ type: "urn:gr:err:tiered_feature", featureValue: "UnsentMessage" });

		// Delete conversation on B's side: out of B's inbox, history cleared for B only.
		expect((await app.inject({ method: "DELETE", url: `/v4/chat/conversation/${cid(a, b)}`, headers: h(b) })).statusCode).toBe(200);
		expect((await inbox(b)).entries).toHaveLength(0);
		await sendText(a, b, "neu");
		expect((await inbox(b)).entries).toHaveLength(1);
		expect((await page(b, a)).json().messages.map((m: Msg) => m.body.text)).toEqual(["neu"]);
		expect((await page(a, b)).json().messages).toHaveLength(6);
	});

	test("pin, mute, inbox filters, strangers and blocks", async () => {
		const a = await registerAndLogin(app);
		const b = await registerAndLogin(app);
		const c = await registerAndLogin(app);
		await sendText(b, a, "von b");
		await sendText(c, a, "von c");
		expect((await inbox(a)).entries.map((e) => e.data.participants[0].profileId)).toEqual([Number(c.profileId), Number(b.profileId)]);
		expect((await app.inject({ method: "POST", url: `/v4/chat/conversation/${cid(a, b)}/pin`, headers: h(a) })).statusCode).toBe(200);
		expect((await app.inject({ method: "POST", url: `/v1/push/conversation/${cid(a, b)}/mute`, headers: h(a) })).statusCode).toBe(200);
		const pinned = (await inbox(a)).entries;
		expect(pinned[0]!.data).toMatchObject({ conversationId: cid(a, b), pinned: true, muted: true });

		await override(a, "chat.pinned.max", { max: 1 });
		expect((await app.inject({ method: "POST", url: `/v4/chat/conversation/${cid(a, c)}/pin`, headers: h(a) })).statusCode).toBe(402);

		await app.inject({ method: "POST", url: `/v4/chat/conversation/${cid(a, c)}/read/0:00000000-0000-0000-0000-000000000000`, headers: h(a) });
		expect((await inbox(a, { unreadOnly: true })).entries.map((e) => e.data.conversationId)).toEqual([cid(a, b)]);

		// Someone else's conversation: not permitted.
		expect((await app.inject({ method: "GET", url: `/v5/chat/conversation/${cid(b, c)}/message`, headers: h(a) })).statusCode).toBe(403);
		expect((await app.inject({ method: "POST", url: "/v4/chatstatus/typing", headers: h(a), payload: { conversationId: cid(b, c), status: "Typing" } })).statusCode).toBe(403);

		// Block: sending and reading the thread are refused, the inbox hides it.
		await db.insert(blocks).values({ ownerId: BigInt(b.profileId), targetId: BigInt(a.profileId) });
		await invalidateRelations(a.profileId, b.profileId);
		const blockedSend = await app.inject({ method: "POST", url: "/v4/chat/message/send", headers: h(a), payload: { type: "Text", target: { type: "Direct", targetId: Number(b.profileId) }, body: { text: "?" } } });
		expect(blockedSend.statusCode).toBe(403);
		expect((await page(a, b)).statusCode).toBe(403);
		expect((await inbox(a)).entries.map((e) => e.data.conversationId)).toEqual([cid(a, c)]);
	});

	test("voice messages: MediaRecorder MP4 and WebM are audio, not video", async () => {
		const a = await registerAndLogin(app);
		const b = await registerAndLogin(app);
		const box = (type: string, payload: Buffer) => {
			const head = Buffer.alloc(8);
			head.writeUInt32BE(8 + payload.length);
			head.write(type, 4, "ascii");
			return Buffer.concat([head, payload]);
		};
		// Audio-only ISO-BMFF (isom brand, one "soun" track) as Android's recorder writes it.
		const hdlr = box("hdlr", Buffer.concat([Buffer.alloc(8), Buffer.from("soun"), Buffer.alloc(12), Buffer.from("SoundHandler ")]));
		const mp4 = Buffer.concat([box("ftyp", Buffer.from("isom   isomiso2mp41", "latin1")), box("moov", box("trak", box("mdia", hdlr))), box("mdat", Buffer.alloc(256, 7))]);
		// WebM with one Opus track (CodecID element 0x86, size 6, "A_OPUS").
		const webm = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01]), Buffer.from([0x16, 0x54, 0xae, 0x6b, 0x86, 0x86]), Buffer.from("A_OPUS"), Buffer.alloc(256, 3)]);

		for (const [bytes, contentType] of [
			[mp4, "audio/aac"],
			[webm, "audio/webm;codecs=opus"],
		] as const) {
			const up = await app.inject({ method: "POST", url: "/v5/chat/media/upload?takenOnGrindr=false&length=3200&looping=false", headers: { ...h(a), "content-type": contentType }, payload: bytes });
			expect(up.statusCode).toBe(200);
			const { mediaId } = up.json() as { mediaId: number };
			const sent = await app.inject({ method: "POST", url: "/v4/chat/message/send", headers: h(a), payload: { type: "Audio", target: { type: "Direct", targetId: Number(b.profileId) }, body: { mediaId, contentType, length: 3200 } } });
			expect(sent.statusCode).toBe(201);
			expect(sent.json()).toMatchObject({ type: "Audio", body: { mediaId, contentType: contentType.split(";")[0], length: 3200 } });
		}
	});

	test("media: upload, image + expiring image with signed URLs, drawer", async () => {
		const a = await registerAndLogin(app);
		const b = await registerAndLogin(app);
		const up = await app.inject({ method: "POST", url: "/v5/chat/media/upload?takenOnGrindr=false", headers: { ...h(a), "content-type": "image/jpeg" }, payload: await jpeg() });
		expect(up.statusCode).toBe(200);
		const { mediaId, mediaHash, url } = up.json() as { mediaId: number; mediaHash: string; url: string };
		expect(url).toContain(`/${a.profileId}/${mediaHash}?Expires=`);

		// Image: everyone in the conversation gets a URL signed for themselves.
		const img = await app.inject({ method: "POST", url: "/v4/chat/message/send", headers: h(a), payload: { type: "Image", target: { type: "Direct", targetId: Number(b.profileId) }, body: { mediaId } } });
		expect(img.statusCode).toBe(201);
		const bView = (await page(b, a)).json().messages[0] as Msg;
		expect(bView.body).toMatchObject({ mediaId, imageHash: mediaHash, width: 64, height: 48 });
		const bUrl = new URL(bView.body.url);
		// Like upstream CloudFront: the signed URL alone is enough until it expires.
		const ok = await app.inject({ method: "GET", url: bUrl.pathname + bUrl.search });
		expect(ok.statusCode).toBe(200);
		expect(ok.headers["content-type"]).toBe("image/jpeg");
		expect(String(ok.headers["cache-control"])).toMatch(/^private, max-age=\d+$/);
		const tampered = bUrl.search.replace(/Signature=[^&]+/, "Signature=AAAA");
		expect((await app.inject({ method: "GET", url: bUrl.pathname + tampered })).statusCode).toBe(403);
		expect((await app.inject({ method: "GET", url: bUrl.pathname })).statusCode).toBe(403);

		// Someone else's media id can't be sent.
		const foreign = await app.inject({ method: "POST", url: "/v4/chat/message/send", headers: h(b), payload: { type: "Image", target: { type: "Direct", targetId: Number(a.profileId) }, body: { mediaId } } });
		expect(foreign.statusCode).toBe(400);

		// Expiring image: no URL in the list; the single GET spends the one view.
		const exp = await app.inject({ method: "POST", url: "/v4/chat/message/send", headers: h(a), payload: { type: "ExpiringImage", target: { type: "Direct", targetId: Number(b.profileId) }, body: { mediaId, expiring: true } } });
		expect(exp.statusCode).toBe(201);
		const expId = exp.json().messageId as string;
		const listed = ((await page(b, a)).json().messages as Msg[]).find((m) => m.messageId === expId)!;
		expect(listed.body).toMatchObject({ url: null, duration: 10000, viewsRemaining: 1, viewed: false });
		const single = async () => (await app.inject({ method: "GET", url: `/v4/chat/conversation/${cid(a, b)}/message/${expId}`, headers: h(b) })).json().message as Msg;
		const opened = await single();
		expect(opened.body.url).toBeString();
		expect(opened.body.viewsRemaining).toBe(0);
		expect(opened.body.expiresAt - Date.now()).toBeLessThanOrEqual(16_000);
		const again = await single();
		expect(again.body).toMatchObject({ url: null, duration: -1, viewsRemaining: 0, viewed: true });

		await override(a, "chat.expiringImages.perDay", { windows: [{ count: 0, window: "day" }] });
		const limited = await app.inject({ method: "POST", url: "/v4/chat/message/send", headers: h(a), payload: { type: "ExpiringImage", target: { type: "Direct", targetId: Number(b.profileId) }, body: { mediaId, expiring: true } } });
		expect(limited.statusCode).toBe(402);
		expect(limited.json().type).toBe("urn:gr:err:entitlement_limit");

		// Shared images with B: the non-expiring one only.
		const shared = await app.inject({ method: "GET", url: `/v5/chat/media/shared/images/with-me/${cid(a, b)}`, headers: h(b) });
		expect(shared.json().images.map((i: Msg) => i.mediaId)).toEqual([mediaId]);

		// Drawer.
		expect((await app.inject({ method: "PUT", url: `/v4/chat/media/drawer/${mediaId}`, headers: h(a) })).statusCode).toBe(200);
		const drawer = (await app.inject({ method: "GET", url: `/v4/chat/media/drawer/${cid(a, b)}`, headers: h(a) })).json() as Msg[];
		expect(drawer).toHaveLength(1);
		expect(drawer[0]).toMatchObject({ id: mediaId, contentType: "image/jpeg", used: true, takenOnGrindr: false });
		expect((await app.inject({ method: "GET", url: "/v4/chat/media/drawer", headers: h(a) })).json()[0].used).toBe(false);
		expect((await app.inject({ method: "DELETE", url: `/v4/chat/media/drawer/${mediaId}`, headers: h(a) })).statusCode).toBe(202);
		expect((await app.inject({ method: "GET", url: "/v4/chat/media/drawer", headers: h(a) })).json()).toEqual([]);
	});

	test("saved phrases", async () => {
		const a = await registerAndLogin(app);
		const add = await app.inject({ method: "POST", url: "/v1/chat/phrases", headers: h(a), payload: { text: "Hey, wie geht's?" } });
		expect(add.json().phrase).toMatchObject({ text: "Hey, wie geht's?", type: "user" });
		const legacy = await app.inject({ method: "POST", url: "/v3/me/prefs/phrases", headers: h(a), payload: { phrase: "Bis später" } });
		const list = (await app.inject({ method: "GET", url: "/v1/chat/phrases", headers: h(a) })).json().phrases as Msg[];
		expect(list.map((p) => p.text)).toEqual(["Hey, wie geht's?", "Bis später"]);
		await app.inject({ method: "DELETE", url: `/v3/me/prefs/phrases/${legacy.json().phraseId}`, headers: h(a) });
		expect((await app.inject({ method: "GET", url: "/v1/chat/phrases", headers: h(a) })).json().phrases).toHaveLength(1);
	});
});
