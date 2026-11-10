import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { Badge, Button, Card, Empty, ErrorText, PageTitle, formatDate } from "../components/ui";

type Row = { id: string; email: string | null; displayName: string | null; createdAt: string; lastSeenAt: string | null; banned: boolean; roles: string[] };

export function UsersPage() {
	const [rows, setRows] = useState<Row[]>([]);
	const [next, setNext] = useState<string | null>(null);
	const [query, setQuery] = useState("");
	const [error, setError] = useState<unknown>(null);
	const [loading, setLoading] = useState(false);

	const load = useCallback(async (q: string, before?: string) => {
		setLoading(true);
		setError(null);
		try {
			const params = new URLSearchParams({ limit: "50" });
			if (q) params.set("q", q);
			if (before) params.set("before", before);
			const res = await api.get<{ users: Row[]; next: string | null }>(`/users?${params}`);
			setRows((prev) => (before ? [...prev, ...res.users] : res.users));
			setNext(res.next);
		} catch (e) {
			setError(e);
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		void load("");
	}, [load]);

	const search = (e: FormEvent) => {
		e.preventDefault();
		void load(query.trim());
	};

	return (
		<>
			<PageTitle hint="Suche nach Profil-ID, E-Mail oder Anzeigename.">User</PageTitle>
			<form onSubmit={search} className="mb-4 flex gap-2">
				<input className="w-80" placeholder="ID, E-Mail oder Name…" value={query} onChange={(e) => setQuery(e.target.value)} />
				<Button type="submit">Suchen</Button>
			</form>
			<ErrorText error={error} />
			<Card>
				{rows.length === 0 && !loading ? (
					<Empty>Keine User gefunden.</Empty>
				) : (
					<div className="-mx-4 overflow-x-auto">
						<table className="w-full min-w-[640px] text-sm">
							<thead>
								<tr className="text-left text-xs text-muted">
									<th className="px-4 pb-2 font-medium">ID</th>
									<th className="px-2 pb-2 font-medium">Name / E-Mail</th>
									<th className="px-2 pb-2 font-medium">Rollen</th>
									<th className="px-2 pb-2 font-medium">Zuletzt aktiv</th>
									<th className="px-2 pb-2 font-medium">Registriert</th>
								</tr>
							</thead>
							<tbody>
								{rows.map((u) => (
									<tr key={u.id} className="border-t border-border hover:bg-surface-2">
										<td className="px-4 py-2 font-mono text-xs">
											<Link to={`/users/${u.id}`} className="text-accent hover:underline">
												{u.id}
											</Link>
										</td>
										<td className="px-2 py-2">
											<p>{u.displayName ?? "–"}</p>
											<p className="text-xs text-muted">{u.email ?? "–"}</p>
										</td>
										<td className="px-2 py-2">
											<div className="flex flex-wrap gap-1">
												{u.banned ? <Badge tone="danger">gesperrt</Badge> : null}
												{u.roles.length ? u.roles.map((r) => <Badge key={r} tone="accent">{r}</Badge>) : <Badge>free</Badge>}
											</div>
										</td>
										<td className="px-2 py-2 text-xs text-muted">{formatDate(u.lastSeenAt)}</td>
										<td className="px-2 py-2 text-xs text-muted">{formatDate(u.createdAt)}</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				)}
				{next ? (
					<div className="mt-3 text-center">
						<Button disabled={loading} onClick={() => void load(query.trim(), next)}>
							{loading ? "Lade…" : "Mehr laden"}
						</Button>
					</div>
				) : null}
			</Card>
		</>
	);
}
