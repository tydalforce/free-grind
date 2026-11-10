import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { clampRadius, destination, displayedDistance, fuzzEpoch, haversineMeters, obfuscatedPoint } from "../../src/geo/obfuscate";

const BERLIN = { lat: 52.520008, lon: 13.404954 };

describe("obfuscatedPoint", () => {
	test("always inside the radius, never exactly the real point", () => {
		for (let i = 0; i < 500; i++) {
			const { point } = obfuscatedPoint(BERLIN, randomBytes(16).toString("hex"), 500, 1);
			const d = haversineMeters(BERLIN, point);
			expect(d).toBeLessThanOrEqual(500.5);
		}
	});

	test("stable for the same user, cell and epoch; changes with the epoch", () => {
		const seed = "seed-a";
		const a = obfuscatedPoint(BERLIN, seed, 800, 7).point;
		const b = obfuscatedPoint(BERLIN, seed, 800, 7).point;
		const c = obfuscatedPoint(BERLIN, seed, 800, 8).point;
		expect(a).toEqual(b);
		expect(haversineMeters(a, c)).toBeGreaterThan(0);
	});

	test("averaging many responses converges on the public point, not the real one", () => {
		// Stable offset ⇒ 1000 "requests" return the same point; its distance to the
		// real position stays the full offset instead of shrinking towards 0.
		const seed = "seed-b";
		const pts = Array.from({ length: 1000 }, () => obfuscatedPoint(BERLIN, seed, 1000, 3).point);
		const avg = { lat: pts.reduce((s, p) => s + p.lat, 0) / pts.length, lon: pts.reduce((s, p) => s + p.lon, 0) / pts.length };
		expect(haversineMeters(avg, pts[0]!)).toBeLessThan(0.01);
		expect(haversineMeters(avg, BERLIN)).toBeGreaterThan(1);
	});

	test("trilateration from three viewers recovers the public point, not the real one", () => {
		// Distances are measured to the public point, so solving for the position
		// from any number of viewers yields the public point.
		const seed = "seed-c";
		const pub = obfuscatedPoint(BERLIN, seed, 700, 1).point;
		const viewers = [0, 2.1, 4.2].map((b) => destination(BERLIN, 3000, b));
		const dists = viewers.map((v) => haversineMeters(v, pub));
		// brute-force solve on a grid around Berlin
		let best = { p: BERLIN, err: Number.POSITIVE_INFINITY };
		for (let dy = -1500; dy <= 1500; dy += 25) {
			for (let dx = -1500; dx <= 1500; dx += 25) {
				const cand = destination(destination(BERLIN, Math.abs(dy), dy < 0 ? Math.PI : 0), Math.abs(dx), dx < 0 ? -Math.PI / 2 : Math.PI / 2);
				const err = viewers.reduce((s, v, i) => s + (haversineMeters(v, cand) - dists[i]!) ** 2, 0);
				if (err < best.err) best = { p: cand, err };
			}
		}
		expect(haversineMeters(best.p, pub)).toBeLessThan(60);
		const realOffset = haversineMeters(BERLIN, pub);
		expect(haversineMeters(best.p, BERLIN)).toBeGreaterThan(realOffset - 60);
	});

	test("uniform over the disc area: ~25% within half the radius", () => {
		let inner = 0;
		const n = 4000;
		for (let i = 0; i < n; i++) {
			const { point } = obfuscatedPoint(BERLIN, `s${i}`, 1000, 1);
			if (haversineMeters(BERLIN, point) <= 500) inner++;
		}
		expect(inner / n).toBeGreaterThan(0.21);
		expect(inner / n).toBeLessThan(0.29);
	});
});

describe("distance output", () => {
	test("rounded to the configured step", () => {
		expect(displayedDistance(1234, { roundMeters: 100, approximate: false })).toBe(1200);
		expect(displayedDistance(12, { roundMeters: 100, approximate: false })).toBe(100);
	});
	test("approximate distance uses coarse steps", () => {
		expect(displayedDistance(1234, { roundMeters: 100, approximate: true })).toBe(2000);
		expect(displayedDistance(30_000, { roundMeters: 100, approximate: true })).toBe(50_000);
	});
	test("radius clamped to admin bounds", () => {
		expect(clampRadius(10, { min: 50, max: 1500, fallback: 300 })).toBe(50);
		expect(clampRadius(null, { min: 50, max: 1500, fallback: 300 })).toBe(300);
		expect(clampRadius(99999, { min: 50, max: 1500, fallback: 300 })).toBe(1500);
	});
	test("epoch rotates every N hours", () => {
		expect(fuzzEpoch(0, 168)).toBe(0);
		expect(fuzzEpoch(168 * 3_600_000, 168)).toBe(1);
	});
});
