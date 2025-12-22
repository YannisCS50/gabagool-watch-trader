import { TraderStats } from '@/types/trade';
import { format } from 'date-fns';
import { ExternalLink, Activity } from 'lucide-react';

interface TraderHeaderProps {
  username: string;
  stats: TraderStats;
}

export function TraderHeader({ username, stats }: TraderHeaderProps) {
  return (
    <div className="glass rounded-lg p-6 animate-fade-in">
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-3">
            <div className="w-12 h-12 rounded-full bg-gradient-to-br from-primary to-emerald-400 flex items-center justify-center text-primary-foreground font-bold text-lg">
              {username.charAt(0).toUpperCase()}
            </div>
            <div>
              <h1 className="text-2xl font-bold flex items-center gap-2">
                <span className="text-gradient">@{username}</span>
                <a 
                  href={`https://polymarket.com/@${username}?tab=activity`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-muted-foreground hover:text-primary transition-colors"
                >
                  <ExternalLink className="w-4 h-4" />
                </a>
              </h1>
              <p className="text-sm text-muted-foreground mt-0.5">
                Tracking since {format(stats.activeSince, 'MMM yyyy')}
              </p>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2 text-sm">
          <Activity className="w-4 h-4 text-success animate-pulse" />
          <span className="text-muted-foreground">Last active:</span>
          <span className="font-mono text-foreground">
            {format(stats.lastActive, 'MMM dd, HH:mm')}
          </span>
        </div>
      </div>
    </div>
  );
}
