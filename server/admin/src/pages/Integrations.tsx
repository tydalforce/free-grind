import { useCallback, useEffect, useState } from "react";
import { api, type Me } from "../api";
import { Badge, Button, Card, ErrorText, PageTitle } from "../components/ui";

type FcmState = {
	serviceAccount: { projectId: string; clientEmail: string } | null;
	active: boolean;
};

const PACKAGE = "dev.estopia.free_grind";

function Step({ n, children }: { n: number; children: React.ReactNode }) {
	return (
		<li className="flex gap-3">
			<span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-surface-2 text-xs font-medium">{n}</span>
			<div className="min-w-0 flex-1 text-sm text-muted">{children}</div>
		</li>
	);
}

function Code({ children }: { children: string }) {
	return (
		<button type="button" title="Kopieren" onClick={() => void navigator.clipboard?.writeText(children)} className="rounded bg-bg px-1.5 py-0.5 font-mono text-xs text-text hover:bg-surface-2">
			{children}
		</button>
	);
}

function FcmGuide() {
	return (
		<Card title="Einrichtung: Firebase Cloud Messaging">
			<ol className="flex flex-col gap-3">
				<Step n={1}>
					In der <a className="text-accent hover:underline" href="https://console.firebase.google.com" target="_blank" rel="noreferrer">Firebase-Konsole</a> ein eigenes Projekt anlegen. Google Analytics wird nicht gebraucht.
				</Step>
				<Step n={2}>
					Im Projekt eine <b>Android-App</b> hinzufügen mit dem Paketnamen <Code>{PACKAGE}</Code>. Den SHA-1-Fingerabdruck braucht Push nicht. Die angebotene <span className="font-mono">google-services.json</span> herunterladen.
				</Step>
				<Step n={3}>
					Die App-Seite kommt beim Build in die App, wie die Server-Adressen. Aus der <span className="font-mono">google-services.json</span>:{" "}
					<span className="font-mono">project_info.project_id</span> → <Code>FG_FCM_PROJECT_ID</Code>, <span className="font-mono">project_info.project_number</span> →{" "}
					<Code>FG_FCM_SENDER_ID</Code>, <span className="font-mono">client[0].client_info.mobilesdk_app_id</span> → <Code>FG_FCM_APP_ID</Code>,{" "}
					<span className="font-mono">client[0].api_key[0].current_key</span> → <Code>FG_FCM_API_KEY</Code>. Ohne diese Variablen hat der Build keinen Push für Free Grind.
				</Step>
				<Step n={4}>
					Projekteinstellungen → <b>Dienstkonten</b> → „Neuen privaten Schlüssel generieren“. Die heruntergeladene JSON-Datei unten einfügen. Sie wird verschlüsselt gespeichert und nie wieder angezeigt. Sie muss zum selben Projekt gehören wie <Code>FG_FCM_PROJECT_ID</Code>.
				</Step>
				<Step n={5}>Speichern. Die App registriert ihr Gerät beim nächsten Start auf Android mit eurem Projekt.</Step>
				<Step n={6}>
					Mit „Test-Push“ an eine Profil-ID prüfen. Das Profil muss die App auf Android mindestens einmal mit diesem Server geöffnet haben.
				</Step>
			</ol>
		</Card>
	);
}

type LiveKitState = { url: string | null; apiKey: string | null; secretSet: boolean; active: boolean };

function LiveKitCard({ canEdit }: { canEdit: boolean }) {
	const [state, setState] = useState<LiveKitState | null>(null);
	const [url, setUrl] = useState("");
	const [apiKey, setApiKey] = useState("");
	const [apiSecret, setApiSecret] = useState("");
	const [error, setError] = useState<unknown>(null);
	const [test, setTest] = useState<{ ok: boolean; text: string } | null>(null);

	useEffect(() => {
		api.get<LiveKitState>("/integrations/livekit").then((s) => {
			setState(s);
			setUrl(s.url ?? "");
			setApiKey(s.apiKey ?? "");
		}, setError);
	}, []);

	const save = async () => {
		setError(null);
		setTest(null);
		try {
			const s = await api.put<LiveKitState>("/integrations/livekit", { url: url.trim(), apiKey: apiKey.trim(), ...(apiSecret ? { apiSecret } : {}) });
			setState(s);
			setApiSecret("");
		} catch (e) {
			setError(e);
		}
	};

	const runTest = async () => {
		setTest(null);
		try {
			const r = await api.post<{ ok: boolean; rooms?: number; error?: string }>("/integrations/livekit/test");
			setTest(r.ok ? { ok: true, text: `Verbindung ok (${r.rooms} aktive Räume)` } : { ok: false, text: r.error ?? "Fehler" });
		} catch (e) {
			setTest({ ok: false, text: (e as Error).message });
		}
	};

	return (
		<Card title="Videocalls (LiveKit)" actions={state ? state.active ? <Badge tone="success">aktiv</Badge> : <Badge>nicht eingerichtet</Badge> : null}>
			<div className="flex flex-col gap-3 text-sm">
				<label className="flex flex-col gap-1">
					<span className="text-muted">WebSocket-URL (für die App erreichbar)</span>
					<input value={url} placeholder="wss://rtc.example.org" disabled={!canEdit} onChange={(e) => setUrl(e.target.value)} />
				</label>
				<div className="grid gap-3 sm:grid-cols-2">
					<label className="flex flex-col gap-1">
						<span className="text-muted">API-Key</span>
						<input value={apiKey} disabled={!canEdit} onChange={(e) => setApiKey(e.target.value)} />
					</label>
					<label className="flex flex-col gap-1">
						<span className="text-muted">API-Secret {state?.secretSet ? "– gesetzt" : ""}</span>
						<input type="password" autoComplete="new-password" value={apiSecret} placeholder={state?.secretSet ? "neu eingeben zum Ändern" : ""} disabled={!canEdit} onChange={(e) => setApiSecret(e.target.value)} />
					</label>
				</div>
				<ErrorText error={error} />
				{test ? <p className={test.ok ? "text-success" : "text-danger"}>{test.text}</p> : null}
				<div className="flex flex-wrap gap-2">
					{canEdit ? (
						<Button variant="primary" onClick={() => void save()}>
							Speichern
						</Button>
					) : null}
					<Button disabled={!state?.active} onClick={() => void runTest()}>
						Verbindung testen
					</Button>
				</div>
				<ol className="mt-1 flex flex-col gap-2 border-t border-border pt-3">
					<Step n={1}>
						Lokal: <span className="font-mono">docker compose --profile calls up -d livekit</span>. Dann URL <Code>ws://&lt;LAN-IP&gt;:7880</Code>, Key <Code>devkey</Code>, Secret <Code>secret</Code>. Für Geräte im WLAN beim Start <span className="font-mono">LIVEKIT_NODE_IP=&lt;LAN-IP&gt;</span> setzen.
					</Step>
					<Step n={2}>
						Produktion: DNS <span className="font-mono">rtc.&lt;domain&gt;</span> auf den Server, TLS über den Reverse-Proxy (Port 7880), Firewall TCP 7881 und UDP 50000–60000 öffnen (Medien), eigene Keys in <span className="font-mono">livekit.yaml</span> (<span className="font-mono">livekit-server generate-keys</span>).
					</Step>
					<Step n={3}>
						Speichern. Ab dann enthält das Session-Token das Feature <Code>CreateVideoCall</Code> (alle Sessions werden neu ausgestellt) und die App zeigt den Videocall-Button. Limits pro Rolle unter „Limits & Rollen“ → Videocalls.
					</Step>
				</ol>
			</div>
		</Card>
	);
}

export function IntegrationsPage({ me }: { me: Me }) {
	const canEdit = me.role === "owner";
	const [state, setState] = useState<FcmState | null>(null);
	const [serviceAccount, setServiceAccount] = useState("");
	const [error, setError] = useState<unknown>(null);
	const [saving, setSaving] = useState(false);
	const [testId, setTestId] = useState("");
	const [testResult, setTestResult] = useState<{ token: string; ok: boolean; error: string | null; removed: boolean }[] | null>(null);
	const [testError, setTestError] = useState<unknown>(null);

	const load = useCallback(async () => {
		try {
			const s = await api.get<FcmState>("/integrations/fcm");
			setState(s);
		} catch (e) {
			setError(e);
		}
	}, []);

	useEffect(() => {
		void load();
	}, [load]);

	const save = async () => {
		setSaving(true);
		setError(null);
		try {
			const s = await api.put<FcmState>("/integrations/fcm", { serviceAccount });
			setState(s);
			setServiceAccount("");
		} catch (e) {
			setError(e);
		} finally {
			setSaving(false);
		}
	};

	const removeServiceAccount = async () => {
		setError(null);
		try {
			setState(await api.put<FcmState>("/integrations/fcm", { serviceAccount: "" }));
		} catch (e) {
			setError(e);
		}
	};

	const test = async () => {
		setTestError(null);
		setTestResult(null);
		try {
			setTestResult((await api.post<{ results: typeof testResult }>("/integrations/fcm/test", { profileId: testId.trim() })).results);
		} catch (e) {
			setTestError(e);
		}
	};

	const status = !state ? null : state.active ? <Badge tone="success">aktiv</Badge> : <Badge>nicht eingerichtet</Badge>;

	return (
		<>
			<PageTitle hint="Externe Dienste. Geheime Schlüssel werden verschlüsselt gespeichert und nur geschrieben, nie angezeigt.">Integrationen</PageTitle>
			<div className="grid gap-4 xl:grid-cols-2">
				<div className="flex flex-col gap-4">
					<Card title="Push-Benachrichtigungen (Firebase)" actions={status}>
						<div className="flex flex-col gap-4">
							<label className="flex flex-col gap-1 text-sm">
								<span className="text-muted">
									Dienstkonto (JSON){" "}
									{state?.serviceAccount ? (
										<span className="text-text">
											– gesetzt: {state.serviceAccount.clientEmail}
										</span>
									) : null}
								</span>
								<textarea
									className="h-28 w-full font-mono text-xs"
									placeholder={state?.serviceAccount ? "gesetzt – neue Datei einfügen zum Ersetzen" : "Inhalt der heruntergeladenen JSON-Datei einfügen"}
									value={serviceAccount}
									disabled={!canEdit}
									onChange={(e) => setServiceAccount(e.target.value)}
								/>
							</label>
							<ErrorText error={error} />
							{canEdit ? (
								<div className="flex flex-wrap gap-2">
									<Button variant="primary" disabled={saving || !serviceAccount.trim()} onClick={() => void save()}>
										Speichern
									</Button>
									{state?.serviceAccount ? (
										<Button variant="danger" onClick={() => void removeServiceAccount()}>
											Dienstkonto entfernen
										</Button>
									) : null}
								</div>
							) : (
								<p className="text-xs text-muted">Nur Owner können Integrationen ändern.</p>
							)}
						</div>
					</Card>
					<Card title="Test-Push">
						<div className="flex flex-col gap-2 text-sm">
							<div className="flex flex-wrap items-center gap-2">
								<input placeholder="Profil-ID" value={testId} onChange={(e) => setTestId(e.target.value)} />
								<Button disabled={!/^\d+$/.test(testId.trim()) || !state?.serviceAccount} onClick={() => void test()}>
									Senden
								</Button>
							</div>
							<ErrorText error={testError} />
							{testResult?.map((r) => (
								<div key={r.token} className="font-mono text-xs">
									{r.token}: {r.ok ? <span className="text-success">zugestellt</span> : <span className="text-danger">{r.error}{r.removed ? " (Gerät entfernt)" : ""}</span>}
								</div>
							))}
						</div>
					</Card>
				</div>
				<div className="flex flex-col gap-4">
					<LiveKitCard canEdit={canEdit} />
					<FcmGuide />
				</div>
			</div>
		</>
	);
}
