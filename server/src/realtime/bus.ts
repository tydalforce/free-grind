import { randomUUID } from "node:crypto";
import { redis } from "../cache/redis";

/**
 * Realtime fanout. Every event goes to the Redis channel of its recipient
 * (`ws:user:<id>`); each API instance subscribes only to the users that have
 * a socket on it (realtime/gateway.ts), so instances never see foreign traffic.
 */
export const userChannel = (userId: bigint | string) => `ws:user:${userId}`;

export type NotificationEvent = { type: string; notificationId: string | null; ref: null; payload: unknown };

export function notification(type: string, payload: unknown): NotificationEvent {
	return { type, notificationId: randomUUID(), ref: null, payload };
}

export async function publishToUser(userId: bigint | string, type: string, payload: unknown): Promise<void> {
	await redis.publish(userChannel(userId), JSON.stringify(notification(type, payload)));
}

/** Presence: a user counts as connected while any instance refreshes this key. */
export const presenceKey = (userId: bigint | string) => `presence:${userId}`;

export async function isConnected(userId: bigint | string): Promise<boolean> {
	return (await redis.exists(presenceKey(userId))) === 1;
}
