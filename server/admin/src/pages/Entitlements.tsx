import { useCallback, useEffect, useMemo, useState } from "react";
import { api, type EntitlementDef, type EntitlementValue, type Me } from "../api";
import { ValueEditor, describeValue } from "../components/ValueEditor";
import { Badge, Button, Card, ErrorText, PageTitle, cn } from "../components/ui";

type Data = { registry: EntitlementDef[]; profiles: string[]; matrix: Record<string, Record<string, EntitlementValue>>; templates: string[] };
type Change = { profile: string; key: string; before: EntitlementValue | null; after: EntitlementValue | null };

const PROFILE_LABEL: Record<string, string> = { default: "Default", free: "Free", plus: "Plus", xtra: "Xtra", unlimited: "Unlimited", premium: "Premium" };
const GROUP_LABEL: Record<string, string> = { albums: "Alben", chat: "Chat & Medien", profile: "Profil", videocall: "Videocalls", rightnow: "Right Now", browse: "Browse & Interaktion" };
const TEMPLATE_LABEL: Record<string, string> = { unlimited: "Alles unbegrenzt", "restricted-free": "Eingeschränkter Free-Tier (Beispiel)" };

/** Effective value of a cell: own value, else what it inherits. */
function effective(data: Data, profile: string, def: EntitlementDef): { value: EntitlementValue; inherited: boolean } {
	const own = data.matrix[profile]?.[def.key];
	if (own !== undefined) return { value: own, inherited: false };
	const fallback = data.matrix.default?.[def.key];
	return { value: profile !== "default" && fallback !== undefined ? fallback : def.default, inherited: true };
}

export function EntitlementsPage({ me }: { me: Me }) {
	const [data, setData] = useState<Data | null>(null);
	const [error, setError] = useState<unknown>(null);
	const [query, setQuery] = useState("");
	const [editing, setEditing] = useState<{ profile: string; def: EntitlementDef; value: EntitlementValue } | null>(null);
	const [preview, setPreview] = useState<{ name: string; changes: Change[] } | null>(null);
	const canEdit = me.role === "owner";

	const load = useCallback(() => api.get<Data>("/entitlements").then(setData, setError), []);
	useEffect(() => {
		void load();
	}, [load]);

	const groups = useMemo(() => {
		if (!data) return [];
		const q = query.trim().toLowerCase();
		const filtered = data.registry.filter((d) => !q || d.key.toLowerCase().includes(q) || d.description.toLowerCase().includes(q));
		const map = new Map<string, EntitlementDef[]>();
		for (const d of filtered) map.set(d.group, [...(map.get(d.group) ?? []), d]);
		return [...map.entries()];
	}, [data, query]);

	const save = async (value: EntitlementValue | null) => {
		if (!editing) return;
		setError(null);
		try {
			await api.put(`/entitlements/${editing.profile}/${encodeURIComponent(editing.def.key)}`, { value });
			setEditing(null);
			await load();
		} catch (e) {
			setError(e);
		}
	};

	const showTemplate = async (name: string) => {
		setPreview({ name, changes: (await api.get<{ changes: Change[] }>(`/entitlements/templates/${name}/preview`)).changes });
	};
	const applyTemplate = async () => {
		if (!preview) return;
		await api.post(`/entitlements/templates/${preview.name}/apply`);
		setPreview(null);
		await load();
	};

	if (!data) return <ErrorText error={error} />;
	const defByKey = new Map(data.registry.map((d) => [d.key, d]));

	return (
		<>
			<PageTitle hint="Standard ist alles unbegrenzt. Werte gelten pro Rolle; „Free“ = User ohne Rolle. Leere Zellen erben vom Default bzw. von der Registry. User-Overrides pflegst du in der User-Ansicht. Änderungen wirken sofort.">
				Limits & Rollen
			</PageTitle>
			<ErrorText error={error} />

			<div className="mb-4 flex flex-wrap items-center gap-2">
				<input placeholder="Suchen (Key oder Beschreibung)…" className="w-72" value={query} onChange={(e) => setQuery(e.target.value)} />
				{canEdit
					? data.templates.map((t) => (
							<Button key={t} onClick={() => void showTemplate(t)}>
								Vorlage: {TEMPLATE_LABEL[t] ?? t}
							</Button>
						))
					: null}
			</div>

			{preview ? (
				<Card className="mb-4" title={`Vorschau: ${TEMPLATE_LABEL[preview.name] ?? preview.name}`} actions={
					<>
						<Button onClick={() => setPreview(null)}>Abbrechen</Button>
						<Button variant="primary" disabled={!preview.changes.length} onClick={() => void applyTemplate()}>
							{preview.changes.length} Änderungen übernehmen
						</Button>
					</>
				}>
					{preview.changes.length ? (
						<ul className="max-h-72 space-y-1 overflow-auto text-sm">
							{preview.changes.map((c) => {
								const def = defByKey.get(c.key);
								return (
									<li key={`${c.profile}:${c.key}`} className="flex flex-wrap gap-2">
										<Badge>{PROFILE_LABEL[c.profile] ?? c.profile}</Badge>
										<span className="font-mono text-xs">{c.key}</span>
										<span className="text-muted">{def ? describeValue(def, c.before ?? undefined) : "–"}</span>→
										<span>{def ? (c.after === null ? "erbt" : describeValue(def, c.after)) : "–"}</span>
									</li>
								);
							})}
						</ul>
					) : (
						<p className="text-sm text-muted">Keine Änderungen – die Vorlage ist bereits aktiv.</p>
					)}
				</Card>
			) : null}

			{editing ? (
				<Card className="mb-4" title={<>
					{editing.def.description} <span className="font-mono text-xs text-muted">{editing.def.key}</span> · {PROFILE_LABEL[editing.profile]}
				</>} actions={
					<>
						<Button onClick={() => setEditing(null)}>Abbrechen</Button>
						{data.matrix[editing.profile]?.[editing.def.key] !== undefined ? <Button onClick={() => void save(null)}>Zurücksetzen (erben)</Button> : null}
						<Button variant="primary" onClick={() => void save(editing.value)}>Speichern</Button>
					</>
				}>
					<ValueEditor def={editing.def} value={editing.value} onChange={(value) => setEditing({ ...editing, value })} />
					{editing.def.feature ? <p className="mt-3 text-xs text-muted">Steckt als Feature „{editing.def.feature}“ im Session-Token; betroffene Sessions werden beim Speichern neu ausgestellt.</p> : null}
				</Card>
			) : null}

			<div className="space-y-4">
				{groups.map(([group, defs]) => (
					<Card key={group} title={GROUP_LABEL[group] ?? group}>
						<div className="-mx-4 overflow-x-auto">
							<table className="w-full min-w-[760px] text-sm">
								<thead>
									<tr className="text-left text-xs text-muted">
										<th className="px-4 pb-2 font-medium">Limit</th>
										{data.profiles.map((p) => (
											<th key={p} className="px-2 pb-2 font-medium">{PROFILE_LABEL[p] ?? p}</th>
										))}
									</tr>
								</thead>
								<tbody>
									{defs.map((def) => (
										<tr key={def.key} className="border-t border-border">
											<td className="px-4 py-2">
												<p>{def.description}</p>
												<p className="font-mono text-[11px] text-muted">{def.key}</p>
											</td>
											{data.profiles.map((p) => {
												const { value, inherited } = effective(data, p, def);
												return (
													<td key={p} className="px-2 py-2">
														<button
															type="button"
															disabled={!canEdit}
															onClick={() => setEditing({ profile: p, def, value })}
															className={cn("rounded-md px-2 py-1 text-left text-xs", inherited ? "text-muted" : "bg-accent/10 text-accent", canEdit && "hover:bg-surface-2")}
															title={inherited ? "geerbt" : "für diese Rolle gesetzt"}
														>
															{describeValue(def, value)}
														</button>
													</td>
												);
											})}
										</tr>
									))}
								</tbody>
							</table>
						</div>
					</Card>
				))}
			</div>
		</>
	);
}
