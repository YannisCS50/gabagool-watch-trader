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
  Activity,
  Settings,
  Database,
  Eye,
  Shield,
  ChevronDown,
} from 'lucide-react';

const analysisItems = [
  { title: 'Trade Analysis', href: '/trade-analysis', icon: BarChart3 },
  { title: 'Hedge Analysis', href: '/hedge-analysis', icon: Shield },
  { title: 'Gabagool Analysis', href: '/gabagool-analysis', icon: Activity },
];

const monitoringItems = [
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

            {/* Live Trading */}
            <Link
              to="/live-trading"
              onClick={handleNavigate}
              className={cn(
                "flex items-center gap-2 px-3 py-2 rounded-md text-sm font-medium transition-colors",
                location.pathname === "/live-trading"
                  ? "bg-accent text-accent-foreground"
                  : "text-muted-foreground hover:text-foreground hover:bg-accent/50"
              )}
            >
              <TrendingUp className="h-4 w-4" />
              Live Trading
            </Link>

            {/* Sections */}
            <NavSection title="Analysis" icon={BarChart3} items={analysisItems} onNavigate={handleNavigate} />
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
