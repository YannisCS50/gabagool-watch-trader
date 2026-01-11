import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Clock, Calendar, ChevronDown, Check } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
  DropdownMenuLabel,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';

export type TimeFilterType = 
  | { type: 'cycles'; cycles: number; label: string }
  | { type: 'hours'; hours: number; label: string }
  | { type: 'datetime'; from: string; to: string; label: string }
  | { type: 'all'; label: string };

const MARKET_CYCLE_MINUTES = 15;

interface TimeRangeFilterProps {
  value: TimeFilterType;
  onChange: (filter: TimeFilterType) => void;
}

export function TimeRangeFilter({ value, onChange }: TimeRangeFilterProps) {
  const [dateTimeDialogOpen, setDateTimeDialogOpen] = useState(false);
  
  // DateTime range state
  const now = new Date();
  const today = now.toLocaleDateString('en-CA');
  const currentTime = now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  
  const [fromDate, setFromDate] = useState(today);
  const [fromTime, setFromTime] = useState('00:00');
  const [toDate, setToDate] = useState(today);
  const [toTime, setToTime] = useState(currentTime);

  const handleDateTimeSelect = () => {
    if (fromDate && fromTime && toDate && toTime) {
      const fromLabel = `${fromDate} ${fromTime}`;
      const toLabel = `${toDate} ${toTime}`;
      onChange({ 
        type: 'datetime', 
        from: `${fromDate}T${fromTime}:00`, 
        to: `${toDate}T${toTime}:00`,
        label: `${fromLabel} - ${toLabel}`
      });
      setDateTimeDialogOpen(false);
    }
  };

  const presets: TimeFilterType[] = [
    { type: 'cycles', cycles: 1, label: '1 cycle (15m)' },
    { type: 'cycles', cycles: 2, label: '2 cycles (30m)' },
    { type: 'cycles', cycles: 4, label: '4 cycles (1u)' },
    { type: 'cycles', cycles: 8, label: '8 cycles (2u)' },
    { type: 'hours', hours: 1, label: '1 uur' },
    { type: 'hours', hours: 3, label: '3 uur' },
    { type: 'hours', hours: 6, label: '6 uur' },
    { type: 'hours', hours: 12, label: '12 uur' },
    { type: 'hours', hours: 24, label: '24 uur' },
    { type: 'all', label: 'Alles' },
  ];

  const isSelected = (preset: TimeFilterType) => {
    if (preset.type !== value.type) return false;
    if (preset.type === 'cycles' && value.type === 'cycles') return preset.cycles === value.cycles;
    if (preset.type === 'hours' && value.type === 'hours') return preset.hours === value.hours;
    if (preset.type === 'all' && value.type === 'all') return true;
    return false;
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="h-8 gap-1.5">
          <Clock className="h-3.5 w-3.5" />
          <span className="text-xs">{value.label}</span>
          <ChevronDown className="h-3 w-3" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        {/* Market Cycles */}
        <DropdownMenuLabel className="text-xs text-muted-foreground">
          Per market cycle (15 min)
        </DropdownMenuLabel>
        {presets.filter(p => p.type === 'cycles').map((preset) => (
          <DropdownMenuItem 
            key={preset.label} 
            onClick={() => onChange(preset)}
            className="flex items-center justify-between"
          >
            <span>{preset.label}</span>
            {isSelected(preset) && <Check className="h-4 w-4 text-primary" />}
          </DropdownMenuItem>
        ))}

        <DropdownMenuSeparator />
        
        {/* Hours */}
        <DropdownMenuLabel className="text-xs text-muted-foreground">
          Per uur
        </DropdownMenuLabel>
        {presets.filter(p => p.type === 'hours').map((preset) => (
          <DropdownMenuItem 
            key={preset.label} 
            onClick={() => onChange(preset)}
            className="flex items-center justify-between"
          >
            <span>{preset.label}</span>
            {isSelected(preset) && <Check className="h-4 w-4 text-primary" />}
          </DropdownMenuItem>
        ))}

        <DropdownMenuSeparator />

        {/* Custom DateTime */}
        <Dialog open={dateTimeDialogOpen} onOpenChange={setDateTimeDialogOpen}>
          <DialogTrigger asChild>
            <DropdownMenuItem onSelect={(e) => e.preventDefault()}>
              <Calendar className="h-4 w-4 mr-2" />
              Datum + tijd...
            </DropdownMenuItem>
          </DialogTrigger>
          <DialogContent className="sm:max-w-[400px]">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <Calendar className="h-5 w-5" />
                Filter op datum/tijd
              </DialogTitle>
            </DialogHeader>
            <div className="space-y-4 py-4">
              <div className="space-y-2">
                <Label className="text-sm font-medium">Van</Label>
                <div className="grid grid-cols-2 gap-2">
                  <Input
                    type="date"
                    value={fromDate}
                    onChange={(e) => setFromDate(e.target.value)}
                  />
                  <Input
                    type="time"
                    value={fromTime}
                    onChange={(e) => setFromTime(e.target.value)}
                  />
                </div>
              </div>
              
              <div className="space-y-2">
                <Label className="text-sm font-medium">Tot</Label>
                <div className="grid grid-cols-2 gap-2">
                  <Input
                    type="date"
                    value={toDate}
                    onChange={(e) => setToDate(e.target.value)}
                  />
                  <Input
                    type="time"
                    value={toTime}
                    onChange={(e) => setToTime(e.target.value)}
                  />
                </div>
              </div>

              <div className="space-y-2">
                <Label className="text-xs text-muted-foreground">Snelle selectie</Label>
                <div className="flex flex-wrap gap-2">
                  <Button 
                    variant="outline" 
                    size="sm"
                    onClick={() => {
                      const now = new Date();
                      setFromDate(now.toLocaleDateString('en-CA'));
                      setFromTime('00:00');
                      setToDate(now.toLocaleDateString('en-CA'));
                      setToTime(now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }));
                    }}
                  >
                    Vandaag
                  </Button>
                  <Button 
                    variant="outline" 
                    size="sm"
                    onClick={() => {
                      const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
                      setFromDate(yesterday.toLocaleDateString('en-CA'));
                      setFromTime('00:00');
                      setToDate(yesterday.toLocaleDateString('en-CA'));
                      setToTime('23:59');
                    }}
                  >
                    Gisteren
                  </Button>
                </div>
              </div>

              <Button 
                className="w-full" 
                onClick={handleDateTimeSelect}
                disabled={!fromDate || !fromTime || !toDate || !toTime}
              >
                Toepassen
              </Button>
            </div>
          </DialogContent>
        </Dialog>

        <DropdownMenuSeparator />
        
        {/* All */}
        {presets.filter(p => p.type === 'all').map((preset) => (
          <DropdownMenuItem 
            key={preset.label} 
            onClick={() => onChange(preset)}
            className="flex items-center justify-between"
          >
            <span>{preset.label}</span>
            {isSelected(preset) && <Check className="h-4 w-4 text-primary" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// Helper to extract timestamp from various data structures
function extractTimestamp(item: Record<string, any>): number {
  // Try common timestamp fields
  if (typeof item.timestamp === 'number') return item.timestamp;
  if (typeof item.ts === 'number') return item.ts;
  if (typeof item.entry_timestamp === 'number') return item.entry_timestamp;
  if (typeof item.spotEventTs === 'number') return item.spotEventTs;
  if (typeof item.polyEventTs === 'number') return item.polyEventTs;
  if (typeof item.entryTimestamp === 'number') return item.entryTimestamp;
  if (typeof item.date === 'string') return new Date(item.date).getTime();
  if (typeof item.iso === 'string') return new Date(item.iso).getTime();
  return 0;
}

// Helper function to filter data by time
export function filterDataByTime<T>(
  data: T[],
  filter: TimeFilterType
): T[] {
  if (filter.type === 'all') return data;

  const now = Date.now();
  let cutoffMs: number;

  if (filter.type === 'cycles') {
    cutoffMs = now - filter.cycles * MARKET_CYCLE_MINUTES * 60 * 1000;
  } else if (filter.type === 'hours') {
    cutoffMs = now - filter.hours * 60 * 60 * 1000;
  } else if (filter.type === 'datetime') {
    const fromMs = new Date(filter.from).getTime();
    const toMs = new Date(filter.to).getTime();
    return data.filter((item) => {
      const itemTs = extractTimestamp(item as Record<string, any>);
      return itemTs >= fromMs && itemTs <= toMs;
    });
  } else {
    return data;
  }

  return data.filter((item) => {
    const itemTs = extractTimestamp(item as Record<string, any>);
    return itemTs >= cutoffMs;
  });
}

export const DEFAULT_TIME_FILTER: TimeFilterType = { type: 'hours', hours: 1, label: '1 uur' };
