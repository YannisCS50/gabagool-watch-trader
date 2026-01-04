import { Link, useLocation } from 'react-router-dom';
import { useState } from 'react';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { cn } from '@/lib/utils';
import {
  Menu,
  LayoutDashboard,
  TrendingUp,
  BarChart3,
  Code2,
  BookOpen,
  Activity,
  Settings,
  Wallet,
  Bot,
  LineChart,
  FileCode,
  Zap,
  Database,
  Eye,
  Shield,
  ChevronDown,
} from 'lucide-react';

const tradingItems = [
  { title: 'Live Trading', href: '/live-trading', icon: TrendingUp },
  { title: 'Paper Trading', href: '/paper-trading', icon: Bot },
  { title: 'Wallet', href: '/wallet', icon: Wallet },
];

const analysisItems = [
  { title: 'Trade Analysis', href: '/trade-analysis', icon: BarChart3 },
  { title: 'Edge Analysis', href: '/edge-analysis', icon: Zap },
  { title: 'Entry Analysis', href: '/entry-analysis', icon: LineChart },
  { title: 'Hedge Analysis', href: '/hedge-analysis', icon: Shield },
  { title: 'Gabagool Analysis', href: '/gabagool-analysis', icon: Activity },
  { title: 'Arbitrage', href: '/arbitrage', icon: TrendingUp },
];

const strategyItems = [
  { title: 'Strategy Overview', href: '/strategy', icon: Code2 },
  { title: 'Strategy Deep Dive', href: '/strategy-deep-dive', icon: BookOpen },
  { title: 'Strategy Code', href: '/strategy-code', icon: FileCode },
  { title: 'Live Bot Strategy', href: '/live-bot-strategy', icon: Bot },
  { title: 'Paper Bot Strategy', href: '/paper-bot-strategy', icon: Bot },
  { title: 'GPT Strategy', href: '/gpt-strategy', icon: Zap },
  { title: 'Rust Strategy', href: '/rust-strategy', icon: Code2 },
  { title: 'Trading Strategies', href: '/trading-strategies', icon: TrendingUp },
];

const docsItems = [
  { title: 'Dev Guide', href: '/dev-guide', icon: BookOpen },
  { title: 'HFT Build Guide', href: '/hft-build-guide', icon: Zap },
  { title: 'Order Flow Docs', href: '/order-flow-docs', icon: Database },
  { title: 'Data Flow Docs', href: '/data-flow-docs', icon: Database },
];

const monitoringItems = [
  { title: 'Real-Time Signals', href: '/real-time-signals', icon: Activity },
  { title: 'Observability', href: '/observability', icon: Eye },
  { title: 'Data Logging', href: '/data-logging', icon: Database },
];

interface NavSectionProps {
  title: string;
  icon: React.ElementType;
  items: { title: string; href: string; icon: React.ElementType }[];
  onNavigate: () => void;
}

function NavSection({ title, icon: Icon, items, onNavigate }: NavSectionProps) {
  const location = useLocation();
  const [isOpen, setIsOpen] = useState(false);
  const isActive = items.some(item => location.pathname === item.href);

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen}>
      <CollapsibleTrigger asChild>
        <Button 
          variant="ghost" 
          className={cn(
            "w-full justify-between px-3 py-2 h-auto",
            isActive && "bg-accent text-accent-foreground"
          )}
        >
          <span className="flex items-center gap-2">
            <Icon className="h-4 w-4" />
            {title}
          </span>
          <ChevronDown className={cn(
            "h-4 w-4 transition-transform",
            isOpen && "rotate-180"
          )} />
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="pl-4 space-y-1">
        {items.map((item) => (
          <Link
            key={item.href}
            to={item.href}
            onClick={onNavigate}
            className={cn(
              "flex items-center gap-2 px-3 py-2 rounded-md text-sm transition-colors",
              location.pathname === item.href
                ? "bg-accent text-accent-foreground"
                : "text-muted-foreground hover:text-foreground hover:bg-accent/50"
            )}
          >
            <item.icon className="h-4 w-4" />
            {item.title}
          </Link>
        ))}
      </CollapsibleContent>
    </Collapsible>
  );
}

export function MobileNav() {
  const [open, setOpen] = useState(false);
  const location = useLocation();

  const handleNavigate = () => setOpen(false);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button variant="ghost" size="icon" className="md:hidden">
          <Menu className="h-5 w-5" />
          <span className="sr-only">Open menu</span>
        </Button>
      </SheetTrigger>
      <SheetContent side="left" className="w-72 p-0">
        <SheetHeader className="border-b border-border p-4">
          <SheetTitle className="flex items-center gap-2">
            <div className="w-6 h-6 rounded bg-gradient-to-br from-primary to-emerald-400 flex items-center justify-center">
              <BarChart3 className="w-3 h-3 text-primary-foreground" />
            </div>
            PolyTracker
          </SheetTitle>
        </SheetHeader>
        <ScrollArea className="h-[calc(100vh-60px)]">
          <div className="p-4 space-y-2">
            {/* Dashboard */}
            <Link
              to="/"
              onClick={handleNavigate}
              className={cn(
                "flex items-center gap-2 px-3 py-2 rounded-md text-sm font-medium transition-colors",
                location.pathname === "/"
                  ? "bg-accent text-accent-foreground"
                  : "text-muted-foreground hover:text-foreground hover:bg-accent/50"
              )}
            >
              <LayoutDashboard className="h-4 w-4" />
              Dashboard
            </Link>

            {/* Sections */}
            <NavSection title="Trading" icon={TrendingUp} items={tradingItems} onNavigate={handleNavigate} />
            <NavSection title="Analysis" icon={BarChart3} items={analysisItems} onNavigate={handleNavigate} />
            <NavSection title="Strategy" icon={Code2} items={strategyItems} onNavigate={handleNavigate} />
            <NavSection title="Docs" icon={BookOpen} items={docsItems} onNavigate={handleNavigate} />
            <NavSection title="Monitoring" icon={Activity} items={monitoringItems} onNavigate={handleNavigate} />

            {/* Settings */}
            <Link
              to="/settings"
              onClick={handleNavigate}
              className={cn(
                "flex items-center gap-2 px-3 py-2 rounded-md text-sm font-medium transition-colors",
                location.pathname === "/settings"
                  ? "bg-accent text-accent-foreground"
                  : "text-muted-foreground hover:text-foreground hover:bg-accent/50"
              )}
            >
              <Settings className="h-4 w-4" />
              Settings
            </Link>
          </div>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
}
