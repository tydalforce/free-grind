import { useEffect, useState } from "react";
import { api } from "../api";
import { Badge, Button, Card, ErrorText, formatDate } from "./ui";

export type BanRow = {
	id: string;
	type: "timed" | "permanent";
	reason: string | null;
	subReason: string | null;
	automated: boolean;
	requireAgreement: boolean;
	expiresAt: string | null;
	agreementCompletedAt: string | null;
	note: string | null;
	createdBy: string | null;
	createdAt: string;
	liftedAt: string | null;
	liftedBy: string | null;
};
export type DeviceBan = { id: string; deviceId: string; createdAt: string };
export type CurrentBan = (BanRow & { state: "permanent" | "active" | "agreementPending" }) | null;

type Meta = { reasons: string[]; subReasons: string[]; requireAgreementDefault: boolean };

const DURATIONS: [string, number][] = [
	["1 Stunde", 1],
	["12 Stunden", 12],
	["1 Tag", 24],
	["3 Tage", 72],
	["7 Tage", 168],
	["30 Tage", 720],
	["90 Tage", 2160],
];

const STATE_LABEL: Record<NonNullable<CurrentBan>["state"], { label: string; tone: "danger" | "accent" }> = {
	permanent: { label: "dauerhaft gesperrt", tone: "danger" },
	active: { label: "zeitlich gesperrt", tone: "danger" },
	agreementPending: { label: "wartet auf Bestätigung der Vereinbarung", tone: "accent" },
};

function BanForm({ userId, onDone, onCancel }: { userId: string; onDone: () => void; onCancel: () => void }) {
	const [meta, setMeta] = useState<Meta | null>(null);
	const [type, setType] = useState<"timed" | "permanent">("timed");
	const [hours, setHours] = useState(24);
	const [reason, setReason] = useState("");
	const [subReason, setSubReason] = useState("");
	const [requireAgreement, setRequireAgreement] = useState(true);
	const [note, setNote] = useState("");
	const [withDevices, setWithDevices] = useState(false);
	const [error, setError] = useState<unknown>(null);
	const [busy, setBusy] = useState(false);

	useEffect(() => {
		api.get<Meta>("/bans/meta").then((m) => {
			setMeta(m);
			setRequireAgreement(m.requireAgreementDefault);
		}, setError);
	}, []);

	const submit = async () => {
		setBusy(true);
		setError(null);
		try {
			await api.post(`/users/${userId}/ban`, {
				type,
				reason: reason || null,
				subReason: subReason || null,
				...(type === "timed" ? { durationHours: hours, requireAgreement } : {}),
				note: note || null,
				banDevices: withDevices,
			});
			onDone();
		} catch (e) {
			setError(e);
		} finally {
			setBusy(false);
		}
	};

	if (!meta) return <ErrorText error={error} />;
	return (
		<div className="space-y-3 rounded-lg border border-border bg-bg p-3 text-sm">
			<div className="flex flex-wrap gap-4">
				<label className="flex items-center gap-2">
					<input type="radio" name="bantype" checked={type === "timed"} onChange={() => setType("timed")} /> Zeitlich
				</label>
				<label className="flex items-center gap-2">
					<input type="radio" name="bantype" checked={type === "permanent"} onChange={() => setType("permanent")} /> Dauerhaft
				</label>
			</div>
			{type === "timed" ? (
				<div className="flex flex-wrap items-center gap-2">
					<span className="text-muted">Dauer</span>
					<select value={hours} onChange={(e) => setHours(Number(e.target.value))}>
						{DURATIONS.map(([label, h]) => (
							<option key={h} value={h}>
								{label}
							</option>
						))}
					</select>
					<span className="text-xs text-muted">bis {formatDate(Date.now() + hours * 3_600_000)}</span>
				</div>
			) : null}
			<div className="grid gap-2 sm:grid-cols-2">
				<label className="flex flex-col gap-1">
					<span className="text-xs text-muted">Grund (sieht der User)</span>
					<select value={reason} onChange={(e) => setReason(e.target.value)}>
						<option value="">– keiner –</option>
						{meta.reasons.map((r) => (
							<option key={r}>{r}</option>
						))}
					</select>
				</label>
				<label className="flex flex-col gap-1">
					<span className="text-xs text-muted">Unterkategorie (sieht der User)</span>
					<select value={subReason} onChange={(e) => setSubReason(e.target.value)}>
						<option value="">– keine –</option>
						{meta.subReasons.map((r) => (
							<option key={r}>{r}</option>
						))}
					</select>
				</label>
			</div>
			{type === "timed" ? (
				<label className="flex items-start gap-2">
					<input type="checkbox" className="mt-0.5" checked={requireAgreement} onChange={(e) => setRequireAgreement(e.target.checked)} />
					<span>
						Nach Ablauf Richtlinien lesen und bestätigen lassen
						<span className="block text-xs text-muted">Das Konto bleibt gesperrt, bis der User in der App „Read and agree to guidelines“ bestätigt.</span>
					</span>
				</label>
			) : (
				<p className="text-xs text-muted">Dauerhafte Sperren verweigern Login und Session-Refresh (Code 27, bei Altersgründen 35).</p>
			)}
			<label className="flex items-start gap-2">
				<input type="checkbox" className="mt-0.5" checked={withDevices} onChange={(e) => setWithDevices(e.target.checked)} />
				<span>
					Geräte mitsperren
					<span className="block text-xs text-muted">Alle Geräte dieses Kontos werden gesperrt. Andere Konten, die eines davon benutzt haben oder sich später dort anmelden, bekommen dieselbe Sperre; neue Registrierungen dort scheitern mit Code 28.</span>
				</span>
			</label>
			<label className="flex flex-col gap-1">
				<span className="text-xs text-muted">Interne Notiz (nur für Admins)</span>
				<textarea className="h-16" value={note} onChange={(e) => setNote(e.target.value)} />
			</label>
			<ErrorText error={error} />
			<div className="flex justify-end gap-2">
				<Button onClick={onCancel}>Abbrechen</Button>
				<Button variant="danger" disabled={busy} onClick={() => void submit()}>
					{busy ? "Sperre…" : type === "permanent" ? "Dauerhaft sperren" : "Zeitlich sperren"}
				</Button>
			</div>
		</div>
	);
}

export function BanCard({ userId, ban, history, deviceBans = [], onChanged }: { userId: string; ban: CurrentBan; history: BanRow[]; deviceBans?: DeviceBan[]; onChanged: () => void }) {
	const [showForm, setShowForm] = useState(false);
	const [error, setError] = useState<unknown>(null);

	const lift = async () => {
		if (!window.confirm("Sperre aufheben?")) return;
		setError(null);
		try {
			await api.del(`/users/${userId}/ban`);
			onChanged();
		} catch (e) {
			setError(e);
		}
	};

	return (
		<Card
			title="Sperren"
			actions={
				<>
					{ban ? <Button onClick={() => void lift()}>Sperre aufheben</Button> : null}
					{!showForm ? (
						<Button variant="danger" onClick={() => setShowForm(true)}>
							{ban ? "Neu sperren" : "Sperren"}
						</Button>
					) : null}
				</>
			}
		>
			<div className="space-y-3 text-sm">
				{ban ? (
					<div className="space-y-1">
						<Badge tone={STATE_LABEL[ban.state].tone}>{STATE_LABEL[ban.state].label}</Badge>
						<p className="text-muted">
							{ban.reason ?? "ohne Grund"}
							{ban.subReason ? ` · ${ban.subReason}` : ""}
							{ban.expiresAt ? ` · bis ${formatDate(ban.expiresAt)}` : ""}
							{ban.type === "timed" ? (ban.requireAgreement ? " · Vereinbarung nötig" : " · ohne Vereinbarung") : ""}
						</p>
					</div>
				) : (
					<Badge tone="success">nicht gesperrt</Badge>
				)}
				{deviceBans.length ? (
					<div className="space-y-1">
						<p className="text-xs text-muted">Gesperrte Geräte dieses Kontos</p>
						{deviceBans.map((d) => (
							<div key={d.id} className="flex items-center gap-2">
								<span className="font-mono text-xs">{d.deviceId}</span>
								<span className="text-xs text-muted">{formatDate(d.createdAt)}</span>
								<Button
									className="ml-auto"
									onClick={() =>
										void api.del(`/device-bans/${d.id}`).then(onChanged, setError)
									}
								>
									Gerät freigeben
								</Button>
							</div>
						))}
					</div>
				) : null}
				{showForm ? (
					<BanForm
						userId={userId}
						onCancel={() => setShowForm(false)}
						onDone={() => {
							setShowForm(false);
							onChanged();
						}}
					/>
				) : null}
				<ErrorText error={error} />
				{history.length ? (
					<details>
						<summary className="cursor-pointer text-xs text-muted">Verlauf ({history.length})</summary>
						<ul className="mt-2 space-y-1.5">
							{history.map((b) => (
								<li key={b.id} className="rounded-md bg-bg px-2 py-1.5 text-xs">
									<span className="font-medium">{b.type === "permanent" ? "dauerhaft" : "zeitlich"}</span> · {b.reason ?? "ohne Grund"}
									{b.subReason ? ` · ${b.subReason}` : ""} · {formatDate(b.createdAt)} von {b.createdBy ?? "?"}
									{b.expiresAt ? ` · bis ${formatDate(b.expiresAt)}` : ""}
									{b.agreementCompletedAt ? ` · bestätigt ${formatDate(b.agreementCompletedAt)}` : ""}
									{b.liftedAt ? ` · aufgehoben ${formatDate(b.liftedAt)} (${b.liftedBy ?? "?"})` : ""}
									{b.note ? <span className="block text-muted">Notiz: {b.note}</span> : null}
								</li>
							))}
						</ul>
					</details>
				) : null}
			</div>
		</Card>
	);
}
