import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";
import "@mysten/dapp-kit/dist/index.css";

// ── Suppress known wallet-extension errors that would otherwise trigger
//    the Vite runtime-error overlay (unhandled promise rejections from
//    Suiet / Slush / wallet-standard init races).
const SUPPRESSED = [
  "wallet",
  "suiet",
  "slush",
  "wallet-standard",
  "wc@",          // WalletConnect
  "usewallet",
  "dapp-kit",
  "sui",
  "registerwallet",
];

function isSuppressed(msg: string): boolean {
  const lower = msg.toLowerCase();
  return SUPPRESSED.some((kw) => lower.includes(kw));
}

window.addEventListener("unhandledrejection", (e) => {
  const msg = e.reason instanceof Error ? e.reason.message : String(e.reason ?? "");
  if (isSuppressed(msg)) {
    e.preventDefault();
    console.warn("[Chronicle] Suppressed wallet promise rejection:", msg);
  }
});

window.addEventListener("error", (e) => {
  const msg = e.message ?? "";
  if (isSuppressed(msg)) {
    e.preventDefault();
    console.warn("[Chronicle] Suppressed wallet error:", msg);
  }
});

createRoot(document.getElementById("root")!).render(<App />);
