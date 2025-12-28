import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import Index from "./pages/Index";
import Strategy from "./pages/Strategy";
import Arbitrage from "./pages/Arbitrage";
import EntryAnalysis from "./pages/EntryAnalysis";
import DevGuide from "./pages/DevGuide";
import TradingStrategies from "./pages/TradingStrategies";
import RustStrategy from "./pages/RustStrategy";
import HFTBuildGuide from "./pages/HFTBuildGuide";
import EdgeAnalysis from "./pages/EdgeAnalysis";
import StrategyDeepDive from "./pages/StrategyDeepDive";
import RealTimeSignalsPage from "./pages/RealTimeSignalsPage";
import PaperTrading from "./pages/PaperTrading";
import GabagoolStrategyAnalysis from "./pages/GabagoolStrategyAnalysis";
import StrategyCode from "./pages/StrategyCode";
import PaperBotStrategy from "./pages/PaperBotStrategy";
import Wallet from "./pages/Wallet";
import LiveTrading from "./pages/LiveTrading";
import Settings from "./pages/Settings";
import TradeAnalysis from "./pages/TradeAnalysis";
import NotFound from "./pages/NotFound";

const queryClient = new QueryClient();

const App = () => (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <Toaster />
      <Sonner />
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<Index />} />
          <Route path="/strategy" element={<Strategy />} />
          <Route path="/arbitrage" element={<Arbitrage />} />
          <Route path="/entry-analysis" element={<EntryAnalysis />} />
          <Route path="/dev-guide" element={<DevGuide />} />
          <Route path="/trading-strategies" element={<TradingStrategies />} />
          <Route path="/rust-strategy" element={<RustStrategy />} />
          <Route path="/hft-build-guide" element={<HFTBuildGuide />} />
          <Route path="/edge-analysis" element={<EdgeAnalysis />} />
          <Route path="/strategy-deep-dive" element={<StrategyDeepDive />} />
          <Route path="/real-time-signals" element={<RealTimeSignalsPage />} />
          <Route path="/paper-trading" element={<PaperTrading />} />
          <Route path="/gabagool-analysis" element={<GabagoolStrategyAnalysis />} />
          <Route path="/strategy-code" element={<StrategyCode />} />
          <Route path="/paper-bot-strategy" element={<PaperBotStrategy />} />
          <Route path="/wallet" element={<Wallet />} />
          <Route path="/live-trading" element={<LiveTrading />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/trade-analysis" element={<TradeAnalysis />} />
          {/* ADD ALL CUSTOM ROUTES ABOVE THE CATCH-ALL "*" ROUTE */}
          <Route path="*" element={<NotFound />} />
        </Routes>
      </BrowserRouter>
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;
