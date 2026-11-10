import { randomUUID } from "node:crypto";
import { errors } from "../lib/errors";

/** Upstream conversation id: "<lowerProfileId>:<higherProfileId>". */
export function conversationIdFor(a: bigint, b: bigint): string {
	return a < b ? `${a}:${b}` : `${b}:${a}`;
}

export type ParsedConversation = { id: string; low: bigint; high: bigint };

export function parseConversationId(id: string): ParsedConversation | null {
	const m = /^(\d{1,19}):(\d{1,19})$/.exec(id);
	if (!m) return null;
	const low = BigInt(m[1]!);
	const high = BigInt(m[2]!);
	if (low >= high) return null;
	return { id, low, high };
}

/** The other participant, or a 403 when the caller is not part of the conversation. */
export function otherParticipant(conversationId: string, me: bigint): { conv: ParsedConversation; other: bigint } {
	const conv = parseConversationId(conversationId);
	if (!conv || (conv.low !== me && conv.high !== me)) throw errors.forbidden("Action not permitted");
	return { conv, other: conv.low === me ? conv.high : conv.low };
}

/** Upstream messageId: "<tsMs>:<uuidv4>"; timestamp === tsMs. */
export function newMessageId(nowMs = Date.now()): { id: string; ts: number } {
	return { id: `${nowMs}:${randomUUID()}`, ts: nowMs };
}

const MESSAGE_ID_RE = /^(\d{1,15}):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

export function parseMessageId(id: string): { ts: number; uuid: string } | null {
	const m = MESSAGE_ID_RE.exec(id);
	if (!m) return null;
	return { ts: Number(m[1]), uuid: m[2]! };
}
