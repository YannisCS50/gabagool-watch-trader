import { NavLink } from '@/components/NavLink';
import { HedgeTimingAnalysis } from '@/components/HedgeTimingAnalysis';
import { HedgeBreakAnalysis } from '@/components/HedgeBreakAnalysis';
import { ArrowLeft } from 'lucide-react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

export default function HedgeAnalysis() {
  return (
    <div className="min-h-screen bg-background p-6">
      <div className="max-w-7xl mx-auto space-y-6">
        <div className="flex items-center gap-4">
          <NavLink to="/live-trading" className="flex items-center gap-2 text-muted-foreground hover:text-foreground">
            <ArrowLeft className="h-4 w-4" />
            Terug naar Live Trading
          </NavLink>
        </div>
        
        <div>
          <h1 className="text-3xl font-bold">Hedge Timing & Accumulatie Analyse</h1>
          <p className="text-muted-foreground mt-2">
            Analyse van hedge timing, eerste trade timing en impact van accumulatie op winst
          </p>
        </div>

        <Tabs defaultValue="break-analysis" className="w-full">
          <TabsList className="grid w-full grid-cols-2 max-w-md">
            <TabsTrigger value="break-analysis">Hedge Break Analyse</TabsTrigger>
            <TabsTrigger value="timing">Timing Analyse</TabsTrigger>
          </TabsList>
          <TabsContent value="break-analysis" className="mt-6">
            <HedgeBreakAnalysis />
          </TabsContent>
          <TabsContent value="timing" className="mt-6">
            <HedgeTimingAnalysis />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
