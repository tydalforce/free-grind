import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { Badge, Button, Card, Empty, ErrorText, PageTitle, cn, formatDate } from "../components/ui";

type Status = "PENDING" | "GRANTED" | "REJECTED";
type Appeal = {
	id: string;
	userId: string;
	displayName: string | null;
	accountEmail: string | null;
	source: "app" | "web";
	userEmail: string | null;
	userDevice: string | null;
	userLocation: string | null;
	countryCode: string | null;
	userVpn: boolean | null;
	description: string | null;
	status: Status;
	decisionNote: string | null;
	decidedBy: string | null;
	decidedAt: string | null;
	createdAt: string;
	ban: { id: string; type: "timed" | "permanent"; reason: string | null; subReason: string | null; expiresAt: string | null; createdAt: string; liftedAt: string | null; note: string | null } | null;
};
type Counts = { pending: number; granted: number; rejected: number };

const FILTERS: { value: Status | "all"; label: string; count: (c: Counts) => number | null }[] = [
	{ value: "PENDING", label: "Offen", count: (c) => c.pending },
	{ value: "GRANTED", label: "Stattgegeben", count: (c) => c.granted },
	{ value: "REJECTED", label: "Abgelehnt", count: (c) => c.rejected },
	{ value: "all", label: "Alle", count: () => null },
];

const STATUS_BADGE: Record<Status, { tone: "accent" | "success" | "muted"; label: string }> = {
	PENDING: { tone: "accent", label: "offen" },
	GRANTED: { tone: "success", label: "stattgegeben" },
	REJECTED: { tone: "muted", label: "abgelehnt" },
};

function Decision({ appeal, onDone }: { appeal: Appeal; onDone: () => void }) {
	const [note, setNote] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<unknown>(null);

	const decide = async (status: "GRANTED" | "REJECTED") => {
		if (status === "GRANTED" && !window.confirm("Einspruch stattgeben? Die Sperre wird sofort aufgehoben.")) return;
		setBusy(true);
		setError(null);
		try {
			await api.post(`/appeals/${appeal.id}/decision`, { status, note: note || null });
			onDone();
		} catch (e) {
			setError(e);
		} finally {
			setBusy(false);
		}
	};

	return (
		<div className="space-y-2">
			<input placeholder="Interne Notiz zur Entscheidung (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
			<ErrorText error={error} />
			<div className="flex flex-wrap gap-2">
				<Button variant="primary" disabled={busy} onClick={() => void decide("GRANTED")}>
					Stattgeben (Sperre aufheben)
				</Button>
				<Button disabled={busy} onClick={() => void decide("REJECTED")}>
					Ablehnen
				</Button>
			</div>
		</div>
	);
}

export function AppealsPage() {
	const [status, setStatus] = useState<Status | "all">("PENDING");
	const [rows, setRows] = useState<Appeal[]>([]);
	const [counts, setCounts] = useState<Counts>({ pending: 0, granted: 0, rejected: 0 });
	const [next, setNext] = useState<string | null>(null);
	const [error, setError] = useState<unknown>(null);

	const load = useCallback(
		async (before?: string) => {
			setError(null);
			try {
				const params = new URLSearchParams({ status, limit: "50" });
				if (before) params.set("before", before);
				const res = await api.get<{ appeals: Appeal[]; counts: Counts; next: string | null }>(`/appeals?${params}`);
				setRows((prev) => (before ? [...prev, ...res.appeals] : res.appeals));
				setCounts(res.counts);
				setNext(res.next);
			} catch (e) {
				setError(e);
			}
		},
		[status],
	);

	useEffect(() => {
		void load();
	}, [load]);

	return (
		<>
			<PageTitle hint="Einsprüche gegen Sperren: aus der App (zeitliche Sperren) oder über die Webseite /ban-appeal (dauerhafte Sperren). Pro Sperre gibt es einen Einspruch; Stattgeben hebt die Sperre auf.">
				Einsprüche
			</PageTitle>
			<div className="mb-4 flex flex-wrap gap-2">
				{FILTERS.map((f) => {
					const n = f.count(counts);
					return (
						<button
							key={f.value}
							type="button"
							onClick={() => setStatus(f.value)}
							className={cn("rounded-full border px-3 py-1 text-sm", status === f.value ? "border-accent bg-surface-2 text-text" : "border-border text-muted hover:text-text")}
						>
							{f.label}
							{n != null ? <span className="ml-1.5 text-xs text-muted">{n}</span> : null}
						</button>
					);
				})}
			</div>
			<ErrorText error={error} />
			<Card>
				{rows.length === 0 ? (
					<Empty>Keine Einsprüche.</Empty>
				) : (
					<ul className="divide-y divide-border">
						{rows.map((a) => {
							const facts = [
								a.userEmail && a.userEmail !== a.accountEmail ? `Kontakt: ${a.userEmail}` : null,
								a.userDevice ? `Gerät: ${a.userDevice}` : null,
								a.userLocation || a.countryCode ? `Ort: ${[a.userLocation, a.countryCode].filter(Boolean).join(", ")}` : null,
								a.userVpn != null ? `VPN: ${a.userVpn ? "ja" : "nein"}` : null,
							].filter(Boolean);
							return (
								<li key={a.id} className="flex flex-col gap-2 py-3 text-sm">
									<div className="flex flex-wrap items-center gap-x-3 gap-y-1">
										<Badge tone={STATUS_BADGE[a.status].tone}>{STATUS_BADGE[a.status].label}</Badge>
										<span className="text-xs text-muted">
											{formatDate(a.createdAt)} · {a.source === "web" ? "Webseite" : "App"}
										</span>
										<Link className="font-medium text-accent hover:underline" to={`/users/${a.userId}`}>
											{a.displayName || a.userId}
										</Link>
										{a.accountEmail ? <span className="text-xs text-muted">{a.accountEmail}</span> : null}
									</div>
									{a.ban ? (
										<p className="text-xs text-muted">
											Sperre: {a.ban.type === "permanent" ? "dauerhaft" : `zeitlich bis ${formatDate(a.ban.expiresAt)}`} · {a.ban.reason ?? "ohne Grund"}
											{a.ban.subReason ? ` · ${a.ban.subReason}` : ""} · seit {formatDate(a.ban.createdAt)}
											{a.ban.liftedAt ? ` · aufgehoben ${formatDate(a.ban.liftedAt)}` : ""}
											{a.ban.note ? <span className="block">Notiz zur Sperre: {a.ban.note}</span> : null}
										</p>
									) : (
										<p className="text-xs text-muted">Sperre nicht mehr vorhanden.</p>
									)}
									{a.description ? <p className="whitespace-pre-wrap rounded-lg bg-bg p-2">{a.description}</p> : null}
									{facts.length ? <p className="text-xs text-muted">{facts.join(" · ")}</p> : null}
									{a.status === "PENDING" ? (
										<Decision appeal={a} onDone={() => void load()} />
									) : (
										<p className="text-xs text-muted">
											Entschieden von {a.decidedBy ?? "?"} am {formatDate(a.decidedAt)}
											{a.decisionNote ? ` · ${a.decisionNote}` : ""}
										</p>
									)}
								</li>
							);
						})}
					</ul>
				)}
				{next ? (
					<div className="mt-3 text-center">
						<Button onClick={() => void load(next)}>Ältere laden</Button>
					</div>
				) : null}
			</Card>
		</>
	);
}
