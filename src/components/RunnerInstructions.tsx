import React, { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { 
  Terminal, 
  Copy, 
  Check, 
  ChevronDown, 
  ChevronUp,
  AlertTriangle,
  Wifi,
  Key,
  FolderOpen
} from 'lucide-react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';

export function RunnerInstructions() {
  const [isOpen, setIsOpen] = useState(false);
  const [copiedCommand, setCopiedCommand] = useState<string | null>(null);

  const copyToClipboard = async (text: string, id: string) => {
    await navigator.clipboard.writeText(text);
    setCopiedCommand(id);
    setTimeout(() => setCopiedCommand(null), 2000);
  };

  const commands = [
    {
      id: 'cd',
      label: 'Navigate to runner folder',
      command: 'cd local-runner',
      description: 'Go to the local-runner directory'
    },
    {
      id: 'install',
      label: 'Install dependencies',
      command: 'npm install',
      description: 'Install required packages (first time only)'
    },
    {
      id: 'start',
      label: 'Start the runner',
      command: 'npm start',
      description: 'Start the local runner with VPN check'
    },
    {
      id: 'restart',
      label: 'Restart (if already running)',
      command: 'Ctrl+C && npm start',
      description: 'Stop current instance and restart'
    }
  ];

  return (
    <Card className="border-amber-500/20">
      <Collapsible open={isOpen} onOpenChange={setIsOpen}>
        <CardHeader className="pb-3">
          <CollapsibleTrigger asChild>
            <div className="flex items-center justify-between cursor-pointer hover:bg-accent/50 -m-2 p-2 rounded-lg transition-colors">
              <CardTitle className="flex items-center gap-2 text-base">
                <Terminal className="w-5 h-5 text-amber-500" />
                Local Runner Setup
                <Badge variant="outline" className="text-xs">Click to expand</Badge>
              </CardTitle>
              {isOpen ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
            </div>
          </CollapsibleTrigger>
        </CardHeader>
        
        <CollapsibleContent>
          <CardContent className="space-y-4">
            {/* Requirements */}
            <div className="grid gap-2 text-sm">
              <div className="flex items-start gap-2 p-2 bg-amber-500/10 rounded-lg border border-amber-500/20">
                <AlertTriangle className="w-4 h-4 text-amber-500 mt-0.5 shrink-0" />
                <div>
                  <span className="font-medium text-amber-500">Vereisten:</span>
                  <ul className="text-muted-foreground mt-1 space-y-1">
                    <li className="flex items-center gap-2">
                      <Wifi className="w-3 h-3" /> VPN actief (residential IP)
                    </li>
                    <li className="flex items-center gap-2">
                      <Key className="w-3 h-3" /> Polymarket API keys in .env
                    </li>
                    <li className="flex items-center gap-2">
                      <FolderOpen className="w-3 h-3" /> Node.js 18+ of Bun
                    </li>
                  </ul>
                </div>
              </div>
            </div>

            {/* Commands */}
            <div className="space-y-2">
              <h4 className="text-sm font-medium text-muted-foreground">Commando's:</h4>
              {commands.map((cmd) => (
                <div 
                  key={cmd.id}
                  className="flex items-center justify-between p-2 bg-muted/50 rounded-lg border"
                >
                  <div className="flex-1 min-w-0">
                    <div className="text-xs text-muted-foreground">{cmd.label}</div>
                    <code className="text-sm font-mono text-foreground">{cmd.command}</code>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => copyToClipboard(cmd.command, cmd.id)}
                    className="shrink-0"
                  >
                    {copiedCommand === cmd.id ? (
                      <Check className="w-4 h-4 text-emerald-500" />
                    ) : (
                      <Copy className="w-4 h-4" />
                    )}
                  </Button>
                </div>
              ))}
            </div>

            {/* .env Example */}
            <div className="space-y-2">
              <h4 className="text-sm font-medium text-muted-foreground">.env bestand:</h4>
              <div className="p-3 bg-muted/50 rounded-lg border font-mono text-xs space-y-1">
                <div className="text-muted-foreground"># Polymarket API credentials</div>
                <div>POLYMARKET_API_KEY=<span className="text-amber-500">your_api_key</span></div>
                <div>POLYMARKET_API_SECRET=<span className="text-amber-500">your_api_secret</span></div>
                <div>POLYMARKET_PASSPHRASE=<span className="text-amber-500">your_passphrase</span></div>
                <div>POLYMARKET_ADDRESS=<span className="text-amber-500">your_wallet_address</span></div>
                <div>POLYMARKET_PRIVATE_KEY=<span className="text-amber-500">your_private_key</span></div>
                <div className="text-muted-foreground mt-2"># Backend</div>
                <div>BACKEND_URL=<span className="text-amber-500">your_backend_url</span></div>
                <div>RUNNER_SHARED_SECRET=<span className="text-amber-500">shared_secret</span></div>
              </div>
              <Button
                variant="outline"
                size="sm"
                className="w-full"
                onClick={() =>
                  copyToClipboard(
                    `# Polymarket API credentials\nPOLYMARKET_API_KEY=\nPOLYMARKET_API_SECRET=\nPOLYMARKET_PASSPHRASE=\nPOLYMARKET_ADDRESS=\nPOLYMARKET_PRIVATE_KEY=\n\n# Backend\nBACKEND_URL=\nRUNNER_SHARED_SECRET=`,
                    'env'
                  )
                }
              >
                {copiedCommand === 'env' ? (
                  <>
                    <Check className="w-4 h-4 mr-2 text-emerald-500" /> Gekopieerd!
                  </>
                ) : (
                  <>
                    <Copy className="w-4 h-4 mr-2" /> Kopieer .env template
                  </>
                )}
              </Button>
            </div>

            {/* Troubleshooting */}
            <div className="text-xs text-muted-foreground border-t pt-3 space-y-1">
              <div className="font-medium">Problemen?</div>
              <ul className="list-disc list-inside space-y-0.5">
                <li>Cloudflare 403 → VPN niet actief of verkeerd IP</li>
                <li>401 Unauthorized → API keys verlopen, regenereer op Polymarket</li>
                <li><code className="font-mono">order_id</code> blijft leeg → de API response bevat geen ID; zie runner logs ("📋 Polymarket response")</li>
              </ul>
            </div>
          </CardContent>
        </CollapsibleContent>
      </Collapsible>
    </Card>
  );
}
