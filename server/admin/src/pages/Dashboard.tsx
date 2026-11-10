import { useEffect, useState } from "react";
import { api } from "../api";
import { ErrorText, PageTitle, formatDate } from "../components/ui";

type Stats = { usersEstimate: number; signups24h: number; activeNow: number; customSettings: number; generatedAt: number };

function Stat({ label, value }: { label: string; value: string | number }) {
	return (
		<div className="rounded-xl border border-border bg-surface p-4">
			<p className="text-xs text-muted">{label}</p>
			<p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
		</div>
	);
}

export function DashboardPage() {
	const [stats, setStats] = useState<Stats | null>(null);
	const [error, setError] = useState<unknown>(null);
	useEffect(() => {
		api.get<Stats>("/stats").then(setStats, setError);
	}, []);
	const nf = new Intl.NumberFormat("de-DE");
	return (
		<>
			<PageTitle hint={stats ? `Stand ${formatDate(stats.generatedAt)} (alle 30 s aktualisiert)` : undefined}>Dashboard</PageTitle>
			<ErrorText error={error} />
			{stats ? (
				<div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
					<Stat label="User (Schätzung)" value={nf.format(stats.usersEstimate)} />
					<Stat label="Neue User (24 h)" value={nf.format(stats.signups24h)} />
					<Stat label="Aktiv (15 min)" value={nf.format(stats.activeNow)} />
					<Stat label="Angepasste Einstellungen" value={stats.customSettings} />
				</div>
			) : null}
		</>
	);
}
