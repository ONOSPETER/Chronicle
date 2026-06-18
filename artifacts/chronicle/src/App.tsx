import { Component, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SuiClientProvider, WalletProvider, createNetworkConfig } from "@mysten/dapp-kit";
import { Toaster } from "@/components/ui/toaster";
import Chronicle from "@/pages/Chronicle";

// SuiJsonRpcClientOptions requires both `url` and `network`
const { networkConfig } = createNetworkConfig({
  mainnet: {
    url: "https://fullnode.mainnet.sui.io:443",
    network: "mainnet" as const,
  },
  testnet: {
    url: "https://fullnode.testnet.sui.io:443",
    network: "testnet" as const,
  },
});

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1 },
    mutations: { retry: 0 },
  },
});

// ─── Error boundary: silently catches Suiet / wallet-standard init errors ─────
class WalletErrorBoundary extends Component<
  { children: ReactNode },
  { hasError: boolean }
> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { hasError: false };
  }
  static getDerivedStateFromError() {
    // Don't render an error screen — recover silently so Suiet exceptions
    // don't blank the whole page
    return { hasError: false };
  }
  componentDidCatch(err: Error) {
    console.warn("[Chronicle] Wallet provider error (suppressed):", err.message);
  }
  render() {
    return this.props.children;
  }
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <SuiClientProvider networks={networkConfig} defaultNetwork="mainnet">
        <WalletErrorBoundary>
          {/* autoConnect={false} prevents the Suiet race-condition exception
              that fires when the extension hasn't fully initialised yet */}
          <WalletProvider autoConnect={false}>
            <div className="dark">
              <Chronicle />
              <Toaster />
            </div>
          </WalletProvider>
        </WalletErrorBoundary>
      </SuiClientProvider>
    </QueryClientProvider>
  );
}
