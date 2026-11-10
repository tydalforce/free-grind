import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import { Button, Card, Empty, ErrorText, PageTitle, formatDate } from "../components/ui";

type Entry = { id: string; actor: string; action: string; target: string | null; before: unknown; after: unknown; createdAt: string };

export function AuditPage() {
	const [entries, setEntries] = useState<Entry[]>([]);
	const [next, setNext] = useState<string | null>(null);
	const [open, setOpen] = useState<string | null>(null);
	const [error, setError] = useState<unknown>(null);

	const load = useCallback(async (before?: string) => {
		try {
			const res = await api.get<{ entries: Entry[]; next: string | null }>(`/audit?limit=100${before ? `&before=${before}` : ""}`);
			setEntries((prev) => (before ? [...prev, ...res.entries] : res.entries));
			setNext(res.next);
		} catch (e) {
			setError(e);
		}
	}, []);

	useEffect(() => {
		void load();
	}, [load]);

	return (
		<>
			<PageTitle hint="Jede Änderung im Admin-Interface: wer, was, vorher und nachher.">Audit-Log</PageTitle>
			<ErrorText error={error} />
			<Card>
				{entries.length === 0 ? (
					<Empty>Noch keine Einträge.</Empty>
				) : (
					<ul className="divide-y divide-border text-sm">
						{entries.map((e) => (
							<li key={e.id} className="py-2">
								<button type="button" className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 text-left" onClick={() => setOpen(open === e.id ? null : e.id)}>
									<span className="text-xs text-muted">{formatDate(e.createdAt)}</span>
									<span className="font-medium">{e.actor}</span>
									<span className="font-mono text-xs text-accent">{e.action}</span>
									<span className="font-mono text-xs text-muted">{e.target}</span>
								</button>
								{open === e.id ? (
									<div className="mt-2 grid gap-2 md:grid-cols-2">
										<pre className="max-h-60 overflow-auto rounded-lg bg-bg p-2 font-mono text-[11px] text-muted">vorher: {JSON.stringify(e.before, null, 2)}</pre>
										<pre className="max-h-60 overflow-auto rounded-lg bg-bg p-2 font-mono text-[11px]">nachher: {JSON.stringify(e.after, null, 2)}</pre>
									</div>
								) : null}
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
