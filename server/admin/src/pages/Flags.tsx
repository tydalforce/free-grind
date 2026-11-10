import { Lock } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { api, type Me } from "../api";
import { Badge, Button, Card, ErrorText, PageTitle } from "../components/ui";

type Rule = { conditions: Record<string, unknown>; value: string | null; variants: { value: string; weight: number }[] | null; payload: Record<string, unknown> | null };
type FlagRow = {
	key: string;
	type: "FEATURE_FLAG" | "EXPERIMENT" | "FEATURE";
	defaultValue: string;
	payload: Record<string, unknown> | null;
	description: string | null;
	enabled: boolean;
	isPublic: boolean;
	locked: boolean;
	rules: Rule[];
};

const RULE_HELP = `[
  { "conditions": { "roles": ["unlimited"] }, "value": "on" },
  { "conditions": { "geohashPrefixes": ["u33"], "percentage": 20 }, "value": "on" },
  { "conditions": {}, "variants": [{ "value": "control", "weight": 50 }, { "value": "treatment", "weight": 50 }] }
]`;

function FlagEditor({ flag, canEdit, onSaved }: { flag: FlagRow; canEdit: boolean; onSaved: () => void }) {
	const [defaultValue, setDefaultValue] = useState(flag.defaultValue);
	const [enabled, setEnabled] = useState(flag.enabled);
	const [isPublic, setIsPublic] = useState(flag.isPublic);
	const [payload, setPayload] = useState(flag.payload ? JSON.stringify(flag.payload, null, 2) : "");
	const [rules, setRules] = useState(JSON.stringify(flag.rules.map(({ conditions, value, variants, payload: p }) => ({ conditions, ...(value != null ? { value } : {}), ...(variants ? { variants } : {}), ...(p ? { payload: p } : {}) })), null, 2));
	const [error, setError] = useState<unknown>(null);
	const disabled = !canEdit || flag.locked;

	const save = async () => {
		setError(null);
		try {
			const parsedPayload = payload.trim() ? JSON.parse(payload) : null;
			const parsedRules = rules.trim() ? JSON.parse(rules) : [];
			await api.put(`/flags/${encodeURIComponent(flag.key)}`, { defaultValue, enabled, isPublic, payload: parsedPayload });
			await api.put(`/flags/${encodeURIComponent(flag.key)}/rules`, { rules: parsedRules });
			onSaved();
		} catch (e) {
			setError(e instanceof SyntaxError ? new Error(`Ungültiges JSON: ${e.message}`) : e);
		}
	};

	return (
		<div className="space-y-3 border-t border-border pt-3">
			<div className="flex flex-wrap items-center gap-4 text-sm">
				<label className="flex items-center gap-2">
					Standardwert <input className="w-32" value={defaultValue} disabled={disabled} onChange={(e) => setDefaultValue(e.target.value)} />
				</label>
				<label className="flex items-center gap-2">
					<input type="checkbox" checked={enabled} disabled={disabled} onChange={(e) => setEnabled(e.target.checked)} /> aktiv
				</label>
				<label className="flex items-center gap-2" title="Auch ohne Login über /public/v1/assignments sichtbar – keine Secrets in die Payload!">
					<input type="checkbox" checked={isPublic} disabled={disabled} onChange={(e) => setIsPublic(e.target.checked)} /> öffentlich (vor Login)
				</label>
			</div>
			<label className="block text-xs text-muted">
				Payload (JSON, optional{isPublic ? "; öffentlich sichtbar, keine Secrets" : ""})
				<textarea className="mt-1 h-24 w-full font-mono text-xs" value={payload} disabled={disabled} onChange={(e) => setPayload(e.target.value)} />
			</label>
			<label className="block text-xs text-muted">
				Regeln (JSON, erste passende gewinnt). Bedingungen: roles, userIds, geohashPrefixes, platforms, minAppVersion, minAccountAgeDays, percentage
				<textarea className="mt-1 h-40 w-full font-mono text-xs" value={rules} disabled={disabled} placeholder={RULE_HELP} onChange={(e) => setRules(e.target.value)} />
			</label>
			<ErrorText error={error} />
			{!disabled ? (
				<div className="flex justify-end">
					<Button variant="primary" onClick={() => void save()}>
						Speichern
					</Button>
				</div>
			) : null}
			{!disabled ? <p className="text-xs text-muted">Beim Speichern werden alle Sessions neu ausgestellt, damit die Änderung sofort im Token landet.</p> : null}
		</div>
	);
}

export function FlagsPage({ me }: { me: Me }) {
	const [flags, setFlags] = useState<FlagRow[]>([]);
	const [open, setOpen] = useState<string | null>(null);
	const [error, setError] = useState<unknown>(null);
	const [newKey, setNewKey] = useState("");
	const [newType, setNewType] = useState<FlagRow["type"]>("FEATURE_FLAG");
	const canEdit = me.role === "owner";

	const load = useCallback(() => api.get<{ flags: FlagRow[] }>("/flags").then((r) => setFlags(r.flags), setError), []);
	useEffect(() => {
		void load();
	}, [load]);

	const create = async () => {
		setError(null);
		try {
			await api.post("/flags", { key: newKey.trim(), type: newType, defaultValue: newType === "EXPERIMENT" ? "control" : "off" });
			setNewKey("");
			await load();
			setOpen(newKey.trim());
		} catch (e) {
			setError(e);
		}
	};

	return (
		<>
			<PageTitle hint="Assignments, Experimente und Features. Landen im Session-Token (featureFlags / experiments / features) und in /v3/assignment.">Feature-Flags</PageTitle>
			<ErrorText error={error} />
			{canEdit ? (
				<div className="mb-4 flex flex-wrap gap-2">
					<input placeholder="neuer-flag-key" value={newKey} onChange={(e) => setNewKey(e.target.value)} />
					<select value={newType} onChange={(e) => setNewType(e.target.value as FlagRow["type"])}>
						<option value="FEATURE_FLAG">Feature-Flag</option>
						<option value="EXPERIMENT">Experiment</option>
						<option value="FEATURE">Feature</option>
					</select>
					<Button disabled={!newKey.trim()} onClick={() => void create()}>
						Anlegen
					</Button>
				</div>
			) : null}
			<div className="space-y-2">
				{flags.map((f) => (
					<Card key={f.key}>
						<button type="button" className="flex w-full flex-wrap items-center gap-2 text-left" onClick={() => setOpen(open === f.key ? null : f.key)}>
							<span className="font-mono text-sm">{f.key}</span>
							<Badge>{f.type}</Badge>
							<Badge tone={f.defaultValue === "off" ? "muted" : "accent"}>{f.defaultValue}</Badge>
							{f.rules.length ? <Badge tone="info">{f.rules.length} Regeln</Badge> : null}
							{f.isPublic ? <Badge tone="info">öffentlich</Badge> : null}
							{!f.enabled ? <Badge tone="danger">inaktiv</Badge> : null}
							{f.locked ? (
								<span className="inline-flex items-center gap-1 text-xs text-muted">
									<Lock className="h-3 w-3" /> fest
								</span>
							) : null}
							<span className="ml-auto text-xs text-muted">{f.description}</span>
						</button>
						{open === f.key ? <FlagEditor flag={f} canEdit={canEdit} onSaved={() => void load()} /> : null}
					</Card>
				))}
			</div>
		</>
	);
}
