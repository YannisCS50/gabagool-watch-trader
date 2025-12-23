import { useState, useEffect, useRef } from 'react';
import { cn } from '@/lib/utils';

interface LiveCountdownProps {
  eventEndTime: string; // ISO string of when the market ends
  className?: string;
  showMilliseconds?: boolean;
}

export const LiveCountdown = ({ 
  eventEndTime, 
  className,
  showMilliseconds = true 
}: LiveCountdownProps) => {
  const [timeLeft, setTimeLeft] = useState({ minutes: 0, seconds: 0, ms: 0, total: 0 });
  const rafRef = useRef<number | null>(null);
  const endTimeRef = useRef<number>(new Date(eventEndTime).getTime());

  useEffect(() => {
    endTimeRef.current = new Date(eventEndTime).getTime();
  }, [eventEndTime]);

  useEffect(() => {
    let lastUpdate = performance.now();

    const updateCountdown = (currentTime: number) => {
      const now = Date.now();
      const remaining = endTimeRef.current - now;

      if (remaining <= 0) {
        setTimeLeft({ minutes: 0, seconds: 0, ms: 0, total: 0 });
        return;
      }

      // Only update state if enough time has passed (every 10ms for smooth animation)
      if (currentTime - lastUpdate >= 10) {
        const minutes = Math.floor(remaining / 60000);
        const seconds = Math.floor((remaining % 60000) / 1000);
        const ms = remaining % 1000;
        
        setTimeLeft({ minutes, seconds, ms, total: remaining });
        lastUpdate = currentTime;
      }

      rafRef.current = requestAnimationFrame(updateCountdown);
    };

    rafRef.current = requestAnimationFrame(updateCountdown);

    return () => {
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
      }
    };
  }, []);

  const isUrgent = timeLeft.total > 0 && timeLeft.total < 60000; // Last minute
  const isCritical = timeLeft.total > 0 && timeLeft.total < 30000; // Last 30 seconds
  const isExpired = timeLeft.total <= 0;

  if (isExpired) {
    return (
      <span className={cn("font-mono text-muted-foreground", className)}>
        EXPIRED
      </span>
    );
  }

  return (
    <span 
      className={cn(
        "font-mono tabular-nums tracking-tight",
        isCritical ? "text-red-500 animate-pulse" : 
        isUrgent ? "text-orange-400" : 
        "text-emerald-400",
        className
      )}
    >
      {timeLeft.minutes.toString().padStart(2, '0')}:
      {timeLeft.seconds.toString().padStart(2, '0')}
      {showMilliseconds && (
        <span className="text-[0.7em] opacity-70">
          .{Math.floor(timeLeft.ms / 10).toString().padStart(2, '0')}
        </span>
      )}
    </span>
  );
};
