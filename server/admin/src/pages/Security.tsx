import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, type Me } from "../api";
import { AccessBansCard } from "../components/AccessBansCard";
import { Badge, Button, Card, Empty, ErrorText, PageTitle, cn, formatDate } from "../components/ui";

type Event = { id: string; kind: string; userId: string | null; deviceId: string | null; ip: string | null; detail: unknown; createdAt: string };

const KIND_LABEL: Record<string, string> = {
	header_rejected: "Header abgelehnt",
	device_mismatch: "Fremdes Gerät",
	token_reuse: "Token wiederverwendet",
	signature_rejected: "Signatur abgelehnt",
	rate_limited: "Rate-Limit",
	login_failed: "Login fehlgeschlagen",
};

export function SecurityPage({ me }: { me: Me }) {
	const [events, setEvents] = useState<Event[]>([]);
	const [next, setNext] = useState<string | null>(null);
	const [summary, setSummary] = useState<Record<string, number>>({});
	const [kind, setKind] = useState<string>("");
	const [userFilter, setUserFilter] = useState("");
	const [error, setError] = useState<unknown>(null);
	const [rotated, setRotated] = useState<string | null>(null);

	const load = useCallback(
		async (before?: string) => {
			setError(null);
			try {
				const params = new URLSearchParams({ limit: "100" });
				if (kind) params.set("kind", kind);
				if (/^\d+$/.test(userFilter.trim())) params.set("userId", userFilter.trim());
				if (before) params.set("before", before);
				const res = await api.get<{ events: Event[]; next: string | null }>(`/security/events?${params}`);
				setEvents((prev) => (before ? [...prev, ...res.events] : res.events));
				setNext(res.next);
			} catch (e) {
				setError(e);
			}
		},
		[kind, userFilter],
	);

	useEffect(() => {
		void load();
		api.get<{ last24h: Record<string, number> }>("/security/summary").then((r) => setSummary(r.last24h), setError);
	}, [load]);

	const rotate = async (what: "jwt" | "media") => {
		const text = what === "jwt" ? "Neuen JWT-Signaturschlüssel erzeugen? Laufende Sessions bleiben gültig." : "Neuen Medien-Signaturschlüssel erzeugen? Bestehende Links laufen normal ab.";
		if (!window.confirm(text)) return;
		try {
			const r = await api.post<{ kid: string }>(`/security/rotate/${what}`);
			setRotated(`${what === "jwt" ? "JWT" : "Medien"}-Schlüssel rotiert (${r.kid})`);
		} catch (e) {
			setError(e);
		}
	};

	return (
		<>
			<PageTitle hint="Abgelehnte Anfragen, fremde Geräte, wiederverwendete Tokens. Geräte einzelner User lassen sich auf deren User-Seite abmelden.">Sicherheit</PageTitle>
			<div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6">
				{Object.entries(KIND_LABEL).map(([k, label]) => (
					<button key={k} type="button" onClick={() => setKind(kind === k ? "" : k)} className={cn("rounded-lg border p-3 text-left", kind === k ? "border-accent bg-surface-2" : "border-border hover:bg-surface-2")}>
						<div className="text-xl font-semibold">{summary[k] ?? 0}</div>
						<div className="text-xs text-muted">{label} · 24 h</div>
					</button>
				))}
			</div>
			<ErrorText error={error} />
			<div className="grid gap-4 xl:grid-cols-[1fr_320px]">
				<Card
					title="Ereignisse"
					actions={<input className="w-36" placeholder="User-ID" value={userFilter} onChange={(e) => setUserFilter(e.target.value)} />}
				>
					{events.length === 0 ? (
						<Empty>Keine Ereignisse.</Empty>
					) : (
						<ul className="divide-y divide-border text-sm">
							{events.map((e) => (
								<li key={e.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
									<span className="text-xs text-muted">{formatDate(e.createdAt)}</span>
									<Badge tone={e.kind === "token_reuse" || e.kind === "device_mismatch" ? "danger" : "muted"}>{KIND_LABEL[e.kind] ?? e.kind}</Badge>
									{e.userId ? (
										<Link className="text-accent hover:underline" to={`/users/${e.userId}`}>
											{e.userId}
										</Link>
									) : null}
									{e.ip ? <span className="font-mono text-xs">{e.ip}</span> : null}
									{e.deviceId ? <span className="font-mono text-xs text-muted">{e.deviceId}</span> : null}
									{e.detail ? <span className="w-full truncate font-mono text-[11px] text-muted">{JSON.stringify(e.detail)}</span> : null}
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
				<Card title="Signaturschlüssel">
					<div className="flex flex-col gap-3 text-sm text-muted">
						<p>Rotieren erzeugt einen neuen aktiven Schlüssel. Der vorige bleibt gültig, bis seine Tokens bzw. Links abgelaufen sind, niemand wird abgemeldet.</p>
						{me.role === "owner" ? (
							<div className="flex flex-wrap gap-2">
								<Button onClick={() => void rotate("jwt")}>JWT rotieren</Button>
								<Button onClick={() => void rotate("media")}>Medien rotieren</Button>
							</div>
						) : (
							<p className="text-xs">Nur Owner können Schlüssel rotieren.</p>
						)}
						{rotated ? <p className="text-success">{rotated}</p> : null}
					</div>
				</Card>
			</div>
			<div className="mt-4">
				<AccessBansCard />
			</div>
		</>
	);
}
