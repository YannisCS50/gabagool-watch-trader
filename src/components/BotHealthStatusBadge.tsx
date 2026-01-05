import { HealthStatus, StatusReason } from '@/lib/botHealthMetrics';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { ChevronDown, AlertCircle, AlertTriangle, CheckCircle } from 'lucide-react';
import { useState } from 'react';

interface BotHealthStatusBadgeProps {
  status: HealthStatus;
  reasons: StatusReason[];
}

const STATUS_CONFIG = {
  GREEN: {
    icon: CheckCircle,
    badgeClass: 'bg-green-500/20 text-green-400 border-green-500/50 hover:bg-green-500/30',
    bgClass: 'bg-green-500/10 border-green-500/30',
    message: 'Bot handelt rustig, risico blijft binnen grenzen.',
  },
  YELLOW: {
    icon: AlertTriangle,
    badgeClass: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/50 hover:bg-yellow-500/30',
    bgClass: 'bg-yellow-500/10 border-yellow-500/30',
    message: 'Bot werkt, maar risico of fouten nemen toe; extra opletten.',
  },
  RED: {
    icon: AlertCircle,
    badgeClass: 'bg-red-500/20 text-red-400 border-red-500/50 hover:bg-red-500/30',
    bgClass: 'bg-red-500/10 border-red-500/30',
    message: 'Bot gedrag afwijkt of limieten worden overschreden; pauzeren/ingrijpen.',
  },
};

export function BotHealthStatusBadge({ status, reasons }: BotHealthStatusBadgeProps) {
  const [isOpen, setIsOpen] = useState(false);
  const config = STATUS_CONFIG[status];
  const Icon = config.icon;

  return (
    <Card className={`border ${config.bgClass}`}>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-lg">Bot Status</CardTitle>
          <Badge className={`text-xl px-4 py-2 ${config.badgeClass}`}>
            <Icon className="w-5 h-5 mr-2" />
            {status}
          </Badge>
        </div>
      </CardHeader>
      <CardContent>
        <p className="text-muted-foreground mb-4">{config.message}</p>
        
        <Collapsible open={isOpen} onOpenChange={setIsOpen}>
          <CollapsibleTrigger className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors">
            <ChevronDown className={`w-4 h-4 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
            Waarom deze status?
          </CollapsibleTrigger>
          <CollapsibleContent className="mt-3">
            <div className="space-y-2">
              {reasons.map((reason, idx) => {
                const reasonConfig = STATUS_CONFIG[reason.severity];
                const ReasonIcon = reasonConfig.icon;
                return (
                  <div 
                    key={idx} 
                    className={`flex items-start gap-2 p-2 rounded-md ${reasonConfig.bgClass}`}
                  >
                    <ReasonIcon className="w-4 h-4 mt-0.5 shrink-0" />
                    <span className="text-sm">{reason.message}</span>
                  </div>
                );
              })}
            </div>
          </CollapsibleContent>
        </Collapsible>
      </CardContent>
    </Card>
  );
}
