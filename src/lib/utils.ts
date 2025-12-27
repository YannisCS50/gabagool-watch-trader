import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// USDC is commonly represented in "base units" (6 decimals).
export function usdcFromBaseUnits(value: number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  return value / 1_000_000;
}

export function formatUsd(value: number, opts?: { sign?: boolean }): string {
  const sign = opts?.sign ? (value > 0 ? "+" : value < 0 ? "-" : "") : "";
  const abs = Math.abs(value);
  return `${sign}$${abs.toFixed(2)}`;
}

export function formatUsdcFromBaseUnits(value: number | null | undefined, opts?: { sign?: boolean }): string {
  return formatUsd(usdcFromBaseUnits(value), opts);
}
