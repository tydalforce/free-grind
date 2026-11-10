import { z } from "zod";
import { ENTITLEMENTS, type EntitlementValue } from "./registry";

const unlimited = z.object({ unlimited: z.literal(true) }).strict();
const nonNegInt = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

const quotaWindow = z.discriminatedUnion("window", [
	z.object({ window: z.enum(["day", "week", "month"]), count: nonNegInt }).strict(),
	z.object({ window: z.literal("rolling"), count: nonNegInt, seconds: z.number().int().min(1).max(366 * 86_400) }).strict(),
	z.object({ window: z.literal("refill"), count: nonNegInt, everySeconds: z.number().int().min(1).max(366 * 86_400), max: z.number().int().min(1).max(1_000_000) }).strict(),
]);

const byType = {
	boolean: z.boolean(),
	cap: z.union([unlimited, z.object({ max: nonNegInt }).strict()]),
	duration: z.union([unlimited, z.object({ seconds: nonNegInt }).strict()]),
	quota: z.union([unlimited, z.object({ windows: z.array(quotaWindow).min(1).max(5) }).strict()]),
	list: z.union([unlimited, z.object({ values: z.array(z.string()).max(100) }).strict()]),
} as const;

/** Validates an admin-supplied value against the entitlement's type (and list options). */
export function validateEntitlementValue(key: string, value: unknown): { ok: true; value: EntitlementValue } | { ok: false; error: string } {
	const def = ENTITLEMENTS.get(key);
	if (!def) return { ok: false, error: `unknown entitlement ${key}` };
	const parsed = byType[def.type].safeParse(value);
	if (!parsed.success) return { ok: false, error: parsed.error.issues.map((i) => `${i.path.join(".") || "value"}: ${i.message}`).join("; ") };
	const v = parsed.data as EntitlementValue;
	if (def.type === "list" && def.options && typeof v === "object" && "values" in v) {
		const bad = v.values.filter((x) => !def.options!.includes(x));
		if (bad.length) return { ok: false, error: `not allowed: ${bad.join(", ")}` };
	}
	return { ok: true, value: v };
}
