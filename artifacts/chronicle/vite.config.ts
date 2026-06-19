import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";

const rawPort = process.env.PORT;

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const basePath = process.env.BASE_PATH;

if (!basePath) {
  throw new Error(
    "BASE_PATH environment variable is required but was not provided.",
  );
}

export default defineConfig({
  base: basePath,
  define: {
    // Secrets (no VITE_ prefix) must be explicitly injected
    "import.meta.env.VITE_GEMINI_API_KEY": JSON.stringify(process.env.GEMINI_API_KEY ?? ""),
    // Regular VITE_ env vars — also injected via define so they work in all Replit environments
    "import.meta.env.VITE_GEMINI_API_KEY_2": JSON.stringify(process.env.VITE_GEMINI_API_KEY_2 ?? ""),
    "import.meta.env.VITE_MEMWAL_ACCOUNT_ID": JSON.stringify(process.env.VITE_MEMWAL_ACCOUNT_ID ?? ""),
    "import.meta.env.VITE_MEMWAL_SERVER_URL": JSON.stringify(process.env.VITE_MEMWAL_SERVER_URL ?? "https://relayer.memory.walrus.xyz"),
    "import.meta.env.VITE_MEMWAL_PRIVATE_KEY": JSON.stringify(process.env.VITE_MEMWAL_PRIVATE_KEY ?? ""),
    "import.meta.env.VITE_MEMWAL_PUBKEY": JSON.stringify(process.env.VITE_MEMWAL_PUBKEY ?? ""),
  },
  plugins: [
    react(),
    tailwindcss(),
    // NOTE: runtimeErrorOverlay() intentionally removed — its injected script
    // crashes in in-app browsers (Slush, Telegram, etc.) that run older WebViews.
    ...(process.env.NODE_ENV !== "production" &&
    process.env.REPL_ID !== undefined
      ? [
          await import("@replit/vite-plugin-cartographer").then((m) =>
            m.cartographer({
              root: path.resolve(import.meta.dirname, ".."),
            }),
          ),
          await import("@replit/vite-plugin-dev-banner").then((m) =>
            m.devBanner(),
          ),
        ]
      : []),
  ],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
      "@assets": path.resolve(import.meta.dirname, "..", "..", "attached_assets"),
    },
    dedupe: ["react", "react-dom"],
  },
  root: path.resolve(import.meta.dirname),
  build: {
    outDir: path.resolve(import.meta.dirname, "dist/public"),
    emptyOutDir: true,
  },
  server: {
    port,
    strictPort: true,
    host: "0.0.0.0",
    allowedHosts: true,
    hmr: {
      // Disable the built-in HMR error overlay — it also breaks in-app browsers
      overlay: false,
    },
    fs: {
      strict: true,
    },
  },
  preview: {
    port,
    host: "0.0.0.0",
    allowedHosts: true,
  },
});
