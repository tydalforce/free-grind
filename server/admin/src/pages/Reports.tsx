import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { Badge, Button, Card, Empty, ErrorText, PageTitle, cn, formatDate } from "../components/ui";

type Status = "PENDING" | "RESOLVED" | "DISMISSED";
type Report = {
	id: string;
	reporterId: string;
	reporterName: string | null;
	profileId: string;
	profileName: string | null;
	reason: string | null;
	comment: string | null;
	locations: unknown;
	context: { albumInfo?: unknown; rightNowInfo?: unknown; storyInfo?: unknown } | null;
	status: Status;
	createdAt: string;
	openForProfile: number;
};
type Counts = { pending: number; resolved: number; dismissed: number };

const FILTERS: { value: Status | "all"; label: string; count: (c: Counts) => number | null }[] = [
	{ value: "PENDING", label: "Offen", count: (c) => c.pending },
	{ value: "RESOLVED", label: "Erledigt", count: (c) => c.resolved },
	{ value: "DISMISSED", label: "Verworfen", count: (c) => c.dismissed },
	{ value: "all", label: "Alle", count: () => null },
];

const STATUS_BADGE: Record<Status, { tone: "accent" | "success" | "muted"; label: string }> = {
	PENDING: { tone: "accent", label: "offen" },
	RESOLVED: { tone: "success", label: "erledigt" },
	DISMISSED: { tone: "muted", label: "verworfen" },
};

function contextLines(r: Report): string[] {
	const out: string[] = [];
	if (Array.isArray(r.locations) && r.locations.length) out.push(`Wo: ${r.locations.join(", ")}`);
	const c = r.context ?? {};
	if (c.albumInfo) out.push(`Album: ${JSON.stringify(c.albumInfo)}`);
	if (c.rightNowInfo) out.push(`Right Now: ${JSON.stringify(c.rightNowInfo)}`);
	if (c.storyInfo) out.push(`Story: ${JSON.stringify(c.storyInfo)}`);
	return out;
}

export function ReportsPage() {
	const [status, setStatus] = useState<Status | "all">("PENDING");
	const [rows, setRows] = useState<Report[]>([]);
	const [counts, setCounts] = useState<Counts>({ pending: 0, resolved: 0, dismissed: 0 });
	const [next, setNext] = useState<string | null>(null);
	const [error, setError] = useState<unknown>(null);
	const [busy, setBusy] = useState<string | null>(null);

	const load = useCallback(
		async (before?: string) => {
			setError(null);
			try {
				const params = new URLSearchParams({ status, limit: "50" });
				if (before) params.set("before", before);
				const res = await api.get<{ reports: Report[]; counts: Counts; next: string | null }>(`/reports?${params}`);
				setRows((prev) => (before ? [...prev, ...res.reports] : res.reports));
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

	const setReportStatus = async (id: string, value: Status) => {
		setBusy(id);
		try {
			await api.patch(`/reports/${id}`, { status: value });
			await load();
		} catch (e) {
			setError(e);
		} finally {
			setBusy(null);
		}
	};

	return (
		<>
			<PageTitle hint="Meldungen aus der App (Profil, Chat, Album, Right Now). Sperren geht über die User-Seite des gemeldeten Profils.">Meldungen</PageTitle>
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
					<Empty>Keine Meldungen.</Empty>
				) : (
					<ul className="divide-y divide-border">
						{rows.map((r) => (
							<li key={r.id} className="flex flex-col gap-2 py-3 text-sm">
								<div className="flex flex-wrap items-center gap-x-3 gap-y-1">
									<Badge tone={STATUS_BADGE[r.status].tone}>{STATUS_BADGE[r.status].label}</Badge>
									<span className="font-mono text-xs text-accent">{r.reason ?? "—"}</span>
									<span className="text-xs text-muted">{formatDate(r.createdAt)}</span>
								</div>
								<div className="flex flex-wrap gap-x-4 gap-y-1">
									<span>
										Gemeldet:{" "}
										<Link className="font-medium text-accent hover:underline" to={`/users/${r.profileId}`}>
											{r.profileName || r.profileId}
										</Link>
										{r.openForProfile > 1 ? <span className="ml-1.5 text-xs text-danger">{r.openForProfile} offene Meldungen</span> : null}
									</span>
									<span className="text-muted">
										von{" "}
										<Link className="hover:underline" to={`/users/${r.reporterId}`}>
											{r.reporterName || r.reporterId}
										</Link>
									</span>
								</div>
								{r.comment ? <p className="whitespace-pre-wrap rounded-lg bg-bg p-2 text-sm">{r.comment}</p> : null}
								{contextLines(r).map((line) => (
									<p key={line} className="break-all font-mono text-[11px] text-muted">
										{line}
									</p>
								))}
								{r.status === "PENDING" ? (
									<div className="flex flex-wrap gap-2">
										<Button variant="primary" disabled={busy === r.id} onClick={() => void setReportStatus(r.id, "RESOLVED")}>
											Erledigt
										</Button>
										<Button disabled={busy === r.id} onClick={() => void setReportStatus(r.id, "DISMISSED")}>
											Verwerfen
										</Button>
										<Link to={`/users/${r.profileId}`} className="self-center text-xs text-muted hover:text-text">
											Profil öffnen, um zu sperren →
										</Link>
									</div>
								) : (
									<div>
										<Button disabled={busy === r.id} onClick={() => void setReportStatus(r.id, "PENDING")}>
											Wieder öffnen
										</Button>
									</div>
								)}
							</li>
						))}
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
