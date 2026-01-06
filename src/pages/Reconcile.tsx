import { MainNav } from "@/components/MainNav";
import { ReconcileDashboard } from "@/components/ReconcileDashboard";

export default function Reconcile() {
  return (
    <div className="min-h-screen bg-background">
      <div className="border-b">
        <div className="container mx-auto px-4 py-4">
          <h1 className="text-xl font-bold">Polymarket Trading Bot</h1>
        </div>
      </div>
      <MainNav />
      
      <main className="container mx-auto px-4 py-6">
        <div className="mb-6">
          <h1 className="text-2xl font-bold">Fill Reconciliation</h1>
          <p className="text-muted-foreground">
            Vergelijk Polymarket CSV exports met bot fill logs om coverage te verifiëren
          </p>
        </div>

        <ReconcileDashboard />
      </main>
    </div>
  );
}
