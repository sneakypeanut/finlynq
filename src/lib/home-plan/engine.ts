/**
 * Home-purchase planning engine.
 *
 * Pure functions only — no DB, no React, no dates from the clock. Everything the
 * page needs comes in as a `HomePlanProfile` (built from the user's own ledger by
 * the caller) plus a set of `Assumptions`.
 *
 * Jurisdiction rules encoded here are Quebec / City of Montreal, verified
 * 2026-10-17 against montreal.ca and Revenu Québec:
 *   - droits de mutation (welcome tax) 2026 marginal grid, comparative factor 1.00
 *   - mortgage default insurance premium bands (CMHC/Sagen/Canada Guaranty)
 *   - the Quebec insurance-premium tax on that premium is 9% (9.975% from 2027).
 *     GST/QST do NOT apply to insurance premiums — a common modelling error.
 *   - OSFI/CMHC qualifying: 39% GDS / 44% TDS at contract+2% or 5.25%
 *
 * Canadian mortgages compound semi-annually, not monthly: the effective monthly
 * rate is (1 + r/2)^(1/6) - 1. Using r/12 understates the payment.
 */

export const HOME_PLAN_VERSION = 1;

export type Assumptions = {
  /** Mortgage rate used for new financing (annual, nominal, semi-annual compounding). */
  mortgageRate: number;
  amortizationYears: number;
  /** Expected annual return on money that is NOT in the house. */
  investmentReturn: number;
  /** Expected annual home appreciation. The single most load-bearing assumption. */
  appreciation: number;
  /** Cash to keep untouched as an emergency fund. */
  reserve: number;
  /** Annual interior maintenance / special-assessment allowance, as a fraction of value. */
  maintenanceRate: number;
  /** Selling costs at exit (commission + notary + misc), as a fraction of value. */
  sellingCostRate: number;
  /** Monthly income assumed if the salary stops (EI + partial replacement). */
  stressMonthlyIncome: number;
  /**
   * Gross annual income, used ONLY for GDS/TDS. The ledger records net deposits,
   * so this cannot be derived from it — using net income as gross would understate
   * the qualifying ceiling by roughly a third.
   */
  grossAnnualIncome: number;
  /**
   * Bank the annual bonus in the projection. Off by default: the bonus has varied
   * +-30% year to year, so the base case is salary only and the bonus is upside.
   */
  includeBonus: boolean;
};

export const DEFAULT_ASSUMPTIONS: Assumptions = {
  mortgageRate: 0.0434,
  amortizationYears: 25,
  investmentReturn: 0.035,
  appreciation: 0.025,
  reserve: 34000,
  maintenanceRate: 0.005,
  sellingCostRate: 0.05,
  stressMonthlyIncome: 3100,
  grossAnnualIncome: 126000,
  includeBonus: false,
};

/** Verified 2026 City of Montreal grid (provincial grid is identical to $315k). */
export const WELCOME_TAX_BRACKETS: ReadonlyArray<readonly [number, number]> = [
  [62_900, 0.005],
  [315_000, 0.01],
  [552_300, 0.015],
  [1_104_700, 0.02],
  [2_136_500, 0.025],
  [3_113_000, 0.035],
  [Number.MAX_SAFE_INTEGER, 0.04],
];

/** Loan-to-value ceiling → premium rate. No insurance is required at or below 80% LTV. */
const CMHC_BANDS: ReadonlyArray<readonly [number, number]> = [
  [0.85, 0.028],
  [0.9, 0.031],
  [0.95, 0.04],
];
const CMHC_MIN_LTV = 0.8;
const INSURANCE_TAX_RATE = 0.09;

export type HomeScenario = {
  key: string;
  label: string;
  purchasePrice: number;
  condoFeesMonthly: number;
  utilitiesMonthly: number;
  /** Municipal + school tax as a fraction of price (assessed value runs ~90% of price). */
  propertyTaxRate: number;
  /** Extra one-time cash for a car, and its monthly running cost. */
  vehicleCost: number;
  vehicleMonthly: number;
  note?: string;
};

export const DEFAULT_SCENARIOS: HomeScenario[] = [
  {
    key: "A",
    label: "1-bed condo, Griffintown",
    purchasePrice: 400_000,
    condoFeesMonthly: 425,
    utilitiesMonthly: 65,
    propertyTaxRate: 0.0063,
    vehicleCost: 0,
    vehicleMonthly: 0,
    note: "Centris median asking, 1-bed, 561 sq ft",
  },
  {
    key: "B",
    label: "Studio / loft, Brossard + car",
    purchasePrice: 313_842,
    condoFeesMonthly: 250,
    utilitiesMonthly: 60,
    propertyTaxRate: 0.0063,
    vehicleCost: 17_000,
    vehicleMonthly: 399,
    note: "REM to Gare Centrale in 18 min",
  },
];

/** Everything the engine needs from the user's ledger, already reduced to monthly figures. */
export type HomePlanProfile = {
  /** Average monthly income across the trailing window (net, deposits only). */
  monthlyIncome: number;
  /** Average monthly expense across the trailing window (housing included). */
  monthlyExpense: number;
  /** Current rent, monthly. */
  monthlyRent: number;
  /** Cash + registered accounts reachable for a down payment, reserve already excluded. */
  reachablePool: number;
  /** Total assets, for context. */
  totalAssets: number;
  /** Detected annual bonus: the gap between the peak month and the median month. */
  bonusEstimate: number;
  /** Account names contributing to the pool, largest first. */
  poolAccounts: Array<{ name: string; amount: number }>;
  /** Money excluded from the pool (RRSP beyond the HBP, etc.). */
  excluded: Array<{ name: string; amount: number; reason: string }>;
  /** Non-housing spend per month (used for runway). */
  monthlyNonHousing: number;
  /** Window the averages were computed over. */
  windowMonths: number;
  windowFrom: string;
  windowTo: string;
  /** Month-over-month direction of the key figures. */
  trend: { income: number; expense: number; savingsRate: number };
  /** Latest transaction date seen in the ledger. */
  dataThrough: string;
};

export type RouteResult = {
  kind: "buy20" | "buyMax" | "cash";
  downPayment: number;
  loan: number;
  monthlyPayment: number;
  closingCosts: number;
  welcomeTax: number;
  cashNeeded: number;
  monthlyAllIn: number;
  /** Months until the pool covers this route (0 = affordable today). */
  monthsUntil: number;
  closesOn: string | null;
  qualifies: boolean;
  gds: number;
  tds: number;
  /** Liquid cash remaining after closing. */
  liquidAfter: number;
  /** Months of fixed costs covered by that liquid cash if income dropped to stress level. */
  runwayMonths: number;
};

export type ScenarioPlan = {
  scenario: HomeScenario;
  buy20: RouteResult;
  buyMax: RouteResult;
  cash: RouteResult;
  cashTarget: number;
  maxPriceAt20Pct: number;
  /** Years until buying beats renting, at the current assumptions (null = never within 45y). */
  breakevenYears: number | null;
  /** Same test with the vehicle stripped out, so a car can't decide the answer. */
  breakevenYearsHousingOnly: number | null;
  /** Net worth at 10 and 25 years for rent vs buy. */
  nwRent10: number;
  nwBuy10: number;
  nwRent25: number;
  nwBuy25: number;
  /** Monthly cost that genuinely leaves your net worth (interest + tax + fees + heat + maint). */
  unrecoverableMonthly: number;
};

export type Verdict = {
  action: "rent" | "buy" | "wait";
  headline: string;
  detail: string;
  /** Machine-readable reasons, most important first. */
  reasons: string[];
  /** What would change this verdict. */
  flips: string[];
  /** Suggested decision date / review date. */
  date: string | null;
};

// --------------------------------------------------------------------- maths

export function monthlyRate(annualNominal: number): number {
  return Math.pow(1 + annualNominal / 2, 1 / 6) - 1;
}

export function payment(principal: number, annualNominal: number, years: number): number {
  if (principal <= 0) return 0;
  const i = monthlyRate(annualNominal);
  const n = Math.round(years * 12);
  if (i === 0) return principal / n;
  return (principal * i) / (1 - Math.pow(1 + i, -n));
}

export function welcomeTax(price: number): number {
  let total = 0;
  let prev = 0;
  for (const [ceiling, rate] of WELCOME_TAX_BRACKETS) {
    const slab = Math.min(price, ceiling) - prev;
    if (slab <= 0) break;
    total += slab * rate;
    prev = ceiling;
  }
  return total;
}

export function cmhcPremium(loan: number, price: number): number {
  const ltv = loan / price;
  if (ltv <= CMHC_MIN_LTV + 1e-9) return 0;
  for (const [maxLtv, rate] of CMHC_BANDS) {
    if (ltv <= maxLtv + 1e-9) return loan * rate;
  }
  return loan * 0.045;
}

export type ClosingCosts = {
  welcomeTax: number;
  notary: number;
  review: number;
  insuranceTax: number;
  total: number;
};

export function closingCosts(price: number, down: number): ClosingCosts {
  const premium = cmhcPremium(price - down, price);
  const wt = welcomeTax(price);
  const notary = 2000;
  const review = 700;
  const insuranceTax = premium * INSURANCE_TAX_RATE;
  return { welcomeTax: wt, notary, review, insuranceTax, total: wt + notary + review + insuranceTax };
}

export function monthlyHousingCost(
  sc: HomeScenario,
  loan: number,
  annualRate: number,
  years: number
): { principalInterest: number; tax: number; utilities: number; fees: number; gdsHousing: number } {
  const pi = payment(loan, annualRate, years);
  const tax = (sc.purchasePrice * sc.propertyTaxRate) / 12;
  const fees = sc.condoFeesMonthly;
  return {
    principalInterest: pi,
    tax,
    utilities: sc.utilitiesMonthly,
    fees,
    gdsHousing: pi + tax + sc.utilitiesMonthly + 0.5 * fees,
  };
}

export function gdsRatio(
  sc: HomeScenario,
  loan: number,
  grossAnnualIncome: number,
  annualRate: number,
  years: number
): number {
  const h = monthlyHousingCost(sc, loan, annualRate, years);
  return h.gdsHousing / (grossAnnualIncome / 12);
}

const GDS_LIMIT = 0.39;
const TDS_LIMIT = 0.44;

export function qualifyingRate(a: Assumptions): number {
  return Math.max(a.mortgageRate + 0.02, 0.0525);
}

export function qualifies(p: HomePlanProfile, sc: HomeScenario, a: Assumptions, loan: number): { ok: boolean; gds: number; tds: number } {
  const stress = qualifyingRate(a);
  const gds = gdsRatio(sc, loan, a.grossAnnualIncome, stress, a.amortizationYears);
  const tds = gds; // no other debt payment is modelled; TDS == GDS until a loan exists
  return { ok: gds <= GDS_LIMIT && tds <= TDS_LIMIT, gds, tds };
}

export function maxPurchasePrice(p: HomePlanProfile, sc: HomeScenario, a: Assumptions, downPct = 0.2): number {
  let lo = 50_000;
  let hi = 3_000_000;
  const stress = qualifyingRate(a);
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    // property tax and fees scale with price where they are modelled as such
    const probe: HomeScenario = { ...sc, purchasePrice: mid };
    const gds = gdsRatio(probe, mid * (1 - downPct), a.grossAnnualIncome, stress, a.amortizationYears);
    if (gds <= GDS_LIMIT) lo = mid;
    else hi = mid;
  }
  return lo;
}

/** Months until the reachable pool covers `target`, contributing `surplus` monthly. */
export function monthsUntil(pool: number, surplus: number, monthlyReturn: number, target: number, cap = 600): number | null {
  if (pool >= target) return 0;
  let balance = pool;
  for (let m = 1; m <= cap; m++) {
    balance = balance * (1 + monthlyReturn) + surplus;
    if (balance >= target) return m;
  }
  return null;
}

export function addMonths(isoDate: string, months: number): string {
  const [y, m] = isoDate.split("-").map(Number);
  const total = y * 12 + (m - 1) + months;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  return `${ny}-${String(nm).padStart(2, "0")}`;
}

// ------------------------------------------------------------- net worth sim

/** TAL 2026 base rent-increase component; rent is assumed to escalate at this rate. */
export const RENT_ESCALATION = 0.031;

type SimState = { liquid: number; home: number; balance: number };

/**
 * Month-by-month simulation of one route.
 *
 * Cash discipline: the payment leaves `liquid` (principal is not spent — it lands
 * in `home`), so net worth is liquid + home - balance, less selling costs on exit.
 * Savings each month = income - non-housing spend - that route's actual outflow.
 */
export function simulate(
  kind: "rent" | "buy20" | "buyMax" | "cash",
  months: number,
  p: HomePlanProfile,
  sc: HomeScenario,
  a: Assumptions
): SimState {
  const r = a.investmentReturn / 12;
  const g = Math.pow(1 + a.appreciation, 1 / 12) - 1;
  let liquid = p.reachablePool + a.reserve;
  let home = 0;
  let balance = 0;
  let fixedPayment = 0;
  const i = monthlyRate(a.mortgageRate);

  if (kind !== "rent") {
    let down = 0;
    if (kind === "buy20") down = sc.purchasePrice * 0.2;
    if (kind === "buyMax") {
      // Closing costs are essentially unchanged by the down size above 20%;
      // estimate them once to size the down payment, then recompute for real.
      const cc0 = closingCosts(sc.purchasePrice, sc.purchasePrice * 0.2);
      down = Math.max(0, Math.min(liquid - cc0.total - sc.vehicleCost, sc.purchasePrice * 0.95));
    }
    const cc = closingCosts(sc.purchasePrice, down);
    liquid -= down + cc.total + sc.vehicleCost;
    home = sc.purchasePrice;
    if (kind !== "cash") {
      balance = sc.purchasePrice - down;
      fixedPayment = payment(balance, a.mortgageRate, a.amortizationYears);
    }
  }

  for (let m = 1; m <= months; m++) {
    let outflow: number;
    if (kind === "rent") {
      outflow = p.monthlyRent * Math.pow(1 + RENT_ESCALATION, m / 12);
    } else {
      if (balance > 0) {
        const interest = balance * i;
        const principal = Math.min(fixedPayment - interest, balance);
        balance = Math.max(0, balance - principal);
      }
      const tax = (home * sc.propertyTaxRate) / 12;
      const maint = (home * a.maintenanceRate) / 12;
      outflow =
        (balance > 0 ? fixedPayment : 0) +
        tax +
        maint +
        sc.utilitiesMonthly +
        sc.condoFeesMonthly +
        sc.vehicleMonthly;
      home *= 1 + g;
    }
    liquid = liquid * (1 + r) + (p.monthlyIncome - p.monthlyNonHousing - outflow);
  }
  return { liquid, home, balance };
}

export function netWorthAt(
  kind: "rent" | "buy20" | "buyMax" | "cash",
  years: number,
  p: HomePlanProfile,
  sc: HomeScenario,
  a: Assumptions
): number {
  const s = simulate(kind, Math.round(years * 12), p, sc, a);
  const sellCost = s.home > 0 ? s.home * a.sellingCostRate : 0;
  return s.liquid + s.home - s.balance - sellCost;
}

export function breakevenYears(
  p: HomePlanProfile,
  sc: HomeScenario,
  a: Assumptions,
  kind: "buy20" | "buyMax" = "buy20",
  cap = 45
): number | null {
  let prev: { y: number; d: number } | null = null;
  for (let y = 1; y <= cap; y++) {
    const d = netWorthAt(kind, y, p, sc, a) - netWorthAt("rent", y, p, sc, a);
    if (d > 0) {
      if (!prev) return y;
      const yrs = prev.y + ((y - prev.y) * -prev.d) / (d - prev.d);
      return Math.round(yrs * 10) / 10;
    }
    prev = { y, d };
  }
  return null;
}

/** Monthly cost that never comes back: year-1 interest + tax + fees + heat + maintenance. */
export function unrecoverableMonthly(
  p: HomePlanProfile,
  sc: HomeScenario,
  a: Assumptions,
  withMortgage: boolean
): number {
  const loan = withMortgage ? sc.purchasePrice * 0.8 : 0;
  const h = monthlyHousingCost(sc, loan, a.mortgageRate, a.amortizationYears);
  const maint = (sc.purchasePrice * a.maintenanceRate) / 12;
  let monthlyInterest = 0;
  if (withMortgage && loan > 0) {
    // Exact year-1 average interest from a real 12-month amortisation.
    const i = monthlyRate(a.mortgageRate);
    const pay = payment(loan, a.mortgageRate, a.amortizationYears);
    let bal = loan;
    let interest = 0;
    for (let m = 0; m < 12 && bal > 0; m++) {
      const part = bal * i;
      interest += part;
      bal = Math.max(0, bal - (pay - part));
    }
    monthlyInterest = interest / 12;
  }
  return h.tax + h.utilities + h.fees + maint + monthlyInterest + sc.vehicleMonthly;
}

