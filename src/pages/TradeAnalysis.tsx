import { TradeAnalysisTable } from '@/components/TradeAnalysisTable';
import { NavLink } from '@/components/NavLink';
import { ArrowLeft } from 'lucide-react';

export default function TradeAnalysis() {
  return (
    <div className="min-h-screen bg-background">
      <div className="container mx-auto py-6 px-4">
        <div className="mb-6">
          <NavLink to="/live-trading" className="inline-flex items-center text-muted-foreground hover:text-foreground mb-4">
            <ArrowLeft className="h-4 w-4 mr-2" />
            Back to Live Trading
          </NavLink>
          <h1 className="text-2xl font-bold">Trade Analysis</h1>
          <p className="text-muted-foreground">
            Analyze all live bot trades with export options for ChatGPT analysis
          </p>
        </div>
        
        <TradeAnalysisTable />
      </div>
    </div>
  );
}
