/**
 * Fork addition: a category budget on the same side for 12 budgeted months is
 * moved to the median spent (src/lib/budgets/streak.ts), and the month model
 * measures and totals against the moved budget.
 */
import { describe, it, expect } from "vitest";
import { streakAdjustment } from "@/lib/budgets/streak";
import { buildBudgetMonth } from "@/lib/budgets/month";
import { monthRange } from "@/lib/budgets/lines";

/** Budget 500 in every month from..to, plus the target month. */
function history(from: string, to: string, spend: (m: string, i: number) => number, target = "2026-01") {
  const budgets: Record<string, number> = { [target]: 500 };
  const spent: Record<string, number> = {};
  monthRange(from, to).forEach((m, i) => {
    budgets[m] = 500;
    spent[m] = spend(m, i);
  });
  return { budgets, spent };
}

// Twelve spends whose two middle values are 650 and 653: median 651.5.
const OVER = [700, 620, 653, 710, 600, 690, 650, 630, 680, 640, 660, 610];
const UNDER = OVER.map((v) => v - 300); // middles 350 and 353: median 351.5

describe("streakAdjustment", () => {
  it("raises to the median rounded up after 12 months over", () => {
    const h = history("2025-01", "2025-12", (_, i) => OVER[i]);
    expect(streakAdjustment({ target: "2026-01", lastComplete: "2025-12", ...h })).toEqual({
      budget: 652,
      change: 152,
      direction: "over",
    });
  });

  it("lowers to the median rounded down after 12 months under, never below zero", () => {
    const h = history("2025-01", "2025-12", (_, i) => UNDER[i]);
    expect(streakAdjustment({ target: "2026-01", lastComplete: "2025-12", ...h })).toEqual({
      budget: 351,
      change: -149,
      direction: "under",
    });
    const refunds = history("2025-01", "2025-12", () => -20);
    expect(streakAdjustment({ target: "2026-01", lastComplete: "2025-12", ...refunds })?.budget).toBe(0);
  });

  it("needs twelve months, all strictly on one side", () => {
    const eleven = history("2025-02", "2025-12", (_, i) => OVER[i]);
    expect(streakAdjustment({ target: "2026-01", lastComplete: "2025-12", ...eleven })).toBeNull();
    const onBudget = history("2025-01", "2025-12", (_, i) => (i === 5 ? 500 : OVER[i]));
    expect(streakAdjustment({ target: "2026-01", lastComplete: "2025-12", ...onBudget })).toBeNull();
  });

  it("skips months with no budget instead of breaking or counting them", () => {
    const h = history("2024-12", "2025-12", (_, i) => OVER[i % 12]);
    delete h.budgets["2025-06"];
    h.spent["2025-06"] = 0; // unbudgeted and under: must not block the streak
    expect(streakAdjustment({ target: "2026-01", lastComplete: "2025-12", ...h })?.direction).toBe("over");
  });

  it("ignores the month in progress when looking at a future month", () => {
    // Viewing 2026-12 on 2026-11-06: November is half spent and under so far.
    const h = history("2025-11", "2026-11", (m, i) => (m === "2026-11" ? 100 : OVER[i]), "2026-12");
    expect(streakAdjustment({ target: "2026-12", lastComplete: "2026-10", ...h })?.direction).toBe("over");
  });

  it("does nothing for a month with no budget", () => {
    const h = history("2025-01", "2025-12", (_, i) => OVER[i]);
    delete h.budgets["2026-01"];
    expect(streakAdjustment({ target: "2026-01", lastComplete: "2025-12", ...h })).toBeNull();
  });
});

describe("month model with a streak", () => {
  it("measures and totals against the moved budget", () => {
    const m = buildBudgetMonth({
      month: "2026-01",
      currency: "CAD",
      today: "2026-01-15",
      categories: [
        { id: 1, name: "Groceries", group: "Food", type: "E", excluded: false, rollover: false, rolloverNegative: "carry" },
        { id: 2, name: "Dining", group: "Food", type: "E", excluded: false, rollover: false, rolloverNegative: "carry" },
      ],
      groupSettings: new Map(),
      budgets: new Map([[1, 500], [2, 200]]),
      groupBudgets: new Map(),
      actuals: new Map([[1, 600], [2, 50]]),
      averages: new Map(),
      carry: new Map(),
      streaks: new Map([[1, { budget: 652, change: 152, direction: "over" as const }]]),
      upcoming: new Map(),
      debt: [],
      accounts: [],
    });
    const [dining, groceries] = m.spending[0].lines;
    expect(groceries).toMatchObject({ budgeted: 652, left: 52, status: "ok", autoAdjustment: { change: 152 } });
    expect(dining.budgeted).toBe(200);
    expect(dining.autoAdjustment).toBeUndefined();
    expect(m.summary.plannedSpending).toBe(852);
  });
});
