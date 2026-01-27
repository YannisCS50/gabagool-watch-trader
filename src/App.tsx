import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { useRealtimeLiveBot } from "@/hooks/useRealtimeLiveBot";
import V35Dashboard from "./pages/V35Dashboard";
import Index from "./pages/Index";
import Auth from "./pages/Auth";
import Settings from "./pages/Settings";
import BotHealth from "./pages/BotHealth";
import Observability from "./pages/Observability";
import DataLogging from "./pages/DataLogging";
import DatabaseExport from "./pages/DatabaseExport";
import GabagoolGridBacktest from "./pages/GabagoolGridBacktest";
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
          <Route path="/" element={<V35Dashboard />} />
          <Route path="/old-dashboard" element={<Index />} />
          <Route path="/auth" element={<Auth />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/bot-health" element={<BotHealth />} />
          <Route path="/observability" element={<Observability />} />
          <Route path="/data-logging" element={<DataLogging />} />
          <Route path="/database-export" element={<DatabaseExport />} />
          <Route path="/grid-backtest" element={<GabagoolGridBacktest />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </BrowserRouter>
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;
