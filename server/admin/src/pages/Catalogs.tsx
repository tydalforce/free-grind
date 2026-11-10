import { Download, Plus, Upload } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type Me } from "../api";
import { Badge, Button, Card, ErrorText, PageTitle, cn } from "../components/ui";

type CatalogType = "gender" | "pronoun" | "tag_category" | "tag";
type Translation = { label: string; extra: { plural?: string; possessiveText?: string } };
type Item = {
	type: CatalogType;
	itemId: number;
	key: string | null;
	parentId: number | null;
	sort: number;
	active: boolean;
	meta: Record<string, unknown>;
	translations: Record<string, Translation>;
};
type Data = { types: CatalogType[]; locales: string[]; coverage: Record<string, number>; items: Item[] };

const TYPE_LABEL: Record<CatalogType, string> = { gender: "Geschlechter", pronoun: "Pronomen", tag_category: "Tag-Kategorien", tag: "Tags" };
const EXTRA_FIELD: Partial<Record<CatalogType, { key: "plural" | "possessiveText"; label: string }>> = {
	gender: { key: "plural", label: "Plural" },
	tag_category: { key: "possessiveText", label: "Possessiv" },
};

function TranslationCell({ item, locale, canEdit, onSaved }: { item: Item; locale: string; canEdit: boolean; onSaved: () => void }) {
	const t = item.translations[locale];
	const extraField = EXTRA_FIELD[item.type];
	const [label, setLabel] = useState(t?.label ?? "");
	const [extra, setExtra] = useState(extraField ? (t?.extra[extraField.key] ?? "") : "");
	const [error, setError] = useState<unknown>(null);
	const dirty = label !== (t?.label ?? "") || (extraField ? extra !== (t?.extra[extraField.key] ?? "") : false);
	const save = async () => {
		setError(null);
		try {
			if (!label.trim()) {
				await api.del(`/catalogs/${item.type}/${item.itemId}/translations/${locale}`);
			} else {
				await api.put(`/catalogs/${item.type}/${item.itemId}/translations/${locale}`, { label, extra: extraField && extra ? { [extraField.key]: extra } : {} });
			}
			onSaved();
		} catch (e) {
			setError(e);
		}
	};
	return (
		<td className="px-2 py-1.5 align-top">
			<input className={cn("w-40", !t && "border-danger/50")} placeholder={t ? "" : "fehlt"} value={label} disabled={!canEdit} onChange={(e) => setLabel(e.target.value)} />
			{extraField ? <input className="mt-1 w-40 text-xs" placeholder={extraField.label} value={extra} disabled={!canEdit} onChange={(e) => setExtra(e.target.value)} /> : null}
			{dirty && canEdit ? (
				<Button className="mt-1 !px-2 !py-0.5 text-xs" variant="primary" onClick={() => void save()}>
					speichern
				</Button>
			) : null}
			{error ? <p className="mt-1 text-xs text-danger">{(error as Error).message}</p> : null}
		</td>
	);
}

export function CatalogsPage({ me }: { me: Me }) {
	const [data, setData] = useState<Data | null>(null);
	const [type, setType] = useState<CatalogType>("gender");
	const [extraLocale, setExtraLocale] = useState("");
	const [shownLocales, setShownLocales] = useState<string[]>([]);
	const [newLabel, setNewLabel] = useState("");
	const [newKey, setNewKey] = useState("");
	const [newParent, setNewParent] = useState<number | "">("");
	const [error, setError] = useState<unknown>(null);
	const [message, setMessage] = useState<string | null>(null);
	const fileRef = useRef<HTMLInputElement | null>(null);
	const canEdit = me.role === "owner";

	const load = useCallback(async () => {
		try {
			const d = await api.get<Data>("/catalogs");
			setData(d);
			setShownLocales((prev) => [...new Set([...d.locales, ...prev])]);
		} catch (e) {
			setError(e);
		}
	}, []);
	useEffect(() => {
		void load();
	}, [load]);

	const items = useMemo(() => (data?.items ?? []).filter((i) => i.type === type).sort((a, b) => a.sort - b.sort || a.itemId - b.itemId), [data, type]);
	const categories = useMemo(() => (data?.items ?? []).filter((i) => i.type === "tag_category"), [data]);

	const run = async (fn: () => Promise<unknown>, ok?: string) => {
		setError(null);
		setMessage(null);
		try {
			await fn();
			if (ok) setMessage(ok);
			await load();
		} catch (e) {
			setError(e);
		}
	};

	const create = () =>
		run(async () => {
			const firstLocale = shownLocales[0] ?? "en";
			await api.post(`/catalogs/${type}`, {
				...(type === "tag" ? { key: newKey.trim(), parentId: Number(newParent) } : {}),
				translations: { [firstLocale]: { label: newLabel.trim() } },
			});
			setNewLabel("");
			setNewKey("");
		}, "Eintrag angelegt.");

	const exportJson = async () => {
		const items = await api.get<unknown>("/catalogs/export");
		const blob = new Blob([JSON.stringify({ items }, null, 2)], { type: "application/json" });
		const url = URL.createObjectURL(blob);
		const a = document.createElement("a");
		a.href = url;
		a.download = "catalogs.json";
		a.click();
		URL.revokeObjectURL(url);
	};

	const importJson = (file: File) =>
		run(async () => {
			const parsed = JSON.parse(await file.text()) as { items: unknown[] };
			const res = await api.post<{ imported: number }>("/catalogs/import", parsed);
			setMessage(`${res.imported} Einträge importiert.`);
		});

	if (!data) return <ErrorText error={error} />;

	return (
		<>
			<PageTitle hint="Auswahllisten der App in allen Sprachen. Die App erhält jeweils ihre Sprache (L-Locale), fehlende Übersetzungen fallen auf die Standardsprache zurück. Einträge werden nie gelöscht, nur deaktiviert – Profile verweisen auf ihre IDs.">
				Inhalte & Sprachen
			</PageTitle>
			<ErrorText error={error} />
			{message ? <p className="mb-3 text-sm text-success">{message}</p> : null}

			<div className="mb-4 flex flex-wrap items-center gap-2">
				{data.types.map((t) => (
					<Button key={t} variant={t === type ? "primary" : "ghost"} onClick={() => setType(t)}>
						{TYPE_LABEL[t]}
					</Button>
				))}
				<span className="ml-auto flex flex-wrap items-center gap-2">
					{Object.entries(data.coverage).map(([l, pct]) => (
						<Badge key={l} tone={pct === 100 ? "success" : pct >= 50 ? "accent" : "danger"}>
							{l} {pct}%
						</Badge>
					))}
				</span>
			</div>

			<Card
				title={TYPE_LABEL[type]}
				actions={
					<>
						<input className="w-24" placeholder="z. B. fr" value={extraLocale} onChange={(e) => setExtraLocale(e.target.value.trim())} />
						<Button
							disabled={!/^[a-z]{2,3}(_[A-Z]{2})?$/.test(extraLocale)}
							onClick={() => {
								setShownLocales((prev) => [...new Set([...prev, extraLocale])]);
								setExtraLocale("");
							}}
						>
							<Plus className="h-3.5 w-3.5" /> Sprache
						</Button>
						<Button onClick={() => void exportJson()}>
							<Download className="h-3.5 w-3.5" /> Export
						</Button>
						{canEdit ? (
							<>
								<Button onClick={() => fileRef.current?.click()}>
									<Upload className="h-3.5 w-3.5" /> Import
								</Button>
								<input
									ref={fileRef}
									type="file"
									accept="application/json"
									className="hidden"
									onChange={(e) => {
										const f = e.target.files?.[0];
										if (f) void importJson(f);
										e.target.value = "";
									}}
								/>
							</>
						) : null}
					</>
				}
			>
				<div className="-mx-4 overflow-x-auto">
					<table className="w-full text-sm">
						<thead>
							<tr className="text-left text-xs text-muted">
								<th className="px-4 pb-2 font-medium">ID</th>
								{type === "tag" ? <th className="px-2 pb-2 font-medium">Key / Kategorie</th> : null}
								<th className="px-2 pb-2 font-medium">Aktiv</th>
								<th className="px-2 pb-2 font-medium">Sortierung</th>
								{shownLocales.map((l) => (
									<th key={l} className="px-2 pb-2 font-medium">
										{l}
									</th>
								))}
							</tr>
						</thead>
						<tbody>
							{items.map((item) => (
								<tr key={`${item.type}:${item.itemId}`} className={cn("border-t border-border", !item.active && "opacity-50")}>
									<td className="px-4 py-1.5 align-top font-mono text-xs">{item.itemId}</td>
									{type === "tag" ? (
										<td className="px-2 py-1.5 align-top text-xs">
											<p className="font-mono">{item.key}</p>
											<p className="text-muted">{categories.find((c) => c.itemId === item.parentId)?.translations[shownLocales[0] ?? "en"]?.label ?? item.parentId}</p>
										</td>
									) : null}
									<td className="px-2 py-1.5 align-top">
										<input type="checkbox" checked={item.active} disabled={!canEdit} onChange={(e) => void run(() => api.put(`/catalogs/${item.type}/${item.itemId}`, { active: e.target.checked }))} />
									</td>
									<td className="px-2 py-1.5 align-top">
										<input
											type="number"
											className="w-16"
											defaultValue={item.sort}
											disabled={!canEdit}
											onBlur={(e) => {
												const sort = Number(e.target.value);
												if (sort !== item.sort) void run(() => api.put(`/catalogs/${item.type}/${item.itemId}`, { sort }));
											}}
										/>
									</td>
									{shownLocales.map((l) => (
										<TranslationCell key={`${l}:${JSON.stringify(item.translations[l] ?? null)}`} item={item} locale={l} canEdit={canEdit} onSaved={() => void load()} />
									))}
								</tr>
							))}
						</tbody>
					</table>
				</div>
				{canEdit ? (
					<div className="mt-4 flex flex-wrap items-center gap-2 border-t border-border pt-4">
						<span className="text-sm text-muted">Neu ({shownLocales[0] ?? "en"}):</span>
						<input placeholder="Bezeichnung" value={newLabel} onChange={(e) => setNewLabel(e.target.value)} />
						{type === "tag" ? (
							<>
								<input placeholder="key (a-z, 0-9, -, _)" value={newKey} onChange={(e) => setNewKey(e.target.value.toLowerCase())} />
								<select value={newParent} onChange={(e) => setNewParent(e.target.value ? Number(e.target.value) : "")}>
									<option value="">Kategorie…</option>
									{categories.map((c) => (
										<option key={c.itemId} value={c.itemId}>
											{c.translations[shownLocales[0] ?? "en"]?.label ?? c.itemId}
										</option>
									))}
								</select>
							</>
						) : null}
						<Button variant="primary" disabled={!newLabel.trim() || (type === "tag" && (!newKey || newParent === ""))} onClick={() => void create()}>
							<Plus className="h-3.5 w-3.5" /> Anlegen
						</Button>
					</div>
				) : null}
			</Card>
		</>
	);
}
