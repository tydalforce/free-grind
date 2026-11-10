import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, type EntitlementDef, type EntitlementValue, type Me } from "../api";
import { ValueEditor, describeValue } from "../components/ValueEditor";
import { BanCard, type BanRow, type CurrentBan, type DeviceBan } from "../components/BanCard";
import { WarningsCard } from "../components/WarningsCard";
import { Badge, Button, Card, Empty, ErrorText, PageTitle, formatDate } from "../components/ui";

const ROLES = ["plus", "xtra", "unlimited", "premium"] as const;

type Status = {
	key: string;
	type: string;
	unlimited: boolean;
	enabled?: boolean;
	limit: number | null;
	used: number | null;
	remaining: number | null;
	resetsAt: number | null;
	values?: string[] | null;
	source: { kind: "override" } | { kind: "role"; role: string } | { kind: "default" } | { kind: "registry" };
};

type Detail = {
	user: { id: string; email: string | null; createdAt: string; tokenVersion: number; emailVerifiedAt: string | null };
	profile: { displayName: string | null; geohash: string | null; lastSeenAt: string | null } | null;
	roles: { role: string; grantedBy: string | null; grantedAt: string; expiresAt: string | null }[];
	overrides: { key: string; value: EntitlementValue; expiresAt: string | null; updatedBy: string | null }[];
	devices: { deviceId: string; userAgent: string | null; lastSeenAt: string; revokedAt: string | null; hasPush: boolean }[];
	entitlements: Status[];
	ban: CurrentBan;
	deviceBans?: DeviceBan[];
	bans: BanRow[];
	warnings: { id: string; warning: string; note: string | null; createdBy: string | null; createdAt: string; acknowledgedAt: string | null }[];
};

function sourceLabel(s: Status["source"]): string {
	if (s.kind === "override") return "User-Override";
	if (s.kind === "role") return `Rolle ${s.role}`;
	if (s.kind === "default") return "Default";
	return "Standard";
}

function toLocalInput(iso: string | null): string {
	if (!iso) return "";
	const d = new Date(iso);
	return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

export function UserDetailPage({ me }: { me: Me }) {
	const { id = "" } = useParams();
	const [detail, setDetail] = useState<Detail | null>(null);
	const [registry, setRegistry] = useState<EntitlementDef[]>([]);
	const [claims, setClaims] = useState<unknown>(null);
	const [error, setError] = useState<unknown>(null);
	const [roleToGrant, setRoleToGrant] = useState<(typeof ROLES)[number]>("unlimited");
	const [roleExpiry, setRoleExpiry] = useState("");
	const [editing, setEditing] = useState<{ def: EntitlementDef; value: EntitlementValue; expiresAt: string } | null>(null);
	const isOwner = me.role === "owner";

	const load = useCallback(async () => {
		try {
			setDetail(await api.get<Detail>(`/users/${id}`));
		} catch (e) {
			setError(e);
		}
	}, [id]);

	useEffect(() => {
		void load();
		api.get<{ registry: EntitlementDef[] }>("/entitlements").then((r) => setRegistry(r.registry), setError);
	}, [load]);

	const defs = useMemo(() => new Map(registry.map((d) => [d.key, d])), [registry]);
	const overrides = useMemo(() => new Map((detail?.overrides ?? []).map((o) => [o.key, o])), [detail]);

	const act = async (fn: () => Promise<unknown>) => {
		setError(null);
		try {
			await fn();
			await load();
		} catch (e) {
			setError(e);
		}
	};

	if (!detail) return <ErrorText error={error} />;
	const { user, profile } = detail;

	return (
		<>
			<Link to="/users" className="text-sm text-muted hover:text-text">
				← Alle User
			</Link>
			<PageTitle hint={`Registriert ${formatDate(user.createdAt)} · zuletzt aktiv ${formatDate(profile?.lastSeenAt)} · Token-Version ${user.tokenVersion}`}>
				{profile?.displayName ?? "Ohne Namen"} <span className="font-mono text-base text-muted">#{user.id}</span>
			</PageTitle>
			<ErrorText error={error} />

			<div className="grid gap-4 lg:grid-cols-2">
				<Card title="Konto" actions={
					<>
						<Button onClick={() => void act(() => api.post(`/users/${id}/reissue`))}>Sessions neu ausstellen</Button>
					</>
				}>
					<dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
						<dt className="text-muted">E-Mail</dt>
						<dd>
							{user.email ?? "–"} {user.email ? (user.emailVerifiedAt ? <Badge tone="success">bestätigt</Badge> : <Badge>unbestätigt</Badge>) : null}
						</dd>
						<dt className="text-muted">Status</dt>
						<dd>{detail.ban ? <Badge tone="danger">gesperrt</Badge> : <Badge tone="success">aktiv</Badge>}</dd>
						<dt className="text-muted">Geohash</dt>
						<dd className="font-mono text-xs">{profile?.geohash ?? "–"}</dd>
					</dl>
				</Card>

				<Card title="Rollen">
					{detail.roles.length ? (
						<ul className="mb-3 space-y-1.5 text-sm">
							{detail.roles.map((r) => (
								<li key={r.role} className="flex flex-wrap items-center gap-2">
									<Badge tone="accent">{r.role}</Badge>
									<span className="text-xs text-muted">
										{r.expiresAt ? `bis ${formatDate(r.expiresAt)}` : "unbefristet"} · von {r.grantedBy ?? "?"}
									</span>
									{isOwner ? (
										<button type="button" className="ml-auto text-xs text-danger hover:underline" onClick={() => void act(() => api.del(`/users/${id}/roles/${r.role}`))}>
											entziehen
										</button>
									) : null}
								</li>
							))}
						</ul>
					) : (
						<p className="mb-3 text-sm text-muted">Keine Rolle (Free).</p>
					)}
					{isOwner ? (
						<div className="flex flex-wrap items-center gap-2">
							<select value={roleToGrant} onChange={(e) => setRoleToGrant(e.target.value as (typeof ROLES)[number])}>
								{ROLES.map((r) => (
									<option key={r}>{r}</option>
								))}
							</select>
							<input type="datetime-local" value={roleExpiry} onChange={(e) => setRoleExpiry(e.target.value)} title="Ablauf (leer = unbefristet)" />
							<Button
								variant="primary"
								onClick={() => void act(() => api.post(`/users/${id}/roles`, { role: roleToGrant, expiresAt: roleExpiry ? new Date(roleExpiry).toISOString() : null }))}
							>
								Vergeben
							</Button>
						</div>
					) : null}
				</Card>
			</div>

			<div className="mt-4">
				<BanCard userId={id} ban={detail.ban} history={detail.bans} deviceBans={detail.deviceBans} onChanged={() => void load()} />
			</div>
			<div className="mt-4">
				<WarningsCard userId={id} warnings={detail.warnings} onChanged={() => void load()} />
			</div>

			{editing ? (
				<Card className="mt-4" title={<>Override: {editing.def.description} <span className="font-mono text-xs text-muted">{editing.def.key}</span></>} actions={
					<>
						<Button onClick={() => setEditing(null)}>Abbrechen</Button>
						<Button
							variant="primary"
							onClick={() =>
								void act(async () => {
									await api.put(`/users/${id}/entitlements/${encodeURIComponent(editing.def.key)}`, { value: editing.value, expiresAt: editing.expiresAt ? new Date(editing.expiresAt).toISOString() : null });
									setEditing(null);
								})
							}
						>
							Speichern
						</Button>
					</>
				}>
					<ValueEditor def={editing.def} value={editing.value} onChange={(value) => setEditing({ ...editing, value })} />
					<label className="mt-3 flex items-center gap-2 text-sm text-muted">
						Gültig bis
						<input type="datetime-local" value={editing.expiresAt} onChange={(e) => setEditing({ ...editing, expiresAt: e.target.value })} />
						<span className="text-xs">(leer = dauerhaft)</span>
					</label>
				</Card>
			) : null}

			<Card className="mt-4" title="Limits (effektiv)">
				<div className="-mx-4 overflow-x-auto">
					<table className="w-full min-w-[720px] text-sm">
						<thead>
							<tr className="text-left text-xs text-muted">
								<th className="px-4 pb-2 font-medium">Limit</th>
								<th className="px-2 pb-2 font-medium">Wert</th>
								<th className="px-2 pb-2 font-medium">Verbrauch</th>
								<th className="px-2 pb-2 font-medium">Herkunft</th>
								<th className="px-2 pb-2" />
							</tr>
						</thead>
						<tbody>
							{detail.entitlements.map((s) => {
								const def = defs.get(s.key);
								const override = overrides.get(s.key);
								const value: EntitlementValue | undefined = override?.value ?? (s.type === "boolean" ? !!s.enabled : undefined);
								return (
									<tr key={s.key} className="border-t border-border">
										<td className="px-4 py-2">
											<p>{def?.description ?? s.key}</p>
											<p className="font-mono text-[11px] text-muted">{s.key}</p>
										</td>
										<td className="px-2 py-2 text-xs">
											{s.type === "boolean" ? (s.enabled ? "an" : "aus") : s.unlimited ? "∞" : def && override ? describeValue(def, override.value) : s.values ? s.values.join(", ") : (s.limit ?? "–")}
										</td>
										<td className="px-2 py-2 text-xs text-muted">
											{s.type === "quota" && s.limit != null ? (
												<>
													{s.used}/{s.limit}
													{s.resetsAt && s.remaining === 0 ? ` · frei ab ${formatDate(s.resetsAt)}` : ""}
												</>
											) : (
												"–"
											)}
										</td>
										<td className="px-2 py-2">
											<Badge tone={s.source.kind === "override" ? "accent" : s.source.kind === "role" ? "info" : "muted"}>{sourceLabel(s.source)}</Badge>
											{override?.expiresAt ? <span className="ml-1 text-[11px] text-muted">bis {formatDate(override.expiresAt)}</span> : null}
										</td>
										<td className="whitespace-nowrap px-2 py-2 text-right text-xs">
											{isOwner && def ? (
												<>
													<button
														type="button"
														className="text-accent hover:underline"
														onClick={() => setEditing({ def, value: value ?? (def.type === "boolean" ? true : { unlimited: true }), expiresAt: toLocalInput(override?.expiresAt ?? null) })}
													>
														{override ? "ändern" : "überschreiben"}
													</button>
													{override ? (
														<button type="button" className="ml-3 text-muted hover:text-text" onClick={() => void act(() => api.put(`/users/${id}/entitlements/${encodeURIComponent(s.key)}`, { value: null }))}>
															entfernen
														</button>
													) : null}
													{s.type === "quota" && s.limit != null ? (
														<button type="button" className="ml-3 text-muted hover:text-text" onClick={() => void act(() => api.post(`/users/${id}/entitlements/${encodeURIComponent(s.key)}/reset`))}>
															Verbrauch zurücksetzen
														</button>
													) : null}
												</>
											) : null}
										</td>
									</tr>
								);
							})}
						</tbody>
					</table>
				</div>
			</Card>

			<div className="mt-4 grid gap-4 lg:grid-cols-2">
				<Card
					title="Geräte"
					actions={
						detail.devices.some((d) => !d.revokedAt) ? (
							<Button
								variant="danger"
								onClick={() => {
									if (window.confirm("Auf allen Geräten abmelden?")) void api.post(`/users/${id}/sessions/revoke-all`).then(load, setError);
								}}
							>
								Überall abmelden
							</Button>
						) : null
					}
				>
					{detail.devices.length ? (
						<ul className="space-y-1.5 text-sm">
							{detail.devices.map((d) => (
								<li key={d.deviceId} className="flex flex-wrap items-center gap-2">
									<span className="font-mono text-xs">{d.deviceId}</span>
									<span className="text-xs text-muted">{d.userAgent ?? ""}</span>
									{d.hasPush ? <Badge tone="info">Push</Badge> : null}
									{d.revokedAt ? <Badge tone="danger">widerrufen</Badge> : null}
									<span className="ml-auto text-xs text-muted">{formatDate(d.lastSeenAt)}</span>
									{!d.revokedAt ? (
										<Button onClick={() => void api.post(`/users/${id}/devices/${encodeURIComponent(d.deviceId)}/revoke`).then(load, setError)}>Abmelden</Button>
									) : null}
								</li>
							))}
						</ul>
					) : (
						<Empty>Keine Geräte.</Empty>
					)}
				</Card>
				<Card title="Session-Token (Vorschau)" actions={<Button onClick={() => void api.get<{ claims: unknown }>(`/users/${id}/claims`).then((r) => setClaims(r.claims), setError)}>Laden</Button>}>
					{claims ? <pre className="max-h-80 overflow-auto rounded-lg bg-bg p-3 font-mono text-xs">{JSON.stringify(claims, null, 2)}</pre> : <p className="text-sm text-muted">Zeigt die Claims, die der User beim nächsten Refresh bekäme.</p>}
				</Card>
			</div>
		</>
	);
}
