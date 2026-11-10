import { and, asc, eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { db } from "../db/client";
import { savedPhrases } from "../db/schema";
import { checkCap } from "../entitlements/enforce";
import { errors } from "../lib/errors";
import { listInbox, listMessagesPage, sharedImagesWithMe } from "./inbox";
import {
	deleteConversationForMe,
	deleteMessageForMe,
	getSingleMessage,
	markRead,
	messagesById,
	reactToMessage,
	sendMessage,
	sendSchema,
	sendTyping,
	setMuted,
	setPinned,
	unsendMessage,
} from "./service";

const mutationSchema = z.object({ conversationId: z.string().min(3).max(41), messageId: z.string().min(1).max(80) });

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
	const r = schema.safeParse(value);
	if (!r.success) throw errors.badRequest("Invalid request");
	return r.data;
}

export async function chatRoutes(app: FastifyInstance): Promise<void> {
	const auth = { preHandler: app.authenticate };

	// --- Inbox & messages -----------------------------------------------------
	const inbox = async (req: import("fastify").FastifyRequest) => {
		const { page } = parse(z.object({ page: z.coerce.number().int().min(1).optional() }), req.query);
		return listInbox(req.auth.userId, page ?? 1, req.body ?? {});
	};
	app.post("/v4/inbox", auth, inbox);
	app.post("/v3/inbox", auth, inbox);

	app.get("/v5/chat/conversation/:cid/message", auth, async (req) => {
		const { cid } = req.params as { cid: string };
		const q = parse(z.object({ pageKey: z.string().max(80).optional(), profile: z.string().optional(), limit: z.coerce.number().int().min(1).max(100).optional() }), req.query);
		return listMessagesPage(req.auth.userId, cid, { pageKey: q.pageKey || undefined, limit: q.limit, includeProfile: q.profile === "true" });
	});

	app.get("/v4/chat/conversation/:cid/message/:mid", auth, async (req) => {
		const { cid, mid } = req.params as { cid: string; mid: string };
		return { message: await getSingleMessage(req.auth.userId, cid, mid) };
	});

	app.post("/v4/chat/conversation/:cid/message-by-id", auth, async (req) => {
		const { cid } = req.params as { cid: string };
		const { messageIds } = parse(z.object({ messageIds: z.array(z.string().max(80)).max(200) }), req.body);
		return { messages: await messagesById(req.auth.userId, cid, messageIds) };
	});

	app.post("/v4/chat/message/send", auth, async (req, reply) => {
		const input = parse(sendSchema, req.body);
		return reply.code(201).send(await sendMessage(req.auth.userId, input, { allowReply: false }));
	});

	app.post("/v4/chat/message/unsend", auth, async (req) => {
		const b = parse(mutationSchema, req.body);
		await unsendMessage(req.auth.userId, b.conversationId, b.messageId);
		return {};
	});

	app.post("/v4/chat/message/delete", auth, async (req) => {
		const b = parse(mutationSchema, req.body);
		await deleteMessageForMe(req.auth.userId, b.conversationId, b.messageId);
		return {};
	});

	app.post("/v4/chat/message/reaction", auth, async (req) => {
		const b = parse(mutationSchema.extend({ reactionType: z.coerce.number().int().min(0).max(1000) }), req.body);
		await reactToMessage(req.auth.userId, b.conversationId, b.messageId, b.reactionType);
		return {};
	});

	app.post("/v4/chatstatus/typing", auth, async (req) => {
		const b = parse(z.object({ conversationId: z.string().max(41), status: z.enum(["Typing", "Cleared"]) }), req.body);
		await sendTyping(req.auth.userId, b.conversationId, b.status);
		return {};
	});

	app.post("/v4/chat/conversation/:cid/read/:mid", auth, async (req) => {
		const { cid, mid } = req.params as { cid: string; mid: string };
		await markRead(req.auth.userId, cid, mid);
		return {};
	});

	app.post("/v4/chat/conversation/:cid/pin", auth, async (req) => {
		await setPinned(req.auth.userId, (req.params as { cid: string }).cid, true);
		return {};
	});
	app.post("/v4/chat/conversation/:cid/unpin", auth, async (req) => {
		await setPinned(req.auth.userId, (req.params as { cid: string }).cid, false);
		return {};
	});
	app.post("/v1/push/conversation/:cid/mute", auth, async (req) => {
		await setMuted(req.auth.userId, (req.params as { cid: string }).cid, true);
		return {};
	});
	app.post("/v1/push/conversation/:cid/unmute", auth, async (req) => {
		await setMuted(req.auth.userId, (req.params as { cid: string }).cid, false);
		return {};
	});
	app.delete("/v4/chat/conversation/:cid", auth, async (req) => {
		await deleteConversationForMe(req.auth.userId, (req.params as { cid: string }).cid);
		return {};
	});

	app.get("/v5/chat/media/shared/images/with-me/:cid", auth, async (req) => sharedImagesWithMe(req.auth.userId, (req.params as { cid: string }).cid));

	// --- Saved phrases ---------------------------------------------------------
	const listPhrases = (userId: bigint) => db.select().from(savedPhrases).where(eq(savedPhrases.userId, userId)).orderBy(asc(savedPhrases.createdAt)).limit(500);
	const addPhrase = async (userId: bigint, text: string) => {
		const [count] = await db.select({ n: sql<number>`count(*)::int` }).from(savedPhrases).where(eq(savedPhrases.userId, userId));
		await checkCap(userId, "chat.savedPhrases.max", count?.n ?? 0);
		const [row] = await db.insert(savedPhrases).values({ userId, text }).returning();
		return row!;
	};

	app.get("/v1/chat/phrases", auth, async (req) => ({
		phrases: (await listPhrases(req.auth.userId)).map((p) => ({ id: p.id, text: p.text, type: "user" })),
	}));
	app.post("/v1/chat/phrases", auth, async (req) => {
		const { text } = parse(z.object({ text: z.string().trim().min(1).max(1000) }), req.body);
		const p = await addPhrase(req.auth.userId, text);
		return { phrase: { id: p.id, text: p.text, type: "user" } };
	});
	app.get("/v3/me/prefs", auth, async (req) => ({
		phrases: Object.fromEntries(
			(await listPhrases(req.auth.userId)).map((p) => [p.id, { phraseId: p.id, phraseText: p.text, timestamp: p.createdAt.getTime(), frequency: p.frequency }]),
		),
	}));
	app.post("/v3/me/prefs/phrases", auth, async (req) => {
		const { phrase } = parse(z.object({ phrase: z.string().trim().min(1).max(1000) }), req.body);
		return { phraseId: (await addPhrase(req.auth.userId, phrase)).id };
	});
	app.delete("/v3/me/prefs/phrases/:id", auth, async (req) => {
		const { id } = req.params as { id: string };
		if (/^[0-9a-f-]{36}$/i.test(id)) await db.delete(savedPhrases).where(and(eq(savedPhrases.id, id), eq(savedPhrases.userId, req.auth.userId)));
		return {};
	});
	app.post("/v4/phrases/frequency/:id", auth, async (req) => {
		const { id } = req.params as { id: string };
		if (/^[0-9a-f-]{36}$/i.test(id)) {
			await db.update(savedPhrases).set({ frequency: sql`${savedPhrases.frequency} + 1` }).where(and(eq(savedPhrases.id, id), eq(savedPhrases.userId, req.auth.userId)));
		}
		return {};
	});
}
