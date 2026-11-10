import { useState, type FormEvent } from "react";
import { AdminApiError, api } from "../api";
import { Button, ErrorText } from "../components/ui";

export function LoginPage({ onLoggedIn }: { onLoggedIn: () => void }) {
	const [username, setUsername] = useState("");
	const [password, setPassword] = useState("");
	const [totp, setTotp] = useState("");
	const [needTotp, setNeedTotp] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	const submit = async (e: FormEvent) => {
		e.preventDefault();
		setBusy(true);
		setError(null);
		try {
			await api.post("/login", { username, password, ...(needTotp ? { totp } : {}) });
			onLoggedIn();
		} catch (err) {
			const code = err instanceof AdminApiError ? err.body.error : null;
			if (code === "totp_required") setNeedTotp(true);
			else if (code === "invalid_totp") setError("Code ungültig.");
			else if (err instanceof AdminApiError && err.status === 429) setError("Zu viele Versuche. Bitte später erneut.");
			else setError("Benutzername oder Passwort falsch.");
		} finally {
			setBusy(false);
		}
	};

	return (
		<div className="grid min-h-full place-items-center px-4">
			<form onSubmit={submit} className="w-full max-w-sm space-y-3 rounded-xl border border-border bg-surface p-6">
				<h1 className="text-lg font-semibold">free-grind-server Admin</h1>
				<input className="w-full" placeholder="Benutzername" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} required autoFocus />
				<input className="w-full" type="password" placeholder="Passwort" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
				{needTotp ? <input className="w-full" inputMode="numeric" autoComplete="one-time-code" placeholder="6-stelliger Code" value={totp} onChange={(e) => setTotp(e.target.value.trim())} required autoFocus /> : null}
				{error ? <ErrorText error={error} /> : null}
				<Button variant="primary" type="submit" className="w-full" disabled={busy}>
					{busy ? "Anmelden…" : "Anmelden"}
				</Button>
			</form>
		</div>
	);
}
