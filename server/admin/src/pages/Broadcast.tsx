import { useEffect, useState } from "react";
import { api, type Me } from "../api";
import { Button, Card, ErrorText, PageTitle } from "../components/ui";

type Target = { kind: "all" } | { kind: "role"; role: string } | { kind: "users"; userIds: string[] };

export function BroadcastPage({ me }: { me: Me }) {
	const [title, setTitle] = useState("");
	const [body, setBody] = useState("");
	const [mode, setMode] = useState<"all" | "role" | "users">("all");
	const [role, setRole] = useState("unlimited");
	const [ids, setIds] = useState("");
	const [estimate, setEstimate] = useState<number | null>(null);
	const [result, setResult] = useState<string | null>(null);
	const [error, setError] = useState<unknown>(null);

	const target: Target =
		mode === "role" ? { kind: "role", role } : mode === "users" ? { kind: "users", userIds: ids.split(/[\s,;]+/).filter((x) => /^\d+$/.test(x)) } : { kind: "all" };
	const targetKey = JSON.stringify(target);

	useEffect(() => {
		setEstimate(null);
		const t = JSON.parse(targetKey) as Target;
		if (t.kind === "users" && !t.userIds.length) return;
		const timer = setTimeout(() => {
			api.post<{ recipients: number }>("/broadcast/estimate", { target: t }).then(
				(r) => setEstimate(r.recipients),
				() => setEstimate(null),
			);
		}, 300);
		return () => clearTimeout(timer);
	}, [targetKey]);

	const send = async () => {
		if (!window.confirm(`Push an ${estimate ?? "?"} Accounts senden?`)) return;
		setError(null);
		setResult(null);
		try {
			const r = await api.post<{ recipients: number }>("/broadcast", { title, body, target });
			setResult(`Wird an ${r.recipients} Accounts verschickt.`);
			setTitle("");
			setBody("");
		} catch (e) {
			setError(e);
		}
	};

	return (
		<>
			<PageTitle hint="Push-Mitteilung an alle, eine Rolle oder einzelne Profile. Erreicht nur Android-Geräte mit eingerichtetem Push (Integrationen → Firebase).">Broadcast</PageTitle>
			<Card>
				<div className="flex max-w-xl flex-col gap-3 text-sm">
					<label className="flex flex-col gap-1">
						<span className="text-muted">Titel</span>
						<input maxLength={80} value={title} onChange={(e) => setTitle(e.target.value)} />
					</label>
					<label className="flex flex-col gap-1">
						<span className="text-muted">Text</span>
						<textarea className="h-24" maxLength={400} value={body} onChange={(e) => setBody(e.target.value)} />
					</label>
					<div className="flex flex-wrap items-center gap-2">
						<span className="text-muted">An:</span>
						<select value={mode} onChange={(e) => setMode(e.target.value as typeof mode)}>
							<option value="all">alle</option>
							<option value="role">Rolle</option>
							<option value="users">einzelne Profile</option>
						</select>
						{mode === "role" ? (
							<select value={role} onChange={(e) => setRole(e.target.value)}>
								{["plus", "xtra", "unlimited", "premium"].map((r) => (
									<option key={r} value={r}>
										{r}
									</option>
								))}
							</select>
						) : null}
						{estimate != null ? <span className="text-muted">{estimate} Empfänger mit Push</span> : null}
					</div>
					{mode === "users" ? (
						<textarea className="h-16 font-mono text-xs" placeholder="Profil-IDs, durch Komma oder Zeilenumbruch getrennt" value={ids} onChange={(e) => setIds(e.target.value)} />
					) : null}
					<ErrorText error={error} />
					{result ? <p className="text-success">{result}</p> : null}
					{me.role === "owner" ? (
						<div>
							<Button variant="primary" disabled={!title.trim() || !body.trim() || !estimate} onClick={() => void send()}>
								Senden
							</Button>
						</div>
					) : (
						<p className="text-xs text-muted">Nur Owner können Broadcasts senden.</p>
					)}
				</div>
			</Card>
		</>
	);
}
