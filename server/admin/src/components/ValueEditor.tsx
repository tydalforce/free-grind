import { Plus, Trash2 } from "lucide-react";
import type { EntitlementDef, EntitlementValue, QuotaWindow } from "../api";
import { Button, cn } from "./ui";

/** Human summary of a value, used in the matrix cells. */
export function describeValue(def: EntitlementDef, value: EntitlementValue | undefined): string {
	if (value === undefined) return "–";
	if (typeof value === "boolean") return value ? "an" : "aus";
	if ("unlimited" in value) return "∞";
	if ("max" in value) return formatAmount(value.max, def.unit);
	if ("seconds" in value) return formatSeconds(value.seconds);
	if ("values" in value) return value.values.length ? value.values.join(", ") : "keine";
	return value.windows.map(describeWindow).join(" + ");
}

export function describeWindow(w: QuotaWindow): string {
	if (w.window === "refill") return `+1/${formatSeconds(w.everySeconds)} (max ${w.max})`;
	if (w.window === "rolling") return `${w.count}/${formatSeconds(w.seconds)}`;
	return `${w.count}/${{ day: "Tag", week: "Woche", month: "Monat" }[w.window]}`;
}

function formatSeconds(s: number): string {
	if (s % 86_400 === 0) return `${s / 86_400} d`;
	if (s % 3600 === 0) return `${s / 3600} h`;
	if (s % 60 === 0) return `${s / 60} min`;
	return `${s} s`;
}

function formatAmount(n: number, unit: EntitlementDef["unit"]): string {
	if (unit === "bytes") {
		if (n >= 1024 ** 3 && n % 1024 ** 3 === 0) return `${n / 1024 ** 3} GB`;
		if (n >= 1024 ** 2) return `${Math.round((n / 1024 ** 2) * 10) / 10} MB`;
		return `${n} B`;
	}
	if (unit === "ms") return n % 1000 === 0 ? `${n / 1000} s` : `${n} ms`;
	if (unit === "seconds") return formatSeconds(n);
	return String(n);
}

const BYTE_UNITS = [
	["MB", 1024 ** 2],
	["GB", 1024 ** 3],
] as const;
const TIME_UNITS = [
	["s", 1],
	["min", 60],
	["h", 3600],
	["d", 86_400],
] as const;

function NumberWithUnit({ value, onChange, unit }: { value: number; onChange: (v: number) => void; unit: EntitlementDef["unit"] }) {
	if (unit === "bytes") {
		const [label, factor] = value >= 1024 ** 3 && value % 1024 ** 3 === 0 ? BYTE_UNITS[1] : BYTE_UNITS[0];
		return (
			<span className="inline-flex items-center gap-1">
				<input type="number" min={0} step="any" className="w-24" value={Math.round((value / factor) * 100) / 100} onChange={(e) => onChange(Math.round(Number(e.target.value) * factor))} />
				<select value={label} onChange={(e) => onChange(Math.round((value / factor) * (e.target.value === "GB" ? 1024 ** 3 : 1024 ** 2)))}>
					{BYTE_UNITS.map(([l]) => (
						<option key={l}>{l}</option>
					))}
				</select>
			</span>
		);
	}
	if (unit === "ms") {
		return (
			<span className="inline-flex items-center gap-1">
				<input type="number" min={0} className="w-24" value={value / 1000} onChange={(e) => onChange(Math.round(Number(e.target.value) * 1000))} />
				<span className="text-xs text-muted">s</span>
			</span>
		);
	}
	return <input type="number" min={0} className="w-24" value={value} onChange={(e) => onChange(Math.max(0, Math.round(Number(e.target.value))))} />;
}

function SecondsInput({ value, onChange }: { value: number; onChange: (v: number) => void }) {
	const [label, factor] = [...TIME_UNITS].reverse().find(([, f]) => value >= f && value % f === 0) ?? TIME_UNITS[0];
	return (
		<span className="inline-flex items-center gap-1">
			<input type="number" min={1} className="w-20" value={value / factor} onChange={(e) => onChange(Math.max(1, Math.round(Number(e.target.value) * factor)))} />
			<select value={label} onChange={(e) => onChange((value / factor) * (TIME_UNITS.find(([l]) => l === e.target.value)?.[1] ?? 1))}>
				{TIME_UNITS.map(([l]) => (
					<option key={l}>{l}</option>
				))}
			</select>
		</span>
	);
}

function WindowRow({ w, onChange, onRemove }: { w: QuotaWindow; onChange: (w: QuotaWindow) => void; onRemove?: () => void }) {
	return (
		<div className="flex flex-wrap items-center gap-2">
			{w.window !== "refill" ? <input type="number" min={0} className="w-20" value={w.count} onChange={(e) => onChange({ ...w, count: Math.max(0, Math.round(Number(e.target.value))) })} /> : null}
			<select
				value={w.window}
				onChange={(e) => {
					const kind = e.target.value as QuotaWindow["window"];
					if (kind === "rolling") onChange({ count: w.count, window: "rolling", seconds: 3600 });
					else if (kind === "refill") onChange({ count: w.count, window: "refill", everySeconds: 3600, max: Math.max(1, w.count) });
					else onChange({ count: w.count, window: kind });
				}}
			>
				<option value="day">pro Tag</option>
				<option value="week">pro Woche</option>
				<option value="month">pro Monat</option>
				<option value="rolling">pro Zeitraum (rollierend)</option>
				<option value="refill">Auffüllen</option>
			</select>
			{w.window === "rolling" ? <SecondsInput value={w.seconds} onChange={(seconds) => onChange({ ...w, seconds })} /> : null}
			{w.window === "refill" ? (
				<>
					<span className="text-xs text-muted">+1 alle</span>
					<SecondsInput value={w.everySeconds} onChange={(everySeconds) => onChange({ ...w, everySeconds })} />
					<span className="text-xs text-muted">bis max.</span>
					<input type="number" min={1} className="w-16" value={w.max} onChange={(e) => onChange({ ...w, max: Math.max(1, Math.round(Number(e.target.value))), count: Math.max(1, Math.round(Number(e.target.value))) })} />
				</>
			) : null}
			{onRemove ? (
				<button type="button" onClick={onRemove} className="text-muted hover:text-danger" aria-label="Fenster entfernen">
					<Trash2 className="h-4 w-4" />
				</button>
			) : null}
		</div>
	);
}

/** Type-aware editor for one entitlement value. */
export function ValueEditor({ def, value, onChange }: { def: EntitlementDef; value: EntitlementValue; onChange: (v: EntitlementValue) => void }) {
	if (def.type === "boolean") {
		return (
			<label className="inline-flex items-center gap-2 text-sm">
				<input type="checkbox" checked={value === true} onChange={(e) => onChange(e.target.checked)} />
				{value === true ? "aktiviert" : "deaktiviert"}
			</label>
		);
	}
	const unlimited = typeof value === "object" && "unlimited" in value;
	const toggle = (
		<label className="inline-flex items-center gap-2 text-sm">
			<input
				type="checkbox"
				checked={unlimited}
				onChange={(e) => {
					if (e.target.checked) onChange({ unlimited: true });
					else if (def.type === "cap") onChange({ max: 0 });
					else if (def.type === "duration") onChange({ seconds: 3600 });
					else if (def.type === "list") onChange({ values: [] });
					else onChange({ windows: [{ count: 1, window: "day" }] });
				}}
			/>
			unbegrenzt
		</label>
	);
	if (unlimited) return toggle;
	return (
		<div className="flex flex-col gap-2">
			{toggle}
			{def.type === "cap" && typeof value === "object" && "max" in value ? <NumberWithUnit unit={def.unit} value={value.max} onChange={(max) => onChange({ max })} /> : null}
			{def.type === "duration" && typeof value === "object" && "seconds" in value ? <SecondsInput value={value.seconds} onChange={(seconds) => onChange({ seconds })} /> : null}
			{def.type === "list" && typeof value === "object" && "values" in value ? (
				<div className="flex flex-wrap gap-1.5">
					{(def.options ?? []).map((opt) => {
						const on = value.values.includes(opt);
						return (
							<button
								key={opt}
								type="button"
								onClick={() => onChange({ values: on ? value.values.filter((v) => v !== opt) : [...value.values, opt] })}
								className={cn("rounded-md border px-2 py-0.5 text-xs", on ? "border-accent bg-accent/15 text-accent" : "border-border text-muted hover:bg-surface-2")}
							>
								{opt}
							</button>
						);
					})}
				</div>
			) : null}
			{def.type === "quota" && typeof value === "object" && "windows" in value ? (
				<div className="flex flex-col gap-2">
					{value.windows.map((w, i) => (
						<WindowRow
							key={i}
							w={w}
							onChange={(nw) => onChange({ windows: value.windows.map((x, j) => (j === i ? nw : x)) })}
							onRemove={value.windows.length > 1 ? () => onChange({ windows: value.windows.filter((_, j) => j !== i) }) : undefined}
						/>
					))}
					{value.windows.length < 5 ? (
						<Button type="button" className="self-start" onClick={() => onChange({ windows: [...value.windows, { count: 1, window: "week" }] })}>
							<Plus className="h-3.5 w-3.5" /> Fenster
						</Button>
					) : null}
				</div>
			) : null}
		</div>
	);
}
