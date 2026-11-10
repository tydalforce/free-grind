import { sql } from "drizzle-orm";
import { db } from "../db/client";
import { type BroadcastTarget, pushQueue } from "../jobs/queues";

/**
 * Admin broadcast: a plain-text push to everyone (with a registered device),
 * one role, or chosen profiles. Sent as an upstream "growth" system push, so
 * the app shows title and text as they are.
 */

const BATCH = 1000;

function targetSql(target: BroadcastTarget) {
	if (target.kind === "role") return sql`AND EXISTS (SELECT 1 FROM user_roles r WHERE r.user_id = d.user_id AND r.role = ${target.role} AND (r.expires_at IS NULL OR r.expires_at > now()))`;
	if (target.kind === "users") return sql`AND d.user_id = ANY(${`{${target.userIds.join(",") || "0"}}`}::bigint[])`;
	return sql``;
}

/** How many accounts would get it (have a push-capable device). */
export async function countRecipients(target: BroadcastTarget): Promise<number> {
	const [row] = (await db.execute(sql`
		SELECT count(DISTINCT d.user_id)::int AS n FROM devices d JOIN users u ON u.id = d.user_id AND u.deleted_at IS NULL
		WHERE d.fcm_token IS NOT NULL AND d.revoked_at IS NULL ${targetSql(target)}`)) as unknown as { n: number }[];
	return row?.n ?? 0;
}

/** Worker: fans the broadcast out as one push job per account, in keyset batches. */
export async function runBroadcast(title: string, body: string, target: BroadcastTarget): Promise<number> {
	const notificationId = crypto.randomUUID();
	let after = "0";
	let sent = 0;
	for (;;) {
		const rows = (await db.execute(sql`
			SELECT DISTINCT d.user_id::text AS id FROM devices d JOIN users u ON u.id = d.user_id AND u.deleted_at IS NULL
			WHERE d.fcm_token IS NOT NULL AND d.revoked_at IS NULL AND d.user_id > ${after}::bigint ${targetSql(target)}
			ORDER BY 1 LIMIT ${BATCH}`)) as unknown as { id: string }[];
		if (!rows.length) break;
		await pushQueue.addBulk(
			rows.map((r) => ({
				name: "push",
				data: {
					userId: r.id,
					skipIfConnected: false,
					data: {
						version: "2",
						notificationId,
						timestamp: String(Date.now()),
						title,
						translateTitle: "false",
						body,
						translateBody: "false",
						action: "grindr://growth-notification?type=broadcast",
						channel: "id_grindr_notifications_channel_individual_v2",
					},
				},
			})),
		);
		sent += rows.length;
		after = rows[rows.length - 1]!.id;
		if (rows.length < BATCH) break;
	}
	return sent;
}
