import { useCallback, useEffect, useState } from "react";
import { api, type Me } from "../api";
import { Button, Card, ErrorText, PageTitle } from "../components/ui";

type Setting = { value: unknown; default: unknown; isSet?: boolean };

const LONG_TEXT = new Set(["legal.termsText", "legal.privacyText"]);
const SECRET = new Set(["smtp.password"]);

const GROUPS: { title: string; keys: [string, string][] }[] = [
	{
		title: "Registrierung & Login",
		keys: [
			["registration.mode", "Registrierung"],
			["registration.defaultRole", "Rolle für neue User"],
			["auth.autoLinkThirdPartyByEmail", "Social-Login mit E-Mail-Konto verknüpfen"],
			["client.minAppVersion", "Minimale App-Version"],
			["bans.requireAgreementDefault", "Zeitliche Sperren: Vereinbarung standardmäßig nötig"],
		],
	},
	{
		title: "Standort & Privatsphäre",
		keys: [
			["map.fuzzRadius.min", "Randomisierung min. (m)"],
			["map.fuzzRadius.max", "Randomisierung max. (m)"],
			["map.fuzzRadius.default", "Randomisierung Standard (m)"],
			["map.fuzz.rotateHours", "Versatz neu würfeln nach (h)"],
			["distance.roundMeters", "Distanzen runden auf (m)"],
			["visiting.autoDistanceKm", "„Zu Besuch“ ab Entfernung vom Heimatort (km)"],
			["visiting.relocateDays", "Gelernter Heimatort zieht um nach Aufenthalt von (Tagen)"],
		],
	},
	{
		title: "Medien",
		keys: [
			["media.url.chatTtlSec", "URL-Laufzeit Chat (s)"],
			["media.url.albumTtlSec", "URL-Laufzeit Alben (s)"],
			["media.url.expiringGraceSec", "Puffer Expiring-Medien (s)"],
			["media.retention.expiringDays", "Expiring Pics/Videos (nicht im Drawer) löschen nach (Tage, 0 = nie)"],
		],
	},
	{
		title: "Moderation",
		keys: [["banned_terms", "Verbotene Begriffe in Name und „Über mich“ (einer pro Zeile; ganze Wörter, Groß-/Kleinschreibung und Akzente egal, * am Anfang/Ende = Wortteil)"]],
	},
	{
		title: "Rechtliches",
		keys: [
			["legal.termsVersion", "Version Nutzungsbedingungen (Erhöhen = erneut zustimmen lassen)"],
			["legal.privacyVersion", "Version Datenschutzerklärung"],
			["legal.termsUrl", "URL Nutzungsbedingungen (leer = vom Server)"],
			["legal.privacyUrl", "URL Datenschutzerklärung (leer = vom Server)"],
			["legal.termsText", "Text Nutzungsbedingungen"],
			["legal.privacyText", "Text Datenschutzerklärung"],
		],
	},
	{
		title: "E-Mail (SMTP)",
		keys: [
			["smtp.host", "Server"],
			["smtp.port", "Port"],
			["smtp.secure", "TLS (Port 465)"],
			["smtp.user", "Benutzer"],
			["smtp.password", "Passwort"],
			["smtp.from", "Absender"],
		],
	},
	{
		title: "Allgemein",
		keys: [
			["locale.default", "Standardsprache"],
			["quota.timeZone", "Zeitzone für Tages-/Wochenlimits"],
			["quota.weekStartsOn", "Woche beginnt am"],
			["retention.auditLogMonths", "Audit-Log aufbewahren (Monate)"],
			["retention.securityEventsMonths", "Sicherheitsereignisse aufbewahren (Monate)"],
		],
	},
];

const ENUMS: Record<string, [string, string][]> = {
	"registration.mode": [
		["open", "offen"],
		["invite", "nur mit Einladung"],
		["closed", "geschlossen"],
	],
	"registration.defaultRole": [
		["", "Free (keine Rolle)"],
		["plus", "Plus"],
		["xtra", "Xtra"],
		["unlimited", "Unlimited"],
		["premium", "Premium"],
	],
	"quota.weekStartsOn": [
		["1", "Montag"],
		["0", "Sonntag"],
	],
};

const toLines = (v: unknown) => (Array.isArray(v) ? v.join("\n") : "");
const fromLines = (text: string) => [...new Set(text.split("\n").map((l) => l.trim()).filter(Boolean))];

function SettingRow({ k, label, setting, canEdit, onSaved }: { k: string; label: string; setting: Setting; canEdit: boolean; onSaved: () => void }) {
	const isList = Array.isArray(setting.default);
	const [draft, setDraft] = useState<unknown>(isList ? toLines(setting.value) : setting.value);
	const [error, setError] = useState<unknown>(null);
	const value = isList ? fromLines(String(draft ?? "")) : draft;
	const dirty = JSON.stringify(value) !== JSON.stringify(setting.value);
	const save = async () => {
		setError(null);
		try {
			await api.put(`/settings/${encodeURIComponent(k)}`, { value });
			onSaved();
		} catch (e) {
			setError(e);
		}
	};
	let input;
	if (typeof setting.default === "boolean") {
		input = <input type="checkbox" checked={draft === true} disabled={!canEdit} onChange={(e) => setDraft(e.target.checked)} />;
	} else if (ENUMS[k]) {
		input = (
			<select value={String(draft)} disabled={!canEdit} onChange={(e) => setDraft(typeof setting.default === "number" ? Number(e.target.value) : e.target.value)}>
				{ENUMS[k]!.map(([v, l]) => (
					<option key={v} value={v}>
						{l}
					</option>
				))}
			</select>
		);
	} else if (SECRET.has(k)) {
		input = <input type="password" className="w-56" autoComplete="new-password" placeholder={setting.isSet ? "gesetzt – neu eingeben zum Ändern" : "nicht gesetzt"} value={String(draft ?? "")} disabled={!canEdit} onChange={(e) => setDraft(e.target.value)} />;
	} else if (isList) {
		input = <textarea className="h-48 w-full font-mono text-xs" placeholder="ein Begriff pro Zeile" value={String(draft ?? "")} disabled={!canEdit} onChange={(e) => setDraft(e.target.value)} />;
	} else if (LONG_TEXT.has(k)) {
		input = <textarea className="h-40 w-full font-mono text-xs" value={String(draft ?? "")} disabled={!canEdit} onChange={(e) => setDraft(e.target.value)} />;
	} else if (typeof setting.default === "number") {
		input = <input type="number" className="w-28" value={Number(draft)} disabled={!canEdit} onChange={(e) => setDraft(Number(e.target.value))} />;
	} else {
		input = <input className="w-56" value={String(draft ?? "")} disabled={!canEdit} onChange={(e) => setDraft(e.target.value)} />;
	}
	return (
		<div className="flex flex-wrap items-center gap-3 border-t border-border py-2.5 first:border-t-0">
			<span className="min-w-56 flex-1 text-sm">{label}</span>
			{input}
			{canEdit ? (
				<Button variant="primary" disabled={!dirty} onClick={() => void save()}>
					Speichern
				</Button>
			) : null}
			{error ? (
				<div className="w-full">
					<ErrorText error={error} />
				</div>
			) : null}
		</div>
	);
}

function BannedTermsTestCard() {
	const [text, setText] = useState("");
	const [hits, setHits] = useState<string[] | null>(null);
	const [error, setError] = useState<unknown>(null);
	const test = async () => {
		setError(null);
		try {
			setHits((await api.post<{ hits: string[] }>("/moderation/banned-terms/test", { text })).hits);
		} catch (e) {
			setError(e);
		}
	};
	return (
		<Card title="Verbotene Begriffe testen">
			<div className="flex flex-col gap-2 text-sm">
				<textarea className="h-20 w-full text-sm" placeholder="Name oder „Über mich“-Text zum Prüfen (gespeicherte Liste)" value={text} onChange={(e) => { setText(e.target.value); setHits(null); }} />
				<div className="flex flex-wrap items-center gap-3">
					<Button disabled={!text.trim()} onClick={() => void test()}>
						Prüfen
					</Button>
					{hits ? (hits.length ? <span className="text-danger">Abgelehnt: {hits.join(", ")}</span> : <span className="text-success">Erlaubt</span>) : null}
				</div>
				<ErrorText error={error} />
			</div>
		</Card>
	);
}

function SmtpTestCard() {
	const [to, setTo] = useState("");
	const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
	const send = async () => {
		setResult(null);
		try {
			await api.post("/settings/smtp/test", { to });
			setResult({ ok: true, text: "Testmail verschickt." });
		} catch (e) {
			setResult({ ok: false, text: (e as Error).message });
		}
	};
	return (
		<Card title="SMTP testen">
			<div className="flex flex-wrap items-center gap-2 text-sm">
				<input type="email" placeholder="empfaenger@example.org" value={to} onChange={(e) => setTo(e.target.value)} />
				<Button disabled={!to.includes("@")} onClick={() => void send()}>
					Testmail senden
				</Button>
				{result ? <span className={result.ok ? "text-success" : "text-danger"}>{result.text}</span> : null}
			</div>
		</Card>
	);
}

function SecurityCard({ me, onMeChanged }: { me: Me; onMeChanged: () => void }) {
	const [setup, setSetup] = useState<{ secret: string; otpauthUrl: string } | null>(null);
	const [code, setCode] = useState("");
	const [pw, setPw] = useState({ current: "", next: "" });
	const [message, setMessage] = useState<string | null>(null);
	const [error, setError] = useState<unknown>(null);
	const run = async (fn: () => Promise<unknown>, ok: string) => {
		setError(null);
		setMessage(null);
		try {
			await fn();
			setMessage(ok);
		} catch (e) {
			setError(e);
		}
	};
	return (
		<Card title="Mein Konto">
			<div className="space-y-4 text-sm">
				<div>
					<p className="mb-2 font-medium">Zwei-Faktor (TOTP)</p>
					{me.totpEnabled ? (
						<p className="text-muted">Aktiv.</p>
					) : setup ? (
						<div className="space-y-2">
							<p className="text-muted">Trage diesen Schlüssel in deine Authenticator-App ein und bestätige mit einem Code:</p>
							<p className="break-all rounded-lg bg-bg p-2 font-mono text-xs">{setup.secret}</p>
							<p className="break-all text-xs text-muted">{setup.otpauthUrl}</p>
							<div className="flex gap-2">
								<input inputMode="numeric" placeholder="123456" value={code} onChange={(e) => setCode(e.target.value.trim())} />
								<Button variant="primary" onClick={() => void run(async () => { await api.post("/me/totp/enable", { secret: setup.secret, code }); setSetup(null); onMeChanged(); }, "TOTP aktiviert.")}>
									Aktivieren
								</Button>
							</div>
						</div>
					) : (
						<Button onClick={() => void api.post<{ secret: string; otpauthUrl: string }>("/me/totp/setup").then(setSetup, setError)}>Einrichten</Button>
					)}
				</div>
				<div>
					<p className="mb-2 font-medium">Passwort ändern</p>
					<div className="flex flex-wrap gap-2">
						<input type="password" placeholder="aktuelles Passwort" autoComplete="current-password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} />
						<input type="password" placeholder="neues Passwort (min. 12)" autoComplete="new-password" value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} />
						<Button disabled={pw.next.length < 12} onClick={() => void run(async () => { await api.post("/me/password", pw); setPw({ current: "", next: "" }); }, "Passwort geändert.")}>
							Ändern
						</Button>
					</div>
				</div>
				{message ? <p className="text-success">{message}</p> : null}
				<ErrorText error={error} />
			</div>
		</Card>
	);
}

export function SettingsPage({ me, onMeChanged }: { me: Me; onMeChanged: () => void }) {
	const [settings, setSettings] = useState<Record<string, Setting> | null>(null);
	const [error, setError] = useState<unknown>(null);
	const load = useCallback(() => api.get<{ settings: Record<string, Setting> }>("/settings").then((r) => setSettings(r.settings), setError), []);
	useEffect(() => {
		void load();
	}, [load]);
	const canEdit = me.role === "owner";
	return (
		<>
			<PageTitle hint="Globale Server-Werte (für alle gleich, nicht pro Rolle). Änderungen wirken sofort auf allen Instanzen.">Einstellungen</PageTitle>
			<ErrorText error={error} />
			<div className="space-y-4">
				{settings
					? GROUPS.map((g) => (
							<Card key={g.title} title={g.title}>
								{g.keys.map(([k, label]) =>
									settings[k] ? <SettingRow key={`${k}:${JSON.stringify(settings[k]!.value)}`} k={k} label={label} setting={settings[k]!} canEdit={canEdit} onSaved={() => void load()} /> : null,
								)}
							</Card>
						))
					: null}
				<BannedTermsTestCard />
				{canEdit ? <SmtpTestCard /> : null}
				<SecurityCard me={me} onMeChanged={onMeChanged} />
			</div>
		</>
	);
}
