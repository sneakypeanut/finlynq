/**
 * Ledger → home-plan profile → scenario plans → a single recommendation.
 *
 * The profile is derived from the SAME payload the dashboard renders, so the
 * numbers here always match what the user sees elsewhere in the app, and they
 * refresh on every page load (no scheduled job, no stored copy to go stale).
 */

import {
  type Assumptions,
  type HomePlanProfile,
  type HomeScenario,
  type RouteResult,
  type ScenarioPlan,
  type Verdict,
  addMonths,
  breakevenYears,
  closingCosts,
  monthlyHousingCost,
  monthsUntil,
  netWorthAt,
  payment,
  qualifies,
  maxPurchasePrice,
  unrecoverableMonthly,
  RENT_ESCALATION,
} from "./engine";

/** The subset of GET /api/dashboard this feature consumes. */
export type DashboardLike = {
  balances: Array<{
    accountId: number;
    accountName: string | null;
    accountType: string;
    accountGroup: string;
    archived: boolean;
    isInvestment: boolean;
    balance: number;
    currency: string;
  }>;
  incomeVsExpenses: Array<{ month: string; type: string; total: number }>;
  /** month -> { income: [{name, value}], expenses: [...] } */
  incomeExpenseBreakdown?: Record<string, Record<string, Array<{ name: string; value: number }>>>;
  spendingByCategory: Array<{
    categoryName: string;
    categoryGroup: string;
    categoryType: string;
    total: number;
  }>;
};

const HBP_LIMIT = 60_000;
const RRSP_NAME = /\b(rrsp|reer|rrif|ferr)\b/i;

function mean(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
}

function pct(now: number, before: number): number {
  if (!Number.isFinite(before) || before === 0) return 0;
  return (now - before) / Math.abs(before);
}

/**
 * Build the profile from the dashboard payload.
 *
 * `windowMonths` is 12 by design: two months of trailing data would make the
 * savings rate swing wildly with a single car repair.
 */
export function buildProfile(d: DashboardLike, asOf: string, a: Assumptions): HomePlanProfile {
  const income = new Map<string, number>();
  const expense = new Map<string, number>();
  for (const row of d.incomeVsExpenses) {
    const m = row.month;
    if (row.type === "I") income.set(m, (income.get(m) ?? 0) + row.total);
    else if (row.type === "E") expense.set(m, (expense.get(m) ?? 0) + Math.abs(row.total));
  }
  // Cash income only: employer RRSP contributions are savings, not spendable income,
  // and cash-back/dividend rewards are refunds of spending. Counting either inflates
  // the savings rate and every date downstream of it.
  const breakdown = d.incomeExpenseBreakdown;
  if (breakdown) {
    const CASH_INCOME = /salary|payroll|wage|dividend|interest/i;
    const NOT_INCOME = /rrsp|reer|employer|reward|cash ?back|reimburs/i;
    const byMonth = new Map<string, number>();
    for (const [m, groups] of Object.entries(breakdown)) {
      let sum = 0;
      for (const row of groups.income ?? []) {
        if (CASH_INCOME.test(row.name) && !NOT_INCOME.test(row.name)) sum += row.value;
      }
      if (sum > 0) byMonth.set(m, sum);
    }
    if (byMonth.size > 0) {
      income.clear();
      for (const [m, v] of byMonth) income.set(m, v);
    }
  }

  const months = Array.from(new Set([...income.keys(), ...expense.keys()]))
    .filter((m) => (income.get(m) ?? 0) !== 0 || (expense.get(m) ?? 0) !== 0)
    .sort();
  // Never average a month that is still in progress: half a month of rent and
  // half a salary drags both sides down and silently changes every projection.
  const complete = months.filter((m) => m < asOf);
  const usable = complete.length >= 3 ? complete : months;
  const window = usable.slice(-12);
  const prior = usable.slice(-24, -12);

  const incomes = window.map((m) => income.get(m) ?? 0).sort((x, y) => x - y);
  const medianIncome = incomes.length ? incomes[Math.floor(incomes.length / 2)] : 0;
  const peakIncome = incomes.length ? incomes[incomes.length - 1] : 0;
  const bonusEstimate = Math.max(0, peakIncome - medianIncome);
  // A median month is the conservative base case: it drops the bonus spike, which
  // has varied by +-30% year over year and is explicitly not guaranteed.
  const monthlyIncome = a.includeBonus ? mean(incomes) : medianIncome;
  const monthlyExpense = mean(window.map((m) => expense.get(m) ?? 0));
  const priorIncome = mean(prior.map((m) => income.get(m) ?? 0));
  const priorExpense = mean(prior.map((m) => expense.get(m) ?? 0));

  // Rent: prefer the literal Rent category, else the largest Housing & Home line.
  const rentRow =
    d.spendingByCategory.find((c) => /^rent$/i.test(c.categoryName)) ??
    d.spendingByCategory
      .filter((c) => /housing/i.test(c.categoryGroup))
      .sort((x, y) => Math.abs(y.total) - Math.abs(x.total))[0];
  const latest = window[window.length - 1];
  const latestRent = breakdown?.[latest]?.expenses?.find((e) => /^rent$/i.test(e.name));
  const monthlyRent = latestRent
    ? Math.abs(latestRent.value)
    : rentRow
      ? Math.abs(rentRow.total) / Math.max(window.length, 1)
      : 0;

  // Reachable pool: every asset account, minus RRSP money beyond the HBP, minus reserve.
  const assets = d.balances.filter((b) => b.accountType === "A" && !b.archived);
  const totalAssets = assets.reduce((s, b) => s + b.balance, 0);
  const poolAccounts: HomePlanProfile["poolAccounts"] = [];
  const excluded: HomePlanProfile["excluded"] = [];
  let hbpLeft = HBP_LIMIT;
  for (const acct of [...assets].sort((x, y) => y.balance - x.balance)) {
    const name = acct.accountName ?? `Account ${acct.accountId}`;
    if (RRSP_NAME.test(name)) {
      const usable = Math.min(Math.max(acct.balance, 0), hbpLeft);
      hbpLeft -= usable;
      if (usable > 0) poolAccounts.push({ name: `${name} (HBP)`, amount: usable });
      const locked = Math.max(acct.balance - usable, 0);
      if (locked > 0) excluded.push({ name, amount: locked, reason: "RRSP beyond the HBP is taxable to withdraw" });
    } else {
      poolAccounts.push({ name, amount: acct.balance });
    }
  }
  const reachablePool = Math.max(
    0,
    poolAccounts.reduce((s, x) => s + x.amount, 0) - a.reserve
  );

  const dataThrough = asOf;
  return {
    monthlyIncome,
    monthlyExpense,
    monthlyRent,
    reachablePool,
    totalAssets,
    bonusEstimate,
    poolAccounts,
    excluded,
    monthlyNonHousing: Math.max(0, monthlyExpense - monthlyRent),
    windowMonths: window.length,
    windowFrom: window[0] ?? asOf,
    windowTo: window[window.length - 1] ?? asOf,
    trend: {
      income: pct(monthlyIncome, priorIncome),
      expense: pct(monthlyExpense, priorExpense),
      savingsRate:
        pct(
          monthlyIncome > 0 ? (monthlyIncome - monthlyExpense) / monthlyIncome : 0,
          priorIncome > 0 ? (priorIncome - priorExpense) / priorIncome : 0
        ),
    },
    dataThrough,
  };
}

function routeFor(
  kind: "buy20" | "buyMax" | "cash",
  p: HomePlanProfile,
  sc: HomeScenario,
  a: Assumptions,
  asOf: string
): RouteResult {
  const price = sc.purchasePrice;
  const cc20 = closingCosts(price, price * 0.2);
  const down =
    kind === "buy20"
      ? price * 0.2
      : kind === "cash"
        ? price
        : Math.max(0, Math.min(p.reachablePool - cc20.total - sc.vehicleCost, price * 0.95));
  const cc = closingCosts(price, down);
  const loan = Math.max(0, price - down);
  const h = monthlyHousingCost(sc, loan, a.mortgageRate, a.amortizationYears);
  const q = qualifies(p, sc, a, loan);
  const cashNeeded = down + cc.total + sc.vehicleCost;
  const months = monthsUntil(p.reachablePool, p.monthlyIncome - p.monthlyExpense, a.investmentReturn / 12, cashNeeded);
  const monthlyAllIn =
    h.principalInterest + h.tax + h.utilities + h.fees + sc.vehicleMonthly;
  // reachablePool already excludes the reserve, so add it back before spending.
  const liquidAfter = Math.max(0, p.reachablePool + a.reserve - cashNeeded);
  const fixedCosts = monthlyAllIn + p.monthlyNonHousing;
  const runwayMonths =
    fixedCosts > a.stressMonthlyIncome
      ? liquidAfter / (fixedCosts - a.stressMonthlyIncome)
      : Number.POSITIVE_INFINITY;

  return {
    kind,
    downPayment: down,
    loan,
    monthlyPayment: h.principalInterest,
    closingCosts: cc.total,
    welcomeTax: cc.welcomeTax,
    cashNeeded,
    monthlyAllIn,
    monthsUntil: months ?? Number.MAX_SAFE_INTEGER,
    closesOn: months === 0 ? asOf : months === null ? null : addMonths(asOf, months),
    qualifies: q.ok,
    gds: q.gds,
    tds: q.tds,
    liquidAfter,
    runwayMonths,
  };
}

export function planScenario(
  p: HomePlanProfile,
  sc: HomeScenario,
  a: Assumptions,
  asOf: string
): ScenarioPlan {
  const buy20 = routeFor("buy20", p, sc, a, asOf);
  const buyMax = routeFor("buyMax", p, sc, a, asOf);
  const cash = routeFor("cash", p, sc, a, asOf);

  return {
    scenario: sc,
    buy20,
    buyMax,
    cash,
    cashTarget: sc.purchasePrice + closingCosts(sc.purchasePrice, sc.purchasePrice * 0.2).total + sc.vehicleCost,
    maxPriceAt20Pct: maxPurchasePrice(p, sc, a, 0.2),
    breakevenYears: breakevenYears(p, sc, a, "buy20"),
    breakevenYearsHousingOnly: breakevenYears(p, { ...sc, vehicleMonthly: 0 }, a, "buy20"),
    nwRent10: netWorthAt("rent", 10, p, sc, a),
    nwBuy10: netWorthAt("buy20", 10, p, sc, a),
    nwRent25: netWorthAt("rent", 25, p, sc, a),
    nwBuy25: netWorthAt("buy20", 25, p, sc, a),
    unrecoverableMonthly: unrecoverableMonthly(p, sc, a, true),
  };
}

/** Appreciation rate at which buying (20% down) exactly ties renting over `years`. */
export function breakevenAppreciation(
  p: HomePlanProfile,
  sc: HomeScenario,
  a: Assumptions,
  years: number
): number {
  let lo = -0.05;
  let hi = 0.12;
  for (let i = 0; i < 50; i++) {
    const mid = (lo + hi) / 2;
    const probe: Assumptions = { ...a, appreciation: mid };
    const diff = netWorthAt("buy20", years, p, sc, probe) - netWorthAt("rent", years, p, sc, probe);
    if (diff > 0) hi = mid;
    else lo = mid;
  }
  return (lo + hi) / 2;
}

const BUFFER_TARGET_MONTHS = 12;
const BREAKEVEN_HORIZON_YEARS = 10;

/**
 * The one recommendation shown at the top of the page.
 *
 * Priority is deliberate: solvency first, then economics, then opportunity. A
 * great-looking breakeven is worthless if the buffer is two months deep — that
 * is the failure mode of every "max out your down payment" plan.
 */
export function buildVerdict(
  p: HomePlanProfile,
  plans: ScenarioPlan[],
  a: Assumptions,
  asOf: string
): Verdict {
  const feasible = plans.filter((x) => x.buy20.monthsUntil === 0);
  const pool = feasible.length > 0 ? feasible : plans;
  const best = [...pool].sort((x, y) => {
    const bx = x.breakevenYears ?? 99;
    const by = y.breakevenYears ?? 99;
    if (bx !== by) return bx - by;
    return x.scenario.purchasePrice - y.scenario.purchasePrice;
  })[0];

  const savingsRate = p.monthlyIncome > 0 ? (p.monthlyIncome - p.monthlyExpense) / p.monthlyIncome : 0;
  const reasons: string[] = [];
  const flips: string[] = [];

  const be = best?.breakevenYears ?? null;
  const beApp = best ? breakevenAppreciation(p, best.scenario, a, BREAKEVEN_HORIZON_YEARS) : 0;
  const bufferOk = (best?.buy20.runwayMonths ?? 0) >= BUFFER_TARGET_MONTHS;
  const worthIt = be !== null && be <= BREAKEVEN_HORIZON_YEARS;

  if (best) {
    reasons.push(
      `Buying ${best.scenario.label} beats renting after ${
        be === null ? "more than 45 years" : `${be} years`
      } at ${(a.appreciation * 100).toFixed(1)}% appreciation vs ${(a.investmentReturn * 100).toFixed(1)}% returns.`
    );
    reasons.push(
      `Your rent is $${Math.round(p.monthlyRent).toLocaleString()}/mo; owning permanently burns ~$${Math.round(
        best.unrecoverableMonthly
      ).toLocaleString()}/mo in interest, tax, fees and maintenance.`
    );
    reasons.push(
      `Savings rate ${(savingsRate * 100).toFixed(0)}% — about $${Math.round(
        p.monthlyIncome - p.monthlyExpense
      ).toLocaleString()}/mo going into the pool.`
    );
    flips.push(
      `If homes appreciate faster than ${(beApp * 100).toFixed(1)}%/yr, buying wins inside ${BREAKEVEN_HORIZON_YEARS} years.`
    );
    flips.push(
      `If your rent ever resets to market, renting loses its edge immediately — this verdict is rent-sensitive.`
    );
    const carPlan = plans.find((x) => x.scenario.vehicleMonthly > 0 && x.breakevenYearsHousingOnly !== null);
    if (carPlan && carPlan.breakevenYears !== null && carPlan.breakevenYearsHousingOnly !== null) {
      const years = carPlan.breakevenYears - carPlan.breakevenYearsHousingOnly;
      if (years >= 1) {
        flips.push(
          `Dropping the car from ${carPlan.scenario.label} takes its payback from ${carPlan.breakevenYears}y to ${carPlan.breakevenYearsHousingOnly}y — the car alone costs ${years.toFixed(1)} years.`
        );
      }
    }
  }

  if (!best) {
    reasons.push("No scenario could be evaluated from the current ledger data.");
  } else if (!bufferOk) {
    const need = Math.max(0, BUFFER_TARGET_MONTHS * ((best.buy20.monthlyAllIn + p.monthlyNonHousing) - a.stressMonthlyIncome));
    const monthsToBuffer = monthsUntil(best.buy20.liquidAfter, p.monthlyIncome - p.monthlyExpense, a.investmentReturn / 12, need);
    const date = monthsToBuffer === null ? null : addMonths(asOf, monthsToBuffer);
    return {
      action: "wait",
      headline: "KEEP RENTING FOR NOW",
      detail: `You could close today, but it would leave too little cash. At ${best.buy20.runwayMonths === Number.POSITIVE_INFINITY ? "∞" : Math.round(best.buy20.runwayMonths)} months of runway after closing, a layoff turns into a forced sale.`,
      reasons: [
        `Buffer after closing: $${Math.round(best.buy20.liquidAfter).toLocaleString()} against fixed costs of $${Math.round(
          best.buy20.monthlyAllIn + p.monthlyNonHousing
        ).toLocaleString()}/mo.`,
        ...reasons,
      ],
      flips: [`Re-run this when the liquid buffer reaches ${BUFFER_TARGET_MONTHS} months of fixed costs.`, ...flips],
      date,
    };
  } else if (worthIt) {
    const m = best.buy20.monthsUntil;
    return {
      action: "buy",
      headline: m === 0 ? "BUY NOW" : `BUY IN ${(best.buy20.closesOn ?? "").toUpperCase()}`,
      detail: `${best.scenario.label} wins on the numbers, and you can close with $${Math.round(
        best.buy20.liquidAfter
      ).toLocaleString()} still liquid.`,
      reasons,
      flips,
      date: best.buy20.closesOn,
    };
  }

  const reviewAt = addMonths(asOf, 12);
  return {
    action: "rent",
    headline: "KEEP RENTING",
    detail: best
      ? `Renting is the cheaper way to be housed until ${be === null ? "well beyond 45 years" : `${be} years`} from now. Stay invested, revisit at ${reviewAt}.`
      : "Not enough data to evaluate yet.",
    reasons,
    flips,
    date: reviewAt,
  };
}

export { RENT_ESCALATION, payment };
