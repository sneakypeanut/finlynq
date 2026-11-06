/**
 * Twelve-month streak correction (fork addition). Pure.
 *
 * A category that has been on the same side of its budget for twelve budgeted
 * months in a row has a wrong budget, not a spending problem. Its budget for
 * the month is moved to the median of those months' spending: up (rounded up)
 * after twelve months over, down (rounded down) after twelve months under. One
 * month on the other side, or exactly on budget, breaks the streak.
 *
 * Only complete months before the target count, newest first, looking back at
 * most `lookbackMonths`. Months with no budget are skipped rather than counted
 * as zero. The adjustment is computed when the month is read; nothing is
 * stored, so the stored budgets the streak compares against never change.
 */
import { shiftMonth } from "./lines";

export const STREAK_MONTHS = 12;
export const STREAK_LOOKBACK_MONTHS = 36;

export interface StreakAdjustment {
  /** The budget the month uses instead of the stored one. */
  budget: number;
  /** budget − stored budget. */
  change: number;
  direction: "over" | "under";
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}

export function streakAdjustment(opts: {
  target: string;
  /** Latest complete month (the month before the current one). */
  lastComplete: string;
  budgets: Readonly<Record<string, number>>;
  /** Positive = money out. */
  spent: Readonly<Record<string, number>>;
}): StreakAdjustment | null {
  const { target, lastComplete, budgets, spent } = opts;
  const base = budgets[target];
  if (base == null) return null;

  const history: Array<{ budget: number; spent: number }> = [];
  for (let i = 1; i <= STREAK_LOOKBACK_MONTHS && history.length < STREAK_MONTHS; i++) {
    const m = shiftMonth(target, -i);
    if (m > lastComplete) continue;
    const b = budgets[m];
    if (b == null) continue;
    history.push({ budget: b, spent: spent[m] ?? 0 });
  }
  if (history.length < STREAK_MONTHS) return null;

  let direction: StreakAdjustment["direction"];
  let budget: number;
  if (history.every((h) => h.spent > h.budget)) {
    direction = "over";
    budget = Math.ceil(median(history.map((h) => h.spent)));
  } else if (history.every((h) => h.spent < h.budget)) {
    direction = "under";
    // Refunds can net a month's spending below zero; a budget can't go there.
    budget = Math.max(0, Math.floor(median(history.map((h) => h.spent))));
  } else {
    return null;
  }
  const change = Math.round((budget - base) * 100) / 100;
  return change === 0 ? null : { budget, change, direction };
}
