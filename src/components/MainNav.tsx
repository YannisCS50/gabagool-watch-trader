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
  Activity,
  Settings,
  Database,
  Eye,
  Shield,
  FileCheck,
  Sparkles,
  FlaskConical,
} from 'lucide-react';

const analysisItems = [
  { title: 'Trade Analysis', href: '/trade-analysis', icon: BarChart3, description: 'Analyze trade performance' },
  { title: 'Hedge Analysis', href: '/hedge-analysis', icon: Shield, description: 'Hedge effectiveness' },
  { title: 'Gabagool Analysis', href: '/gabagool-analysis', icon: Activity, description: 'Gabagool strategy stats' },
  { title: 'Gabagool Backtest', href: '/gabagool-backtest', icon: FlaskConical, description: 'Backtest hedge strategy' },
];

const monitoringItems = [
  { title: 'Bot Health', href: '/bot-health', icon: Activity, description: 'Bot stabiliteit & gedrag' },
  { title: 'Observability', href: '/observability', icon: Eye, description: 'System monitoring' },
  { title: 'Data Logging', href: '/data-logging', icon: Database, description: 'Log viewer' },
  { title: 'Reconcile', href: '/reconcile', icon: FileCheck, description: 'CSV vs bot fill matching' },
  { title: 'Database Export', href: '/database-export', icon: Database, description: 'Volledige DB export als ZIP' },
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
    <NavigationMenu className="flex justify-start">
      <NavigationMenuList className="flex flex-row space-x-1">
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

        {/* Live Trading */}
        <NavigationMenuItem>
          <Link to="/live-trading">
            <NavigationMenuLink
              className={cn(
                navigationMenuTriggerStyle(),
                location.pathname === '/live-trading' && 'bg-accent text-accent-foreground'
              )}
            >
              <TrendingUp className="mr-2 h-4 w-4" />
              Live Trading
            </NavigationMenuLink>
          </Link>
        </NavigationMenuItem>

        {/* V26 Strategy */}
        <NavigationMenuItem>
          <Link to="/v26">
            <NavigationMenuLink
              className={cn(
                navigationMenuTriggerStyle(),
                location.pathname === '/v26' && 'bg-accent text-accent-foreground'
              )}
            >
              V26
            </NavigationMenuLink>
          </Link>
        </NavigationMenuItem>

        {/* V30 Market-Maker */}
        <NavigationMenuItem>
          <Link to="/v30">
            <NavigationMenuLink
              className={cn(
                navigationMenuTriggerStyle(),
                location.pathname === '/v30' && 'bg-accent text-accent-foreground',
                'bg-gradient-to-r from-primary/10 to-emerald-500/10 border border-primary/20'
              )}
            >
              <Sparkles className="mr-2 h-4 w-4 text-primary" />
              V30
            </NavigationMenuLink>
          </Link>
        </NavigationMenuItem>

        {/* Analysis */}
        <NavigationMenuItem>
          <NavigationMenuTrigger className="h-9">
            <BarChart3 className="mr-2 h-4 w-4" />
            Analysis
          </NavigationMenuTrigger>
          <NavigationMenuContent>
            <ul className="grid w-[300px] gap-1 p-2 bg-popover border border-border rounded-md shadow-lg">
              {analysisItems.map((item) => (
                <ListItem key={item.href} {...item} />
              ))}
            </ul>
          </NavigationMenuContent>
        </NavigationMenuItem>

        {/* Monitoring */}
        <NavigationMenuItem>
          <NavigationMenuTrigger className="h-9">
            <Activity className="mr-2 h-4 w-4" />
            Monitoring
          </NavigationMenuTrigger>
          <NavigationMenuContent>
            <ul className="grid w-[300px] gap-1 p-2 bg-popover border border-border rounded-md shadow-lg">
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
