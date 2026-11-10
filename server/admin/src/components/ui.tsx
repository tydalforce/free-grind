import type { ButtonHTMLAttributes, ReactNode } from "react";

export function cn(...parts: (string | false | null | undefined)[]): string {
	return parts.filter(Boolean).join(" ");
}

type Variant = "primary" | "ghost" | "danger";

export function Button({ variant = "ghost", className, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
	return (
		<button
			{...props}
			className={cn(
				"inline-flex items-center justify-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50",
				variant === "primary" && "bg-accent text-accent-contrast hover:brightness-110",
				variant === "ghost" && "border border-border text-text hover:bg-surface-2",
				variant === "danger" && "border border-danger/50 text-danger hover:bg-danger/10",
				className,
			)}
		/>
	);
}

export function Card({ title, actions, children, className }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
	return (
		<section className={cn("rounded-xl border border-border bg-surface", className)}>
			{title || actions ? (
				<header className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
					<h2 className="text-sm font-semibold">{title}</h2>
					<div className="flex flex-wrap items-center gap-2">{actions}</div>
				</header>
			) : null}
			<div className="p-4">{children}</div>
		</section>
	);
}

export function Badge({ children, tone = "muted" }: { children: ReactNode; tone?: "muted" | "accent" | "danger" | "success" | "info" }) {
	return (
		<span
			className={cn(
				"inline-flex items-center rounded-md px-1.5 py-0.5 text-[11px] font-medium",
				tone === "muted" && "bg-surface-2 text-muted",
				tone === "accent" && "bg-accent/15 text-accent",
				tone === "danger" && "bg-danger/15 text-danger",
				tone === "success" && "bg-success/15 text-success",
				tone === "info" && "bg-info/15 text-info",
			)}
		>
			{children}
		</span>
	);
}

export function ErrorText({ error }: { error: unknown }) {
	if (!error) return null;
	const message = error instanceof Error ? error.message : String(error);
	return <p className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">{message}</p>;
}

export function PageTitle({ children, hint }: { children: ReactNode; hint?: ReactNode }) {
	return (
		<div className="mb-5">
			<h1 className="text-xl font-semibold">{children}</h1>
			{hint ? <p className="mt-1 text-sm text-muted">{hint}</p> : null}
		</div>
	);
}

export function Empty({ children }: { children: ReactNode }) {
	return <p className="py-6 text-center text-sm text-muted">{children}</p>;
}

export function formatDate(value: string | number | null | undefined): string {
	if (value == null) return "–";
	const d = new Date(value);
	return Number.isNaN(d.getTime()) ? "–" : d.toLocaleString("de-DE", { dateStyle: "short", timeStyle: "short" });
}
