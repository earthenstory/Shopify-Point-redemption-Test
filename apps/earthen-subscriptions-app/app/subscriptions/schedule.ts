import type { IntervalCode } from "./types";

export function nextOccurrence(from: Date, interval: IntervalCode): Date {
  const next = new Date(from);
  if (interval === "weekly") next.setUTCDate(next.getUTCDate() + 7);
  else if (interval === "fortnightly") next.setUTCDate(next.getUTCDate() + 14);
  else addUtcMonthsClamped(next, intervalMonths(interval));
  return next;
}

export function addDurationMonths(from: Date, months: number): Date {
  const result = new Date(from);
  addUtcMonthsClamped(result, months);
  return result;
}

function intervalMonths(interval: IntervalCode): number {
  if (interval === "monthly") return 1;
  if (interval === "bimonthly") return 2;
  if (interval === "quarterly") return 3;
  if (interval === "half_yearly") return 6;
  throw new Error(`Interval ${interval} does not use calendar months`);
}

function addUtcMonthsClamped(date: Date, months: number) {
  const originalDay = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(
    date.getUTCFullYear(), date.getUTCMonth() + 1, 0,
  )).getUTCDate();
  date.setUTCDate(Math.min(originalDay, lastDay));
}
