import { Button } from "@/components/ui/button";
import { Download } from "lucide-react";

const analysisContent = `================================================================================
POLYMARKET BOT ANALYSE - 5 JANUARI 2026
================================================================================

PROBLEEM:
---------
De bot opent posities op "goedkope" kanten (bijv. DOWN @ 9¢) terwijl de markt
al duidelijk de andere kant op is gegaan. Dit is verkeerd gedrag omdat:

  • 9¢ DOWN betekent dat de markt denkt dat er 91% kans is dat UP wint
  • De prijs is al $64 boven de strike ($92,876 vs $92,812)
  • Dit is praktisch weggegooid geld

================================================================================
HOE HET GEBEURT - STAP VOOR STAP:
================================================================================

1. MARKT START (t=0)
   - Bitcoin Up or Down markt opent
   - Strike price: $92,812.22
   - Beide kanten starten rond 50¢

2. PRIJS BEWEEGT (t=30s)
   - Bitcoin stijgt naar $92,876.03 (+$64)
   - UP prijs stijgt naar ~91¢
   - DOWN prijs daalt naar ~9¢
   - Delta: +0.07% (lijkt klein, maar prijzen zijn al extreem)

3. BOT LOGICA (VOOR DE FIX):
   
   A) Startup Grace Period Check:
      → "Is deze markt gestart NA de bot herstart?"
      → JA → markt is "fresh", mag traden
      
   B) Delta Check (nieuwe fix v6.3.2):
      → "Is delta > 2.5%?"
      → NEE (0.07% < 2.5%) → geen blokkade
      
   C) Opening Price Check (VOOR de fix):
      → "Is prijs < maxPrice (52¢)?"
      → 9¢ < 52¢ → JA, mag openen!
      
   D) buildEntry() functie:
      → Kiest goedkoopste kant: DOWN @ 9¢
      → Maakt order aan voor 25 shares @ 9¢ = $2.25
      
   RESULTAAT: Bot plaatst order voor DOWN @ 9¢ (91% kans op verlies)

================================================================================
DE FIXES DIE NU GEÏMPLEMENTEERD ZIJN:
================================================================================

FIX 1: MINIMUM ENTRY PRICE (v6.3.2)
------------------------------------
Locatie: local-runner/src/strategy.ts - buildEntry()

  // Opening parameters
  opening: {
    maxPrice: 0.52,    // Max 52¢
    minPrice: 0.35,    // NIEUW: Min 35¢ - nooit openen onder 35¢
    ...
  }

Als de prijs onder 35¢ is, wordt de entry geblokkeerd:
  
  if (price < STRATEGY.opening.minPrice) {
    console.log("🛡️ [v6.3.2] ENTRY BLOCKED: " + side + " @ " + price + "¢ < min 35¢");
    console.log("   → Price too low, implies 65% probability against. Skipping.");
    return null;
  }

→ 9¢ < 35¢ = GEBLOKKEERD ✓


FIX 2: STARTUP DELTA GUARD (v6.3.2)
------------------------------------
Locatie: local-runner/src/index.ts - STARTUP_GRACE_CONFIG

Bij herstart van de bot worden entries geblokkeerd als:
  - Delta > 2.5% (markt al te ver bewogen)
  - Combined mid < 92¢ (prijzen al gedisloceerd)

  const STARTUP_GRACE_CONFIG = {
    maxDeltaForEntry: 0.025,        // 2.5% delta = block
    minCombinedMidForEntry: 0.92,   // < 92¢ combined = block
  }

Dit voorkomt dat de bot na herstart in "slechte" markten stapt.


FIX 3: STARTUP GRACE PERIOD (bestaand, v6.3.1)
-----------------------------------------------
Locatie: local-runner/src/index.ts

Alleen traden op markten die STARTEN NA de bot herstart:

  const RUNNER_START_TIME_MS = Date.now();
  
  if (marketStartedBeforeBoot) {
    console.log("⏳ STARTUP GRACE: Skipping market (started before boot)");
    return; // Skip deze markt
  }

================================================================================
WAAROM 9¢ DOOR DE DELTA CHECK KWAM:
================================================================================

De delta check kijkt naar PRIJS BEWEGING:
  - Strike: $92,812.22
  - Current: $92,876.03
  - Delta: ($92,876 - $92,812) / $92,812 = 0.069% 

0.069% < 2.5% threshold → Geen blokkade via delta

MAAR de OPTION PRIJZEN zijn wel extreem:
  - UP: ~91¢ (markt denkt 91% kans UP)
  - DOWN: ~9¢ (markt denkt 9% kans DOWN)

De minPrice check (35¢) vangt dit nu wel op:
  - 9¢ < 35¢ → GEBLOKKEERD ✓

================================================================================
VOLLEDIGE EDGE FUNCTION LOGS:
================================================================================

=== runner-proxy LOGS ===

[2026-01-05T10:48:33.698Z] booted (time: 71ms)
[2026-01-05T10:48:32.657Z] [runner-proxy] Action: save-snapshot-logs
[2026-01-05T10:48:32.656Z] [runner-proxy] 🔍 DEBUG Auth check: secrets_match: true
[2026-01-05T10:48:32.168Z] [runner-proxy] Action: save-snapshot-logs
[2026-01-05T10:48:32.167Z] [runner-proxy] 🔍 DEBUG Auth check: secrets_match: true
[2026-01-05T10:48:30.928Z] [runner-proxy] Action: save-price-ticks
[2026-01-05T10:48:30.643Z] [runner-proxy] Action: save-snapshot-logs
[2026-01-05T10:48:30.473Z] [runner-proxy] Action: save-price-ticks
[2026-01-05T10:48:30.023Z] [runner-proxy] 🔄 Sync complete: 0 filled, 0 cancelled
[2026-01-05T10:48:29.917Z] [runner-proxy] Action: sync-positions
[2026-01-05T10:48:29.917Z] [runner-proxy] 🔄 Syncing 2 positions for wallet 0x2930f79c...
[2026-01-05T10:48:29.491Z] [runner-proxy] 🔄 Sync complete: 0 filled, 0 cancelled
[2026-01-05T10:48:29.435Z] [runner-proxy] 🔄 Syncing 2 positions for wallet 0x2930f79c...
[2026-01-05T10:48:29.435Z] [runner-proxy] Action: sync-positions
[2026-01-05T10:48:29.347Z] [runner-proxy] Action: save-price-ticks
[2026-01-05T10:48:29.228Z] [runner-proxy] Action: get-pending-orders
[2026-01-05T10:48:28.924Z] [runner-proxy] Action: save-price-ticks
[2026-01-05T10:48:27.445Z] [runner-proxy] ✅ Order 680c2043-e6f7-45c1-aef5-52b6725fdf4b updated to failed
[2026-01-05T10:48:27.394Z] [runner-proxy] ✅ Bot event saved: ACTION_SKIPPED
[2026-01-05T10:48:27.360Z] [runner-proxy] Action: update-order
[2026-01-05T10:48:27.344Z] [runner-proxy] Action: save-bot-event
[2026-01-05T10:48:27.221Z] [runner-proxy] ✅ Sending 1 orders to runner
[2026-01-05T10:48:27.122Z] [runner-proxy] Action: get-pending-orders
[2026-01-05T10:48:27.015Z] [runner-proxy] Action: save-price-ticks
[2026-01-05T10:48:26.897Z] [runner-proxy] Action: save-snapshot-logs


=== live-trade-realtime LOGS ===

[2026-01-05T10:48:28.725Z] [LiveBot] ⚡ HEDGE: Bypassing cooldown (hedge cooldown: 3000ms)


=== chainlink-price-collector LOGS ===

[2026-01-05T10:48:31.530Z] Listening on http://localhost:9999/
[2026-01-05T10:48:29.625Z] Found 0 markets needing prices
[2026-01-05T10:48:29.585Z] Found 0 markets needing prices
[2026-01-05T10:48:29.575Z] Generated 6 deterministic slugs for collection
[2026-01-05T10:48:29.575Z] === Starting Chainlink price collector (RPC-based) ===
[2026-01-05T10:48:29.326Z] Found 0 markets needing prices
[2026-01-05T10:48:29.269Z] Generated 6 deterministic slugs for collection
[2026-01-05T10:48:29.269Z] === Starting Chainlink price collector (RPC-based) ===
[2026-01-05T10:48:29.141Z] Found 0 markets needing prices
[2026-01-05T10:48:29.118Z] Found 0 markets needing prices
[2026-01-05T10:48:29.084Z] Generated 6 deterministic slugs for collection
[2026-01-05T10:48:29.082Z] === Starting Chainlink price collector (RPC-based) ===
[2026-01-05T10:48:28.938Z] Found 0 markets needing prices
[2026-01-05T10:48:28.902Z] Found 0 markets needing prices
[2026-01-05T10:48:28.879Z] Generated 6 deterministic slugs for collection
[2026-01-05T10:48:28.878Z] === Starting Chainlink price collector (RPC-based) ===
[2026-01-05T10:48:26.890Z] Found 0 markets needing prices

================================================================================
SAMENVATTING VAN ALLE SAFEGUARDS:
================================================================================

LAAG 1: STARTUP GRACE PERIOD (v6.3.1)
  → Alleen traden op markten die starten NA bot herstart
  
LAAG 2: STARTUP DELTA GUARD (v6.3.2)
  → Bij herstart: block entry als delta > 2.5%
  → Bij herstart: block entry als combined mid < 92¢
  
LAAG 3: MINIMUM ENTRY PRICE (v6.3.2) ← NIEUW
  → Nooit openen onder 35¢ (zou 65%+ kans op verlies betekenen)
  
LAAG 4: MAXIMUM ENTRY PRICE (bestaand)
  → Nooit openen boven 52¢ (te duur)
  
LAAG 5: v7.0.1 READINESS GATE
  → Market moet "ready" zijn (orderbook beschikbaar)
  → Timeout na 12 seconden als niet ready

================================================================================
BESTANDEN DIE GEWIJZIGD ZIJN:
================================================================================

1. local-runner/src/strategy.ts
   - Toegevoegd: opening.minPrice = 0.35
   - buildEntry() blokkeert nu prijzen < 35¢

2. local-runner/src/index.ts
   - Toegevoegd: STARTUP_GRACE_CONFIG.maxDeltaForEntry = 0.025
   - Toegevoegd: STARTUP_GRACE_CONFIG.minCombinedMidForEntry = 0.92
   - Startup grace period check nu met delta/dislocation guards

================================================================================
ACTIE VEREIST:
================================================================================

1. Pull latest code: git pull
2. Restart bot: npm start

De 9¢ DOWN order zou nu geblokkeerd worden met:
  🛡️ [v6.3.2] ENTRY BLOCKED: DOWN @ 9¢ < min 35¢
     → Price too low, implies 91% probability against. Skipping.

================================================================================
`;

export function BotAnalysisDownload() {
  const handleDownload = () => {
    const blob = new Blob([analysisContent], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'bot-analysis-2026-01-05.txt';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  return (
    <Button onClick={handleDownload} className="gap-2">
      <Download className="h-4 w-4" />
      Download Bot Analyse
    </Button>
  );
}
