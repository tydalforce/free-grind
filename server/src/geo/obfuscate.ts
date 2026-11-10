import { createHmac } from "node:crypto";
import ngeohash from "ngeohash";

/**
 * Location privacy (plan 6d). The real position never leaves the server;
 * every distance, sort order, map marker and heatmap uses `public_location`,
 * computed here once per location update.
 *
 * The offset is *stable*: HMAC(user seed, geohash cell) picks a point
 * uniformly inside the radius. Averaging many responses converges on the
 * public point, not the real one. It is re-rolled only when the user moves to
 * another cell or after `rotateHours`.
 */

export type LatLon = { lat: number; lon: number };

const EARTH_RADIUS_M = 6_371_008.8;
/** Cell precision for the stable offset (~1.2 km × 0.6 km). */
export const FUZZ_CELL_PRECISION = 6;

export function decodeGeohash(geohash: string): LatLon {
	const { latitude, longitude } = ngeohash.decode(geohash);
	return { lat: latitude, lon: longitude };
}

export function encodeGeohash(p: LatLon, precision = 12): string {
	return ngeohash.encode(p.lat, p.lon, precision);
}

/** Moves `p` by `meters` towards `bearingRad` on a sphere. */
export function destination(p: LatLon, meters: number, bearingRad: number): LatLon {
	const δ = meters / EARTH_RADIUS_M;
	const φ1 = (p.lat * Math.PI) / 180;
	const λ1 = (p.lon * Math.PI) / 180;
	const φ2 = Math.asin(Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(bearingRad));
	const λ2 = λ1 + Math.atan2(Math.sin(bearingRad) * Math.sin(δ) * Math.cos(φ1), Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2));
	return { lat: (φ2 * 180) / Math.PI, lon: ((((λ2 * 180) / Math.PI + 540) % 360) - 180) };
}

export function haversineMeters(a: LatLon, b: LatLon): number {
	const φ1 = (a.lat * Math.PI) / 180;
	const φ2 = (b.lat * Math.PI) / 180;
	const dφ = φ2 - φ1;
	const dλ = ((b.lon - a.lon) * Math.PI) / 180;
	const h = Math.sin(dφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) ** 2;
	return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Two deterministic uniforms in [0,1) from HMAC(seed, cell|epoch). */
function uniforms(seed: string, salt: string): [number, number] {
	const h = createHmac("sha256", seed).update(salt).digest();
	return [h.readUInt32BE(0) / 0x1_0000_0000, h.readUInt32BE(4) / 0x1_0000_0000];
}

/**
 * Stable obfuscated point within `radiusM` of `real`.
 * sqrt(u) makes the point uniform over the disc's *area* (not clustered at the center).
 */
export function obfuscatedPoint(real: LatLon, seed: string, radiusM: number, epoch: number): { point: LatLon; cell: string } {
	const cell = encodeGeohash(real, FUZZ_CELL_PRECISION);
	if (radiusM <= 0) return { point: real, cell };
	const [u1, u2] = uniforms(seed, `${cell}|${epoch}`);
	const r = radiusM * Math.sqrt(u1);
	return { point: destination(real, r, u2 * 2 * Math.PI), cell };
}

/** Rotation epoch: changes every `rotateHours`. */
export function fuzzEpoch(nowMs: number, rotateHours: number): number {
	return Math.floor(nowMs / (Math.max(1, rotateHours) * 3_600_000));
}

/**
 * Distance as shown to others: always between public positions, rounded to
 * `roundMeters`, and much coarser when the target asked for approximate distance.
 */
export function displayedDistance(meters: number, opts: { roundMeters: number; approximate: boolean }): number {
	if (opts.approximate) {
		const steps = [500, 1000, 2000, 5000, 10_000, 25_000, 50_000, 100_000];
		for (const s of steps) if (meters <= s) return s;
		return Math.ceil(meters / 100_000) * 100_000;
	}
	const r = Math.max(1, opts.roundMeters);
	return Math.max(r, Math.round(meters / r) * r);
}

export function clampRadius(requested: number | null | undefined, opts: { min: number; max: number; fallback: number }): number {
	const v = requested == null ? opts.fallback : requested;
	return Math.min(opts.max, Math.max(opts.min, Math.round(v)));
}
