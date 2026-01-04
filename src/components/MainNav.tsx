import { Link, useLocation } from 'react-router-dom';
import {
  NavigationMenu,
  NavigationMenuContent,
  NavigationMenuItem,
  NavigationMenuLink,
  NavigationMenuList,
  NavigationMenuTrigger,
  navigationMenuTriggerStyle,
} from '@/components/ui/navigation-menu';
import { cn } from '@/lib/utils';
import {
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
} from 'lucide-react';

const tradingItems = [
  { title: 'Live Trading', href: '/live-trading', icon: TrendingUp, description: 'Real-time trading dashboard' },
  { title: 'Paper Trading', href: '/paper-trading', icon: Bot, description: 'Simulated trading environment' },
  { title: 'Wallet', href: '/wallet', icon: Wallet, description: 'Wallet balances & positions' },
];

const analysisItems = [
  { title: 'Trade Analysis', href: '/trade-analysis', icon: BarChart3, description: 'Analyze trade performance' },
  { title: 'Edge Analysis', href: '/edge-analysis', icon: Zap, description: 'Edge detection metrics' },
  { title: 'Entry Analysis', href: '/entry-analysis', icon: LineChart, description: 'Entry point analysis' },
  { title: 'Hedge Analysis', href: '/hedge-analysis', icon: Shield, description: 'Hedge effectiveness' },
  { title: 'Gabagool Analysis', href: '/gabagool-analysis', icon: Activity, description: 'Gabagool strategy stats' },
  { title: 'Arbitrage', href: '/arbitrage', icon: TrendingUp, description: 'Arbitrage opportunities' },
];

const strategyItems = [
  { title: 'Strategy Overview', href: '/strategy', icon: Code2, description: 'Strategy configuration' },
  { title: 'Strategy Deep Dive', href: '/strategy-deep-dive', icon: BookOpen, description: 'Detailed strategy docs' },
  { title: 'Strategy Code', href: '/strategy-code', icon: FileCode, description: 'View strategy source' },
  { title: 'Live Bot Strategy', href: '/live-bot-strategy', icon: Bot, description: 'Live bot config' },
  { title: 'Paper Bot Strategy', href: '/paper-bot-strategy', icon: Bot, description: 'Paper bot config' },
  { title: 'GPT Strategy', href: '/gpt-strategy', icon: Zap, description: 'AI-assisted strategy' },
  { title: 'Rust Strategy', href: '/rust-strategy', icon: Code2, description: 'High-perf Rust impl' },
  { title: 'Trading Strategies', href: '/trading-strategies', icon: TrendingUp, description: 'Strategy library' },
];

const docsItems = [
  { title: 'Dev Guide', href: '/dev-guide', icon: BookOpen, description: 'Developer documentation' },
  { title: 'HFT Build Guide', href: '/hft-build-guide', icon: Zap, description: 'HFT implementation guide' },
  { title: 'Order Flow Docs', href: '/order-flow-docs', icon: Database, description: 'Order flow architecture' },
  { title: 'Data Flow Docs', href: '/data-flow-docs', icon: Database, description: 'Data pipeline docs' },
];

const monitoringItems = [
  { title: 'Real-Time Signals', href: '/real-time-signals', icon: Activity, description: 'Live trading signals' },
  { title: 'Observability', href: '/observability', icon: Eye, description: 'System monitoring' },
  { title: 'Data Logging', href: '/data-logging', icon: Database, description: 'Log viewer' },
];

interface ListItemProps {
  title: string;
  href: string;
  icon: React.ElementType;
  description: string;
}

function ListItem({ title, href, icon: Icon, description }: ListItemProps) {
  const location = useLocation();
  const isActive = location.pathname === href;

  return (
    <li>
      <NavigationMenuLink asChild>
        <Link
          to={href}
          className={cn(
            'block select-none space-y-1 rounded-md p-3 leading-none no-underline outline-none transition-colors hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground',
            isActive && 'bg-accent text-accent-foreground'
          )}
        >
          <div className="flex items-center gap-2 text-sm font-medium leading-none">
            <Icon className="h-4 w-4" />
            {title}
          </div>
          <p className="line-clamp-2 text-xs leading-snug text-muted-foreground">
            {description}
          </p>
        </Link>
      </NavigationMenuLink>
    </li>
  );
}

export function MainNav() {
  const location = useLocation();

  return (
    <NavigationMenu className="max-w-none">
      <NavigationMenuList className="flex-wrap gap-1">
        {/* Dashboard */}
        <NavigationMenuItem>
          <Link to="/">
            <NavigationMenuLink
              className={cn(
                navigationMenuTriggerStyle(),
                location.pathname === '/' && 'bg-accent text-accent-foreground'
              )}
            >
              <LayoutDashboard className="mr-2 h-4 w-4" />
              Dashboard
            </NavigationMenuLink>
          </Link>
        </NavigationMenuItem>

        {/* Trading */}
        <NavigationMenuItem>
          <NavigationMenuTrigger>
            <TrendingUp className="mr-2 h-4 w-4" />
            Trading
          </NavigationMenuTrigger>
          <NavigationMenuContent>
            <ul className="grid w-[300px] gap-1 p-2">
              {tradingItems.map((item) => (
                <ListItem key={item.href} {...item} />
              ))}
            </ul>
          </NavigationMenuContent>
        </NavigationMenuItem>

        {/* Analysis */}
        <NavigationMenuItem>
          <NavigationMenuTrigger>
            <BarChart3 className="mr-2 h-4 w-4" />
            Analysis
          </NavigationMenuTrigger>
          <NavigationMenuContent>
            <ul className="grid w-[400px] gap-1 p-2 md:grid-cols-2">
              {analysisItems.map((item) => (
                <ListItem key={item.href} {...item} />
              ))}
            </ul>
          </NavigationMenuContent>
        </NavigationMenuItem>

        {/* Strategy */}
        <NavigationMenuItem>
          <NavigationMenuTrigger>
            <Code2 className="mr-2 h-4 w-4" />
            Strategy
          </NavigationMenuTrigger>
          <NavigationMenuContent>
            <ul className="grid w-[400px] gap-1 p-2 md:grid-cols-2">
              {strategyItems.map((item) => (
                <ListItem key={item.href} {...item} />
              ))}
            </ul>
          </NavigationMenuContent>
        </NavigationMenuItem>

        {/* Documentation */}
        <NavigationMenuItem>
          <NavigationMenuTrigger>
            <BookOpen className="mr-2 h-4 w-4" />
            Docs
          </NavigationMenuTrigger>
          <NavigationMenuContent>
            <ul className="grid w-[300px] gap-1 p-2">
              {docsItems.map((item) => (
                <ListItem key={item.href} {...item} />
              ))}
            </ul>
          </NavigationMenuContent>
        </NavigationMenuItem>

        {/* Monitoring */}
        <NavigationMenuItem>
          <NavigationMenuTrigger>
            <Activity className="mr-2 h-4 w-4" />
            Monitoring
          </NavigationMenuTrigger>
          <NavigationMenuContent>
            <ul className="grid w-[300px] gap-1 p-2">
              {monitoringItems.map((item) => (
                <ListItem key={item.href} {...item} />
              ))}
            </ul>
          </NavigationMenuContent>
        </NavigationMenuItem>

        {/* Settings */}
        <NavigationMenuItem>
          <Link to="/settings">
            <NavigationMenuLink
              className={cn(
                navigationMenuTriggerStyle(),
                location.pathname === '/settings' && 'bg-accent text-accent-foreground'
              )}
            >
              <Settings className="mr-2 h-4 w-4" />
              Settings
            </NavigationMenuLink>
          </Link>
        </NavigationMenuItem>
      </NavigationMenuList>
    </NavigationMenu>
  );
}
