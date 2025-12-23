import { Link } from 'react-router-dom';
import { ArrowLeft, Bot, Activity } from 'lucide-react';
import { PaperTradeDashboard } from '@/components/PaperTradeDashboard';

const PaperTrading = () => {
  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border/50 bg-card/50 backdrop-blur-xl sticky top-0 z-50">
        <div className="container mx-auto px-4 py-4">
          <div className="flex items-center gap-4">
            <Link to="/real-time-signals" className="flex items-center gap-2 text-muted-foreground hover:text-foreground transition-colors">
              <ArrowLeft className="w-4 h-4" />
              <span className="text-sm">Real-Time Signals</span>
            </Link>
            <div className="flex items-center gap-3">
              <div className="p-2 bg-purple-500/10 rounded-lg relative">
                <Bot className="w-5 h-5 text-purple-400" />
                <span className="absolute -top-1 -right-1 w-3 h-3 bg-purple-500 rounded-full animate-pulse" />
              </div>
              <div>
                <h1 className="font-bold text-lg flex items-center gap-2">
                  Paper Trade Bot
                </h1>
                <p className="text-xs text-muted-foreground flex items-center gap-2">
                  <Activity className="w-3 h-3" />
                  Simulated trading based on Rust bot logic
                </p>
              </div>
            </div>
          </div>
        </div>
      </header>

      <main className="container mx-auto px-4 py-6">
        <PaperTradeDashboard />
      </main>
    </div>
  );
};

export default PaperTrading;
