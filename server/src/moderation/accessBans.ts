import { and, desc, eq, gt, isNull, or, sql } from "drizzle-orm";
import { db } from "../db/client";
import { authTokens, deviceBans, devices, networkBans } from "../db/schema";
import { ApiError, accountBannedDecoy, coded } from "../lib/errors";
import { banUser, currentBan, type BanInput } from "./bans";

/**
 * Device and network bans, with the upstream bodies the client already maps
 * (grindr-patched BanKind):
 *  - device  → sign-up refused with code 28 ACCOUNT_BANNED (same body as the
 *              header decoy). Accounts are banned with it: every account that
 *              used the device when it's banned, and any account that signs in
 *              on it later.
 *  - network → sign-up, sign-in and refresh refused with code 31 SUSPICIOUS_NETWORK
 */

export function suspiciousNetworkError(): ApiError {
	return coded(403, 31, "SUSPICIOUS_NETWORK", {
		profileId: null,
		type: null,
		reason: null,
		isBanAutomated: true,
		thirdPartyUserIdToShow: null,
		banSubReason: null,
	});
}

export async function isDeviceBanned(deviceId: string): Promise<boolean> {
	const [row] = await db
		.select({ id: deviceBans.id })
		.from(deviceBans)
		.where(and(eq(deviceBans.deviceId, deviceId.toLowerCase()), isNull(deviceBans.liftedAt)))
		.limit(1);
	return !!row;
}

export async function isNetworkBanned(ip: string): Promise<boolean> {
	if (!isIpAddress(ip)) return false;
	const [row] = await db
		.select({ id: networkBans.id })
		.from(networkBans)
		.where(
			and(
				isNull(networkBans.liftedAt),
				or(isNull(networkBans.expiresAt), gt(networkBans.expiresAt, new Date())),
				sql`${networkBans.cidr} >>= ${ip}::inet`,
			),
		)
		.limit(1);
	return !!row;
}

/** Sign-up: throws the upstream refusal when the device or the network is banned. */
export async function refuseIfDeviceOrNetworkBanned(deviceId: string, ip: string): Promise<void> {
	const [device, network] = await Promise.all([isDeviceBanned(deviceId), isNetworkBanned(ip)]);
	if (device) throw accountBannedDecoy();
	if (network) throw suspiciousNetworkError();
}

/** Sign-in and refresh: throws code 31 when the network is banned. */
export async function refuseIfNetworkBanned(ip: string): Promise<void> {
	if (await isNetworkBanned(ip)) throw suspiciousNetworkError();
}

type BanTemplate = Pick<BanInput, "type" | "reason" | "subReason" | "requireAgreement" | "expiresAt">;
const PERMANENT: BanTemplate = { type: "permanent", reason: null, subReason: null, requireAgreement: false, expiresAt: null };

/**
 * The ban linked accounts get: a copy of the source account's ban while it's
 * running (permanent, or timed with the same end), permanent otherwise.
 */
async function templateFrom(sourceUserId: bigint | null | undefined): Promise<BanTemplate> {
	if (!sourceUserId) return PERMANENT;
	const state = await currentBan(sourceUserId);
	if (state?.kind !== "permanent" && state?.kind !== "active") return PERMANENT;
	const b = state.ban;
	return { type: b.type, reason: b.reason, subReason: b.subReason, requireAgreement: b.requireAgreement, expiresAt: b.expiresAt };
}

/** Bans one account linked to a banned device, unless it's already permanently banned. */
async function banLinkedAccount(userId: bigint, template: BanTemplate, note: string, createdBy: string): Promise<boolean> {
	const state = await currentBan(userId);
	if (state?.kind === "permanent") return false;
	await banUser(userId, { ...template, automated: true, note, createdBy });
	return true;
}

/** Accounts that ever used one of these devices (push registrations or refresh tokens). */
async function accountsOnDevices(deviceIds: string[]): Promise<bigint[]> {
	const list = sql.join(
		deviceIds.map((d) => sql`${d}`),
		sql`, `,
	);
	const rows = (await db.execute(sql`
		SELECT DISTINCT d.user_id::text AS id FROM (
			SELECT user_id FROM devices WHERE lower(device_id) IN (${list})
			UNION SELECT user_id FROM auth_tokens WHERE lower(device_id) IN (${list})
		) d JOIN users u ON u.id = d.user_id WHERE u.deleted_at IS NULL
	`)) as unknown as { id: string }[];
	return rows.map((r) => BigInt(r.id));
}

/**
 * After a successful sign-in or refresh: on a banned device the account is
 * banned too (copying the source account's ban, see templateFrom). The source
 * account itself, if an admin has lifted its ban since, isn't banned again but
 * still can't use the device (code 28) until the device ban is lifted.
 */
export async function enforceDeviceBan(userId: bigint, deviceId: string): Promise<void> {
	const [row] = await db
		.select({ id: deviceBans.id, userId: deviceBans.userId })
		.from(deviceBans)
		.where(and(eq(deviceBans.deviceId, deviceId.toLowerCase()), isNull(deviceBans.liftedAt)))
		.limit(1);
	if (!row) return;
	if (row.userId === userId) {
		if (!(await currentBan(userId))) throw accountBannedDecoy();
		return;
	}
	await banLinkedAccount(userId, await templateFrom(row.userId), `Login auf gesperrtem Gerät ${deviceId.toLowerCase()} (Gerätesperre #${row.id})`, "system:device-ban");
}

function isIpAddress(ip: string): boolean {
	return /^[0-9.]+$/.test(ip) || /^[0-9a-f:.]+$/i.test(ip);
}

/** Normalizes "10.0.0.0/8", "2001:db8::/32" or a single address; null if invalid. */
export async function normalizeCidr(input: string): Promise<string | null> {
	const v = input.trim();
	if (!/^[0-9a-fA-F:.]+(\/\d{1,3})?$/.test(v)) return null;
	try {
		const rows = (await db.execute(sql`SELECT ${v}::cidr::text AS c`)) as unknown as { c: string }[];
		return rows[0]?.c ?? null;
	} catch {
		// Host bits set ("10.0.0.1/8") or out-of-range prefix.
		return null;
	}
}

/** Device ids an account has used (push registrations and refresh tokens). */
export async function devicesOfUser(userId: bigint): Promise<string[]> {
	const [a, b] = await Promise.all([
		db.selectDistinct({ d: devices.deviceId }).from(devices).where(eq(devices.userId, userId)),
		db.selectDistinct({ d: authTokens.deviceId }).from(authTokens).where(eq(authTokens.userId, userId)),
	]);
	return [...new Set([...a, ...b].map((r) => r.d.toLowerCase()))];
}

/**
 * Bans devices and every account that ever used one of them (except the
 * source account, which the caller has banned already). Linked accounts get
 * the source account's ban, or a permanent one for a device ban on its own;
 * banning ends their running sessions.
 */
export async function banDevices(
	deviceIds: string[],
	opts: { userId?: bigint | null; note?: string | null; createdBy: string },
): Promise<{ devices: number; accounts: number }> {
	const ids = [...new Set(deviceIds.map((d) => d.toLowerCase()))];
	if (!ids.length) return { devices: 0, accounts: 0 };
	const inserted = await db
		.insert(deviceBans)
		.values(ids.map((deviceId) => ({ deviceId, userId: opts.userId ?? null, note: opts.note ?? null, createdBy: opts.createdBy })))
		.onConflictDoNothing()
		.returning({ id: deviceBans.id });
	const template = await templateFrom(opts.userId);
	const source = opts.userId ? ` von Konto ${opts.userId}` : "";
	let accounts = 0;
	for (const id of await accountsOnDevices(ids)) {
		if (id === opts.userId) continue;
		if (await banLinkedAccount(id, template, `Gerätesperre${source}: gleiches Gerät`, opts.createdBy)) accounts++;
	}
	return { devices: inserted.length, accounts };
}

export async function liftDeviceBan(id: bigint, by: string): Promise<boolean> {
	const rows = await db
		.update(deviceBans)
		.set({ liftedAt: new Date(), liftedBy: by })
		.where(and(eq(deviceBans.id, id), isNull(deviceBans.liftedAt)))
		.returning({ id: deviceBans.id });
	return rows.length > 0;
}

export async function banNetwork(cidr: string, opts: { expiresAt?: Date | null; note?: string | null; createdBy: string }) {
	const [row] = await db
		.insert(networkBans)
		.values({ cidr, expiresAt: opts.expiresAt ?? null, note: opts.note ?? null, createdBy: opts.createdBy })
		.returning();
	return row!;
}

export async function liftNetworkBan(id: bigint, by: string): Promise<boolean> {
	const rows = await db
		.update(networkBans)
		.set({ liftedAt: new Date(), liftedBy: by })
		.where(and(eq(networkBans.id, id), isNull(networkBans.liftedAt)))
		.returning({ id: networkBans.id });
	return rows.length > 0;
}

export async function listDeviceBans(limit = 200) {
	return db
		.select({
			id: deviceBans.id,
			deviceId: deviceBans.deviceId,
			userId: deviceBans.userId,
			note: deviceBans.note,
			createdBy: deviceBans.createdBy,
			createdAt: deviceBans.createdAt,
		})
		.from(deviceBans)
		.where(isNull(deviceBans.liftedAt))
		.orderBy(desc(deviceBans.id))
		.limit(limit);
}

export async function listNetworkBans(limit = 200) {
	return db
		.select({
			id: networkBans.id,
			cidr: networkBans.cidr,
			note: networkBans.note,
			createdBy: networkBans.createdBy,
			createdAt: networkBans.createdAt,
			expiresAt: networkBans.expiresAt,
		})
		.from(networkBans)
		.where(isNull(networkBans.liftedAt))
		.orderBy(desc(networkBans.id))
		.limit(limit);
}

/** Open device bans that came from this account. */
export async function deviceBansOfUser(userId: bigint) {
	return db
		.select({ id: deviceBans.id, deviceId: deviceBans.deviceId, createdAt: deviceBans.createdAt })
		.from(deviceBans)
		.where(and(eq(deviceBans.userId, userId), isNull(deviceBans.liftedAt)));
}
