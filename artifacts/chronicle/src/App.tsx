import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import Chronicle from "@/pages/Chronicle";

const queryClient = new QueryClient();

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <div className="dark">
        <Chronicle />
        <Toaster />
      </div>
    </QueryClientProvider>
  );
}

export default App;
