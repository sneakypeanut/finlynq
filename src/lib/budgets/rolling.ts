/**
 * Rolling (envelope-carry) budgets.
 *
 * Upstream only ever penalises overspending: last month's overage is subtracted
 * from this month. That is only half a rolling budget — money you *didn't* spend
 * disappears instead of following you forward, and the carry never chains past a
 * single month.
 *
 * This module computes a signed, chained carry:
 *
 *   carry(m) = base(m-1) + carry(m-1) - spent(m-1)
 *
 * so underspending raises the next month's budget and overspending lowers it,
 * compounding month over month. The carry resets in January: a new budget year
 * starts clean, which is what makes the envelope survivable long term.
 *
 * A category whose base has been wrong for a whole year is not a discipline
 * problem, it is a bad number, so after `streakMonths` consecutive months on the
 * same side of the line the base itself moves to the median actual — up when the
 * streak was overspending, down when it was underspending.
 */

export type BudgetRow = { categoryId: number; month: string; amount: number };
export type SpendRow = { categoryId: number | null; month: string; spent: number };

export type RollingOptions = {
  /** Month (1-12) that clears the carry. January by default. */
  resetMonth?: number;
  /** Consecutive same-side months required before the base itself moves. */
  streakMonths?: number;
};

export type RollingState = {
  categoryId: number;
  /** Budget as stored in the database for the target month. */
  baseAmount: number;
  /** Signed carry from earlier months this budget year: + = saved, - = overspent. */
  carryIn: number;
  /** The base after any 12-month auto-correction. */
  adjustedBase: number;
  /** adjustedBase + carryIn — what the row should actually compare spending against. */
  effectiveBudget: number;
  /** Signed change the streak rule made to the base (0 when it did not fire). */
  autoAdjustment: number;
  autoAdjustReason: string | null;
  /** Same-side streak ending last month, for the UI. */
  streak: { direction: "over" | "under" | "mixed" | "none"; over: number; under: number; months: number };
};

const money = (n: number) => Math.round(n * 100) / 100;

export function monthIndex(month: string): number {
  const [y, m] = month.split("-").map(Number);
  return y * 12 + (m - 1);
}

export function monthFromIndex(i: number): string {
  const y = Math.floor(i / 12);
  const m = (i % 12) + 1;
  return `${y}-${String(m).padStart(2, "0")}`;
}

export function addMonths(month: string, delta: number): string {
  return monthFromIndex(monthIndex(month) + delta);
}

/** Inclusive list of months from `from` to `to`. */
export function monthsBetween(from: string, to: string): string[] {
  const a = monthIndex(from);
  const b = monthIndex(to);
  if (b < a) return [];
  const out: string[] = [];
  for (let i = a; i <= b; i++) out.push(monthFromIndex(i));
  return out;
}

/** Start of the budget year containing `month`, honouring a non-January reset. */
export function budgetYearStart(month: string, resetMonth = 1): string {
  const [y, m] = month.split("-").map(Number);
  const startYear = m >= resetMonth ? y : y - 1;
  return `${startYear}-${String(resetMonth).padStart(2, "0")}`;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}

/**
 * Compute the rolling state for one category in one month.
 *
 * Missing budget rows break the chain rather than counting as zero: a month you
 * did not budget is a month you did not plan, so it must not silently invent a
 * carry (that is how an unbudgeted holiday would hand you a fake surplus).
 */
export function computeRolling(
  categoryId: number,
  targetMonth: string,
  budgetByMonth: Map<string, number>,
  spendByMonth: Map<string, number>,
  opts: RollingOptions = {}
): RollingState {
  const resetMonth = opts.resetMonth ?? 1;
  const streakMonths = opts.streakMonths ?? 12;

  const base = budgetByMonth.get(targetMonth) ?? 0;

  // --- carry: walk from the start of the budget year to the month before target
  const start = budgetYearStart(targetMonth, resetMonth);
  const walk = monthsBetween(start, addMonths(targetMonth, -1));
  let carry = 0;
  for (const m of walk) {
    const b = budgetByMonth.get(m);
    if (b === undefined) continue; // unplanned month: chain skips it
    carry = b + carry - (spendByMonth.get(m) ?? 0);
  }

  // --- streak: the most recent `streakMonths` planned months before target
  const history: Array<{ month: string; budget: number; spent: number }> = [];
  for (let i = 1; history.length < streakMonths && i <= 36; i++) {
    const m = addMonths(targetMonth, -i);
    const b = budgetByMonth.get(m);
    if (b === undefined) continue;
    history.push({ month: m, budget: b, spent: spendByMonth.get(m) ?? 0 });
  }

  const over = history.filter((h) => h.spent > h.budget).length;
  const under = history.filter((h) => h.spent < h.budget).length;
  const direction: RollingState["streak"]["direction"] =
    history.length === 0 ? "none" : over === history.length ? "over" : under === history.length ? "under" : "mixed";

  let adjustedBase = base;
  let autoAdjustment = 0;
  let autoAdjustReason: string | null = null;

  const fullWindow = history.length >= streakMonths;
  if (fullWindow && direction === "over") {
    const target = Math.ceil(median(history.map((h) => h.spent)));
    autoAdjustment = money(target - base);
    if (autoAdjustment !== 0) {
      adjustedBase = target;
      autoAdjustReason = `Raised by ${streakMonths} months over budget (median actual ${target.toFixed(0)})`;
    }
  } else if (fullWindow && direction === "under") {
    const target = Math.floor(median(history.map((h) => h.spent)));
    autoAdjustment = money(target - base);
    if (autoAdjustment !== 0) {
      adjustedBase = target;
      autoAdjustReason = `Lowered by ${streakMonths} months under budget (median actual ${target.toFixed(0)})`;
    }
  }

  return {
    categoryId,
    baseAmount: money(base),
    carryIn: money(carry),
    adjustedBase: money(adjustedBase),
    effectiveBudget: money(adjustedBase + carry),
    autoAdjustment,
    autoAdjustReason,
    streak: { direction, over, under, months: history.length },
  };
}

/** Group flat rows into the two maps computeRolling wants. */
export function indexHistory(budgets: BudgetRow[], spends: SpendRow[]) {
  const budgetByCategory = new Map<number, Map<string, number>>();
  for (const b of budgets) {
    let m = budgetByCategory.get(b.categoryId);
    if (!m) budgetByCategory.set(b.categoryId, (m = new Map()));
    m.set(b.month, b.amount);
  }
  const spendByCategory = new Map<number, Map<string, number>>();
  for (const s of spends) {
    if (s.categoryId == null) continue;
    let m = spendByCategory.get(s.categoryId);
    if (!m) spendByCategory.set(s.categoryId, (m = new Map()));
    m.set(s.month, (m.get(s.month) ?? 0) + Math.abs(s.spent));
  }
  return { budgetByCategory, spendByCategory };
}
