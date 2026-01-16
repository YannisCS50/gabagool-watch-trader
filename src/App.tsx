import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { useRealtimeLiveBot } from "@/hooks/useRealtimeLiveBot";
import Index from "./pages/Index";
import Auth from "./pages/Auth";
import GabagoolStrategyAnalysis from "./pages/GabagoolStrategyAnalysis";
import LiveTrading from "./pages/LiveTrading";
import Settings from "./pages/Settings";
import TradeAnalysis from "./pages/TradeAnalysis";
import HedgeAnalysis from "./pages/HedgeAnalysis";
import DataLogging from "./pages/DataLogging";
import Observability from "./pages/Observability";
import BotHealth from "./pages/BotHealth";
import Reconcile from "./pages/Reconcile";
import V26Dashboard from "./pages/V26Dashboard";
import V27Dashboard from "./pages/V27Dashboard";
import V28Dashboard from "./pages/V28Dashboard";
import V29Dashboard from "./pages/V29Dashboard";
import V29DashboardNew from "./pages/V29DashboardNew";
import V30Dashboard from "./pages/V30Dashboard";
import PriceLatencyAnalyzer from "./pages/PriceLatencyAnalyzer";
import NotFound from "./pages/NotFound";

const queryClient = new QueryClient();

// Global live bot connector - keeps WebSocket alive across all pages
const LiveBotConnector = () => {
  useRealtimeLiveBot();
  return null;
};

const App = () => (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <LiveBotConnector />
      <Toaster />
      <Sonner />
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<Index />} />
          <Route path="/auth" element={<Auth />} />
          <Route path="/live-trading" element={<LiveTrading />} />
          <Route path="/gabagool-analysis" element={<GabagoolStrategyAnalysis />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/trade-analysis" element={<TradeAnalysis />} />
          <Route path="/hedge-analysis" element={<HedgeAnalysis />} />
          <Route path="/data-logging" element={<DataLogging />} />
          <Route path="/observability" element={<Observability />} />
          <Route path="/bot-health" element={<BotHealth />} />
          <Route path="/reconcile" element={<Reconcile />} />
          <Route path="/v26" element={<V26Dashboard />} />
          <Route path="/v27" element={<V27Dashboard />} />
          <Route path="/v28" element={<V28Dashboard />} />
          <Route path="/v29" element={<V29Dashboard />} />
          <Route path="/v29-new" element={<V29DashboardNew />} />
          <Route path="/v30" element={<V30Dashboard />} />
          <Route path="/price-latency" element={<PriceLatencyAnalyzer />} />
          {/* ADD ALL CUSTOM ROUTES ABOVE THE CATCH-ALL "*" ROUTE */}
          <Route path="*" element={<NotFound />} />
        </Routes>
      </BrowserRouter>
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;
