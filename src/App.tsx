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
          {/* ADD ALL CUSTOM ROUTES ABOVE THE CATCH-ALL "*" ROUTE */}
          <Route path="*" element={<NotFound />} />
        </Routes>
      </BrowserRouter>
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;
