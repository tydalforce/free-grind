import { Flag, Gavel, Gauge, Image, Languages, LayoutDashboard, LockKeyhole, LogOut, Megaphone, Menu, Plug, ScrollText, Settings, ShieldAlert, Users, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { NavLink, Navigate, Route, Routes } from "react-router-dom";
import { api, type Me } from "./api";
import { cn } from "./components/ui";
import { AppealsPage } from "./pages/Appeals";
import { AuditPage } from "./pages/Audit";
import { CatalogsPage } from "./pages/Catalogs";
import { DashboardPage } from "./pages/Dashboard";
import { EntitlementsPage } from "./pages/Entitlements";
import { FlagsPage } from "./pages/Flags";
import { LoginPage } from "./pages/Login";
import { IntegrationsPage } from "./pages/Integrations";
import { MediaPage } from "./pages/Media";
import { SecurityPage } from "./pages/Security";
import { BroadcastPage } from "./pages/Broadcast";
import { ReportsPage } from "./pages/Reports";
import { SettingsPage } from "./pages/Settings";
import { UserDetailPage } from "./pages/UserDetail";
import { UsersPage } from "./pages/Users";

const NAV = [
	{ to: "/", label: "Dashboard", icon: LayoutDashboard },
	{ to: "/users", label: "User", icon: Users },
	{ to: "/reports", label: "Meldungen", icon: ShieldAlert },
	{ to: "/appeals", label: "Einsprüche", icon: Gavel },
	{ to: "/media", label: "Medien", icon: Image },
	{ to: "/broadcast", label: "Broadcast", icon: Megaphone },
	{ to: "/entitlements", label: "Limits & Rollen", icon: Gauge },
	{ to: "/flags", label: "Feature-Flags", icon: Flag },
	{ to: "/catalogs", label: "Inhalte & Sprachen", icon: Languages },
	{ to: "/integrations", label: "Integrationen", icon: Plug },
	{ to: "/security", label: "Sicherheit", icon: LockKeyhole },
	{ to: "/settings", label: "Einstellungen", icon: Settings },
	{ to: "/audit", label: "Audit-Log", icon: ScrollText },
];

export function App() {
	const [me, setMe] = useState<Me | null | undefined>(undefined);
	const [navOpen, setNavOpen] = useState(false);

	const loadMe = useCallback(() => {
		api.get<Me>("/me").then(setMe, () => setMe(null));
	}, []);

	useEffect(() => {
		loadMe();
		const onUnauthorized = () => setMe(null);
		window.addEventListener("admin:unauthorized", onUnauthorized);
		return () => window.removeEventListener("admin:unauthorized", onUnauthorized);
	}, [loadMe]);

	if (me === undefined) return <div className="grid h-full place-items-center text-sm text-muted">Lade…</div>;
	if (me === null) return <LoginPage onLoggedIn={loadMe} />;

	const logout = async () => {
		await api.post("/logout").catch(() => undefined);
		setMe(null);
	};

	const nav = (
		<nav className="flex flex-col gap-1">
			{NAV.map(({ to, label, icon: Icon }) => (
				<NavLink
					key={to}
					to={to}
					end={to === "/"}
					onClick={() => setNavOpen(false)}
					className={({ isActive }) => cn("flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm", isActive ? "bg-surface-2 text-text" : "text-muted hover:bg-surface-2 hover:text-text")}
				>
					<Icon className="h-4 w-4" />
					{label}
				</NavLink>
			))}
		</nav>
	);

	return (
		<div className="flex min-h-full">
			<aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col justify-between border-r border-border bg-surface p-3 md:flex">
				<div>
					<p className="mb-4 px-3 pt-2 text-sm font-semibold">
						free-grind-server <span className="text-muted">Admin</span>
					</p>
					{nav}
				</div>
				<div className="border-t border-border px-3 pt-3 text-xs text-muted">
					<p className="truncate">
						{me.username} · {me.role === "owner" ? "Owner" : "Moderator"}
					</p>
					<button type="button" onClick={logout} className="mt-2 inline-flex items-center gap-1.5 hover:text-text">
						<LogOut className="h-3.5 w-3.5" /> Abmelden
					</button>
				</div>
			</aside>

			<div className="flex min-w-0 flex-1 flex-col">
				<header className="flex items-center justify-between border-b border-border bg-surface px-4 py-3 md:hidden">
					<p className="text-sm font-semibold">Admin</p>
					<button type="button" onClick={() => setNavOpen((v) => !v)} aria-label="Menü">
						{navOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
					</button>
				</header>
				{navOpen ? (
					<div className="border-b border-border bg-surface p-3 md:hidden">
						{nav}
						<button type="button" onClick={logout} className="mt-2 inline-flex items-center gap-1.5 px-3 text-sm text-muted">
							<LogOut className="h-4 w-4" /> Abmelden
						</button>
					</div>
				) : null}
				<main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 md:px-8">
					<Routes>
						<Route path="/" element={<DashboardPage />} />
						<Route path="/users" element={<UsersPage />} />
						<Route path="/users/:id" element={<UserDetailPage me={me} />} />
						<Route path="/reports" element={<ReportsPage />} />
						<Route path="/appeals" element={<AppealsPage />} />
						<Route path="/integrations" element={<IntegrationsPage me={me} />} />
						<Route path="/media" element={<MediaPage />} />
						<Route path="/security" element={<SecurityPage me={me} />} />
						<Route path="/broadcast" element={<BroadcastPage me={me} />} />
						<Route path="/entitlements" element={<EntitlementsPage me={me} />} />
						<Route path="/flags" element={<FlagsPage me={me} />} />
						<Route path="/catalogs" element={<CatalogsPage me={me} />} />
						<Route path="/settings" element={<SettingsPage me={me} onMeChanged={loadMe} />} />
						<Route path="/audit" element={<AuditPage />} />
						<Route path="*" element={<Navigate to="/" replace />} />
					</Routes>
				</main>
			</div>
		</div>
	);
}
