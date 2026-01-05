import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { HealthMetrics } from '@/lib/botHealthMetrics';
import { CheckCircle, XCircle } from 'lucide-react';

interface BotHealthBehaviorProps {
  metrics: HealthMetrics;
}

export function BotHealthBehavior({ metrics }: BotHealthBehaviorProps) {
  const counters = [
    { label: 'ONE_SIDED opens', value: metrics.oneSidedOpensCount },
    { label: 'PAIRING_STARTED', value: metrics.pairingStartedCount },
    { label: 'PAIRING_TIMEOUT_REVERT', value: metrics.pairingTimeoutRevertCount },
    { label: 'HEDGE_BLOCKED_*', value: metrics.hedgeBlockedCount },
    { label: 'UNWIND_ONLY entered', value: metrics.unwindOnlyCount },
  ];

  const invariantChecks = [
    { 
      label: 'No position > 100 shares per side',
      passed: metrics.invariants.noPositionOver100PerSide,
    },
    { 
      label: 'No total > 200 shares per market',
      passed: metrics.invariants.noTotalOver200PerMarket,
    },
    { 
      label: 'No hedges placed outside PAIRING',
      passed: metrics.invariants.noHedgesOutsidePairing,
    },
    { 
      label: 'No aggressive hedge fallback (ask + X)',
      passed: metrics.invariants.noAggressiveHedgeFallback,
    },
    { 
      label: 'No trading within late-expiry window (except unwind)',
      passed: metrics.invariants.noLateExpiryTrading,
    },
  ];

  return (
    <div className="space-y-4">
      {/* Event Counters */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium">Strategy Event Counters</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
            {counters.map((counter, idx) => (
              <div key={idx} className="text-center">
                <p className="text-2xl font-bold">{counter.value}</p>
                <p className="text-xs text-muted-foreground">{counter.label}</p>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Behavior Checklist */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium">Behavior Checklist (Rev C)</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-2">
            {invariantChecks.map((check, idx) => (
              <div 
                key={idx} 
                className={`flex items-center gap-3 p-2 rounded-md ${
                  check.passed 
                    ? 'bg-green-500/10 border border-green-500/30' 
                    : 'bg-red-500/10 border border-red-500/30'
                }`}
              >
                {check.passed ? (
                  <CheckCircle className="w-5 h-5 text-green-400 shrink-0" />
                ) : (
                  <XCircle className="w-5 h-5 text-red-400 shrink-0" />
                )}
                <span className="text-sm">{check.label}</span>
                <Badge 
                  className={`ml-auto ${
                    check.passed 
                      ? 'bg-green-500/20 text-green-400' 
                      : 'bg-red-500/20 text-red-400'
                  }`}
                >
                  {check.passed ? 'PASS' : 'FAIL'}
                </Badge>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
