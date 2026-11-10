import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { Button, Card, Empty, ErrorText, formatDate } from "./ui";

type DeviceBan = { id: string; deviceId: string; userId: string | null; note: string | null; createdBy: string | null; createdAt: string };
type NetworkBan = { id: string; cidr: string; note: string | null; createdBy: string | null; createdAt: string; expiresAt: string | null };

const DURATIONS: [string, number | null][] = [
	["unbegrenzt", null],
	["1 Stunde", 1],
	["1 Tag", 24],
	["7 Tage", 168],
	["30 Tage", 720],
];

/**
 * Device bans (code 28) and network bans (code 31): sign-up, sign-in and
 * session refresh from there are refused with the upstream error.
 */
export function AccessBansCard() {
	const [devices, setDevices] = useState<DeviceBan[]>([]);
	const [networks, setNetworks] = useState<NetworkBan[]>([]);
	const [deviceId, setDeviceId] = useState("");
	const [cidr, setCidr] = useState("");
	const [hours, setHours] = useState<number | null>(null);
	const [note, setNote] = useState("");
	const [error, setError] = useState<unknown>(null);
	const [busy, setBusy] = useState(false);

	const load = useCallback(async () => {
		try {
			const [d, n] = await Promise.all([api.get<{ bans: DeviceBan[] }>("/device-bans"), api.get<{ bans: NetworkBan[] }>("/network-bans")]);
			setDevices(d.bans);
			setNetworks(n.bans);
		} catch (e) {
			setError(e);
		}
	}, []);

	useEffect(() => {
		void load();
	}, [load]);

	const run = async (fn: () => Promise<unknown>) => {
		setBusy(true);
		setError(null);
		try {
			await fn();
			await load();
			return true;
		} catch (e) {
			setError(e);
			return false;
		} finally {
			setBusy(false);
		}
	};

	const addDevice = async () => {
		if (await run(() => api.post("/device-bans", { deviceId: deviceId.trim(), note: note || null }))) {
			setDeviceId("");
			setNote("");
		}
	};
	const addNetwork = async () => {
		if (await run(() => api.post("/network-bans", { cidr: cidr.trim(), durationHours: hours, note: note || null }))) {
			setCidr("");
			setNote("");
		}
	};

	return (
		<Card title="Geräte- und Netzsperren">
			<div className="space-y-4 text-sm">
				<p className="text-muted">
					Gerät sperren: Alle Konten, die das Gerät je benutzt haben, werden dauerhaft gesperrt; jedes Konto, das sich später dort anmeldet, ebenso. Neue Registrierungen
					auf dem Gerät scheitern mit Code 28. Gesperrte Netze lehnen Registrierung, Login und Session-Refresh mit Code 31 (SUSPICIOUS_NETWORK) ab.
				</p>
				<div className="grid gap-2 sm:grid-cols-2">
					<div className="flex gap-2">
						<input className="font-mono" placeholder="Geräte-ID (16 Hex)" value={deviceId} onChange={(e) => setDeviceId(e.target.value)} />
						<Button variant="danger" disabled={busy || !deviceId.trim()} onClick={() => void addDevice()}>
							Gerät sperren
						</Button>
					</div>
					<div className="flex gap-2">
						<input className="font-mono" placeholder="203.0.113.0/24" value={cidr} onChange={(e) => setCidr(e.target.value)} />
						<select value={hours ?? ""} onChange={(e) => setHours(e.target.value ? Number(e.target.value) : null)}>
							{DURATIONS.map(([label, h]) => (
								<option key={label} value={h ?? ""}>
									{label}
								</option>
							))}
						</select>
						<Button variant="danger" disabled={busy || !cidr.trim()} onClick={() => void addNetwork()}>
							Netz sperren
						</Button>
					</div>
				</div>
				<input placeholder="Interne Notiz (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
				<ErrorText error={error} />

				<div className="grid gap-4 lg:grid-cols-2">
					<div>
						<p className="mb-1 text-xs font-medium text-muted">Gesperrte Geräte ({devices.length})</p>
						{devices.length === 0 ? (
							<Empty>Keine.</Empty>
						) : (
							<ul className="divide-y divide-border">
								{devices.map((d) => (
									<li key={d.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-1.5">
										<span className="font-mono text-xs">{d.deviceId}</span>
										{d.userId ? (
											<Link className="text-xs text-accent hover:underline" to={`/users/${d.userId}`}>
												von {d.userId}
											</Link>
										) : null}
										<span className="text-xs text-muted">
											{formatDate(d.createdAt)} · {d.createdBy ?? "?"}
											{d.note ? ` · ${d.note}` : ""}
										</span>
										<Button className="ml-auto" disabled={busy} onClick={() => void run(() => api.del(`/device-bans/${d.id}`))}>
											Aufheben
										</Button>
									</li>
								))}
							</ul>
						)}
					</div>
					<div>
						<p className="mb-1 text-xs font-medium text-muted">Gesperrte Netze ({networks.length})</p>
						{networks.length === 0 ? (
							<Empty>Keine.</Empty>
						) : (
							<ul className="divide-y divide-border">
								{networks.map((n) => (
									<li key={n.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-1.5">
										<span className="font-mono text-xs">{n.cidr}</span>
										<span className="text-xs text-muted">
											{n.expiresAt ? `bis ${formatDate(n.expiresAt)}` : "unbegrenzt"} · {n.createdBy ?? "?"}
											{n.note ? ` · ${n.note}` : ""}
										</span>
										<Button className="ml-auto" disabled={busy} onClick={() => void run(() => api.del(`/network-bans/${n.id}`))}>
											Aufheben
										</Button>
									</li>
								))}
							</ul>
						)}
					</div>
				</div>
			</div>
		</Card>
	);
}
