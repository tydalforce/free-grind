import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Served by the API server under /admin (src/admin/routes/ui.ts).
// `bun run dev` proxies the admin API to a locally running server.
export default defineConfig({
	base: "/admin/",
	plugins: [react(), tailwindcss()],
	build: { outDir: "dist", emptyOutDir: true, sourcemap: false },
	server: {
		port: 5180,
		proxy: { "/admin/api": "http://localhost:8080" },
	},
});
