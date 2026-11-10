import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { Badge, Button, Card, Empty, ErrorText, PageTitle, formatDate } from "../components/ui";

type Item = {
	hash: string;
	mediaId: number;
	ownerId: string;
	ownerName: string | null;
	kind: "image" | "video" | "audio";
	purpose: "profile" | "chat" | "album" | "rightnow";
	state: string;
	bytes: number;
	width: number | null;
	height: number | null;
	durationMs: number | null;
	createdAt: string;
	deletedAt: string | null;
	inProfile: boolean;
	albums: number;
	inDrawer: boolean;
};
type Storage = { total: { bytes: number; files: number }; top: { ownerId: string; name: string | null; bytes: number; files: number }[] };

const PURPOSE: Record<Item["purpose"], string> = { profile: "Profil", chat: "Chat", album: "Album", rightnow: "Right Now" };

function size(bytes: number): string {
	if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
	if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
	return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** Same-origin admin URLs: the session cookie authorizes the image request. */
const previewUrl = (hash: string) => `/admin/api/media/${hash}/preview`;
const fileUrl = (hash: string) => `/admin/api/media/${hash}/file`;

export function MediaPage() {
	const [items, setItems] = useState<Item[]>([]);
	const [next, setNext] = useState<string | null>(null);
	const [purpose, setPurpose] = useState("");
	const [kind, setKind] = useState("");
	const [owner, setOwner] = useState("");
	const [storage, setStorage] = useState<Storage | null>(null);
	const [error, setError] = useState<unknown>(null);

	const load = useCallback(
		async (before?: string) => {
			setError(null);
			try {
				const params = new URLSearchParams({ limit: "48" });
				if (purpose) params.set("purpose", purpose);
				if (kind) params.set("kind", kind);
				if (/^\d+$/.test(owner.trim())) params.set("ownerId", owner.trim());
				if (before) params.set("before", before);
				const res = await api.get<{ media: Item[]; next: string | null }>(`/media?${params}`);
				setItems((prev) => (before ? [...prev, ...res.media] : res.media));
				setNext(res.next);
			} catch (e) {
				setError(e);
			}
		},
		[purpose, kind, owner],
	);

	useEffect(() => {
		void load();
	}, [load]);
	useEffect(() => {
		api.get<Storage>("/media/storage").then(setStorage, setError);
	}, []);

	const remove = async (item: Item) => {
		const uses = [item.inProfile && "Profil", item.albums && `${item.albums} Album`, item.inDrawer && "Drawer"].filter(Boolean).join(", ");
		if (!window.confirm(`Datei endgültig löschen?${uses ? ` Sie wird auch aus ${uses} entfernt.` : ""} In Chats wird sie unbrauchbar.`)) return;
		try {
			await api.del(`/media/${item.hash}`);
			setItems((prev) => prev.filter((i) => i.hash !== item.hash));
		} catch (e) {
			setError(e);
		}
	};

	return (
		<>
			<PageTitle hint="Neueste Uploads aller User. Löschen entfernt die Datei aus Profil, Alben und Drawer und sperrt ihre Links sofort.">Medien</PageTitle>
			<div className="mb-4 flex flex-wrap items-center gap-2 text-sm">
				<select value={purpose} onChange={(e) => setPurpose(e.target.value)}>
					<option value="">Alle Bereiche</option>
					{Object.entries(PURPOSE).map(([v, l]) => (
						<option key={v} value={v}>
							{l}
						</option>
					))}
				</select>
				<select value={kind} onChange={(e) => setKind(e.target.value)}>
					<option value="">Alle Typen</option>
					<option value="image">Bilder</option>
					<option value="video">Videos</option>
					<option value="audio">Audio</option>
				</select>
				<input className="w-40" placeholder="User-ID" value={owner} onChange={(e) => setOwner(e.target.value)} />
				{storage ? (
					<span className="ml-auto text-muted">
						Gesamt: {size(storage.total.bytes)} in {storage.total.files} Dateien
					</span>
				) : null}
			</div>
			<ErrorText error={error} />
			<div className="grid gap-4 xl:grid-cols-[1fr_300px]">
				<Card>
					{items.length === 0 ? (
						<Empty>Keine Medien.</Empty>
					) : (
						<div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
							{items.map((m) => (
								<div key={m.hash} className="flex flex-col overflow-hidden rounded-lg border border-border">
									<a href={fileUrl(m.hash)} target="_blank" rel="noreferrer" className="relative block aspect-square bg-bg">
										{m.kind === "audio" ? (
											<div className="grid h-full place-items-center text-xs text-muted">Audio</div>
										) : (
											<img
												src={previewUrl(m.hash)}
												alt=""
												loading="lazy"
												className="h-full w-full object-cover"
												onError={(e) => {
													e.currentTarget.style.visibility = "hidden";
												}}
											/>
										)}
										{m.kind === "video" ? (
											<span className="absolute bottom-1 right-1">
												<Badge tone="info">Video</Badge>
											</span>
										) : null}
									</a>
									<div className="flex flex-col gap-1 p-2 text-xs">
										<div className="flex flex-wrap gap-1">
											<Badge>{PURPOSE[m.purpose]}</Badge>
											{m.inProfile ? <Badge tone="accent">im Profil</Badge> : null}
											{m.albums ? <Badge>{m.albums} Album</Badge> : null}
											{m.inDrawer ? <Badge>Drawer</Badge> : null}
											{m.state !== "ready" ? <Badge tone="danger">{m.state}</Badge> : null}
										</div>
										<Link to={`/users/${m.ownerId}`} className="truncate text-accent hover:underline">
											{m.ownerName || m.ownerId}
										</Link>
										<span className="text-muted">
											{size(m.bytes)} · {formatDate(m.createdAt)}
										</span>
										<Button variant="danger" onClick={() => void remove(m)}>
											Löschen
										</Button>
									</div>
								</div>
							))}
						</div>
					)}
					{next ? (
						<div className="mt-3 text-center">
							<Button onClick={() => void load(next)}>Ältere laden</Button>
						</div>
					) : null}
				</Card>
				<Card title="Speicher pro User">
					{storage?.top.length ? (
						<ul className="divide-y divide-border text-sm">
							{storage.top.map((t) => (
								<li key={t.ownerId} className="flex items-center gap-2 py-1.5">
									<button type="button" className="truncate text-left text-accent hover:underline" onClick={() => setOwner(t.ownerId)}>
										{t.name || t.ownerId}
									</button>
									<span className="ml-auto whitespace-nowrap text-xs text-muted">
										{size(t.bytes)} · {t.files}
									</span>
								</li>
							))}
						</ul>
					) : (
						<Empty>Noch keine Uploads.</Empty>
					)}
				</Card>
			</div>
		</>
	);
}
