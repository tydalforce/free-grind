import { useEffect, useState } from "react";
import { api } from "../api";
import { Badge, Button, Card, ErrorText, formatDate } from "./ui";

type Warning = { id: string; warning: string; note: string | null; createdBy: string | null; createdAt: string; acknowledgedAt: string | null };

/** Community-guideline warnings: shown in the app (/v2/warnings) until the user acknowledges them. */
export function WarningsCard({ userId, warnings, onChanged }: { userId: string; warnings: Warning[]; onChanged: () => void }) {
	const [codes, setCodes] = useState<string[]>([]);
	const [code, setCode] = useState("");
	const [note, setNote] = useState("");
	const [error, setError] = useState<unknown>(null);

	useEffect(() => {
		api.get<{ subReasons: string[] }>("/bans/meta").then((m) => setCodes(m.subReasons), setError);
	}, []);

	const warn = async () => {
		setError(null);
		try {
			await api.post(`/users/${userId}/warnings`, { warning: code, note: note || null });
			setCode("");
			setNote("");
			onChanged();
		} catch (e) {
			setError(e);
		}
	};

	return (
		<Card title="Verwarnungen">
			<div className="space-y-3 text-sm">
				<div className="flex flex-wrap items-center gap-2">
					<select value={code} onChange={(e) => setCode(e.target.value)}>
						<option value="">Grund wählen…</option>
						{codes.map((c) => (
							<option key={c}>{c}</option>
						))}
					</select>
					<input className="min-w-48 flex-1" placeholder="Interne Notiz (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
					<Button variant="danger" disabled={!code} onClick={() => void warn()}>
						Verwarnen
					</Button>
				</div>
				<ErrorText error={error} />
				{warnings.length ? (
					<ul className="space-y-1.5">
						{warnings.map((w) => (
							<li key={w.id} className="flex flex-wrap items-center gap-2 text-xs">
								<Badge tone={w.acknowledgedAt ? "muted" : "accent"}>{w.warning}</Badge>
								<span className="text-muted">
									{formatDate(w.createdAt)} von {w.createdBy ?? "?"}
									{w.acknowledgedAt ? ` · bestätigt ${formatDate(w.acknowledgedAt)}` : " · offen"}
								</span>
								{w.note ? <span className="text-muted">· {w.note}</span> : null}
							</li>
						))}
					</ul>
				) : (
					<p className="text-xs text-muted">Keine Verwarnungen.</p>
				)}
			</div>
		</Card>
	);
}
