import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { and, eq, gt } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import { config } from "../config";
import { db } from "../db/client";
import { type AdminRole, adminSessions, admins } from "../db/schema";
import { ApiError } from "../lib/errors";
import { sha256Hex } from "../lib/secrets";

export const ADMIN_COOKIE = "fg_admin";
const SESSION_TTL_MS = 12 * 3_600_000;
/** Custom header required on every mutating admin request (CSRF: a cross-site form can't set it). */
export const ADMIN_CSRF_HEADER = "x-admin-request";

export type AdminContext = { id: bigint; username: string; role: AdminRole; sessionId: string };

declare module "fastify" {
	interface FastifyRequest {
		admin: AdminContext;
	}
	interface FastifyInstance {
		requireAdmin: (req: FastifyRequest) => Promise<void>;
		requireOwner: (req: FastifyRequest) => Promise<void>;
	}
}

export const adminPasswordOpts = { algorithm: "argon2id", memoryCost: 19456, timeCost: 2 } as const;

// --- TOTP (RFC 6238, SHA-1, 30 s, 6 digits) -------------------------------------

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function newTotpSecret(): string {
	const bytes = randomBytes(20);
	let bits = "";
	for (const b of bytes) bits += b.toString(2).padStart(8, "0");
	let out = "";
	for (let i = 0; i + 5 <= bits.length; i += 5) out += B32[Number.parseInt(bits.slice(i, i + 5), 2)];
	return out;
}

function base32Decode(s: string): Buffer {
	let bits = "";
	for (const c of s.replace(/=+$/, "").toUpperCase()) {
		const v = B32.indexOf(c);
		if (v < 0) throw new Error("bad base32");
		bits += v.toString(2).padStart(5, "0");
	}
	const bytes: number[] = [];
	for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(Number.parseInt(bits.slice(i, i + 8), 2));
	return Buffer.from(bytes);
}

export function totpCode(secret: string, nowMs = Date.now(), stepOffset = 0): string {
	const counter = Math.floor(nowMs / 30_000) + stepOffset;
	const buf = Buffer.alloc(8);
	buf.writeBigUInt64BE(BigInt(counter));
	const h = createHmac("sha1", base32Decode(secret)).update(buf).digest();
	const o = h[h.length - 1]! & 0xf;
	const code = ((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).toString().padStart(6, "0");
	return code;
}

/** Accepts the current and the adjacent 30 s steps (clock skew). */
export function verifyTotp(secret: string, code: string, nowMs = Date.now()): boolean {
	if (!/^\d{6}$/.test(code)) return false;
	return [-1, 0, 1].some((off) => {
		const expected = Buffer.from(totpCode(secret, nowMs, off));
		return timingSafeEqual(expected, Buffer.from(code));
	});
}

// --- Sessions -------------------------------------------------------------------

function parseCookies(header: string | undefined): Record<string, string> {
	const out: Record<string, string> = {};
	if (!header) return out;
	for (const part of header.split(";")) {
		const i = part.indexOf("=");
		if (i < 0) continue;
		out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
	}
	return out;
}

function cookieAttrs(maxAgeSeconds: number): string {
	const secure = config.PUBLIC_API_URL.startsWith("https://") ? "; Secure" : "";
	return `Path=/admin; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}${secure}`;
}

export async function startAdminSession(reply: FastifyReply, req: FastifyRequest, adminId: bigint): Promise<void> {
	const token = randomBytes(32).toString("base64url");
	await db.insert(adminSessions).values({
		id: sha256Hex(token),
		adminId,
		ip: req.ip,
		userAgent: String(req.headers["user-agent"] ?? "").slice(0, 300),
		expiresAt: new Date(Date.now() + SESSION_TTL_MS),
	});
	reply.header("set-cookie", `${ADMIN_COOKIE}=${token}; ${cookieAttrs(SESSION_TTL_MS / 1000)}`);
}

export async function endAdminSession(reply: FastifyReply, sessionId: string): Promise<void> {
	await db.delete(adminSessions).where(eq(adminSessions.id, sessionId));
	reply.header("set-cookie", `${ADMIN_COOKIE}=; ${cookieAttrs(0)}`);
}

const unauthorized = () => new ApiError(401, { error: "unauthorized" });
const forbidden = () => new ApiError(403, { error: "forbidden" });

async function loadAdmin(req: FastifyRequest): Promise<AdminContext> {
	const token = parseCookies(req.headers.cookie)[ADMIN_COOKIE];
	if (!token) throw unauthorized();
	const id = sha256Hex(token);
	const [row] = await db
		.select({ adminId: admins.id, username: admins.username, role: admins.role, disabled: admins.disabled })
		.from(adminSessions)
		.innerJoin(admins, eq(admins.id, adminSessions.adminId))
		.where(and(eq(adminSessions.id, id), gt(adminSessions.expiresAt, new Date())))
		.limit(1);
	if (!row || row.disabled) throw unauthorized();
	return { id: row.adminId, username: row.username, role: row.role, sessionId: id };
}

export const adminAuthPlugin = fp(async (app: FastifyInstance) => {
	app.decorateRequest("admin", null as unknown as AdminContext);
	app.decorate("requireAdmin", async (req: FastifyRequest) => {
		if (req.method !== "GET" && req.method !== "HEAD" && req.headers[ADMIN_CSRF_HEADER] !== "1") throw forbidden();
		req.admin = await loadAdmin(req);
	});
	app.decorate("requireOwner", async (req: FastifyRequest) => {
		if (req.method !== "GET" && req.method !== "HEAD" && req.headers[ADMIN_CSRF_HEADER] !== "1") throw forbidden();
		req.admin = await loadAdmin(req);
		if (req.admin.role !== "owner") throw forbidden();
	});
});
