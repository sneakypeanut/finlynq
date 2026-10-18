"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatCurrency } from "@/lib/currency";
import { useDisplayCurrency } from "@/components/currency-provider";
import {
  Area,
  AreaChart,
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Home,
  PiggyBank,
  RefreshCw,
  TrendingUp,
  Wallet,
} from "lucide-react";
import {
  type Assumptions,
  type HomeScenario,
  DEFAULT_ASSUMPTIONS,
  DEFAULT_SCENARIOS,
  addMonths,
} from "@/lib/home-plan/engine";
import {
  type DashboardLike,
  buildProfile,
  buildVerdict,
  planScenario,
} from "@/lib/home-plan/profile";

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-xl border bg-card p-4">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 font-mono text-xl font-bold">{value}</p>
      {hint ? <p className="mt-1 text-[11px] text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

function Metric({ label, value, tone }: { label: string; value: string; tone?: "good" | "warn" | "bad" }) {
  const color = tone === "good" ? "text-emerald-500" : tone === "bad" ? "text-red-500" : tone === "warn" ? "text-amber-500" : "";
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-dashed py-1.5 last:border-0">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className={`font-mono text-sm font-semibold ${color}`}>{value}</span>
    </div>
  );
}

function Slider({
  label,
  value,
  min,
  max,
  step,
  display,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  display: string;
  onChange: (v: number) => void;
}) {
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-mono font-semibold">{display}</span>
      </div>
      <input
        type="range"
        className="w-full"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        aria-label={label}
      />
    </div>
  );
}

export default function HomePlanPage() {
  const { displayCurrency } = useDisplayCurrency();
  const f = useCallback(
    (n: number) => formatCurrency(n, displayCurrency, { decimals: 0 }),
    [displayCurrency]
  );

  const [dash, setDash] = useState<DashboardLike | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [a, setA] = useState<Assumptions>(DEFAULT_ASSUMPTIONS);
  const [scenarios, setScenarios] = useState<HomeScenario[]>(DEFAULT_SCENARIOS);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/dashboard", { cache: "no-store" });
      if (!res.ok) throw new Error(`dashboard ${res.status}`);
      const json = (await res.json()) as { data?: DashboardLike } & DashboardLike;
      const payload = (json.data ?? json) as DashboardLike;
      if (!payload?.balances || !payload?.incomeVsExpenses) throw new Error("unexpected payload");
      setDash(payload);
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed to load");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const asOf = useMemo(() => new Date().toISOString().slice(0, 7), []);

  const model = useMemo(() => {
    if (!dash) return null;
    const profile = buildProfile(dash, asOf, a);
    const plans = scenarios.map((sc) => planScenario(profile, sc, a, asOf));
    const verdict = buildVerdict(profile, plans, a, asOf);
    return { profile, plans, verdict };
  }, [dash, a, scenarios, asOf]);

  const charts = useMemo(() => {
    if (!model) return null;
    const surplus = model.profile.monthlyIncome - model.profile.monthlyExpense;
    let pool = model.profile.reachablePool;
    const poolSeries: Array<Record<string, number | string>> = [];
    for (let m = 0; m <= 120; m++) {
      if (m > 0) pool = pool * (1 + a.investmentReturn / 12) + surplus;
      poolSeries.push({
        m,
        label: addMonths(asOf, m),
        pool: Math.round(pool),
        targetA: Math.round(model.plans[0].cashTarget),
        targetB: Math.round(model.plans[1]?.cashTarget ?? 0),
      });
    }
    const rentSeries: Array<Record<string, number | string>> = [];
    for (let m = 0; m <= 120; m++) {
      rentSeries.push({
        m,
        label: addMonths(asOf, m),
        rent: Math.round(model.profile.monthlyRent * Math.pow(1.031, m / 12)),
        own: Math.round(model.plans[0].buy20.monthlyAllIn),
      });
    }
    return { poolSeries, rentSeries };
  }, [model, a, asOf]);

  const verdictTone =
    model?.verdict.action === "buy"
      ? "border-emerald-500/40 bg-emerald-500/5"
      : model?.verdict.action === "wait"
        ? "border-amber-500/40 bg-amber-500/5"
        : "border-sky-500/40 bg-sky-500/5";

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Home Plan</h1>
          <p className="text-sm text-muted-foreground">
            Built from your own ledger — recomputed on every load, never a stored copy.
            {model ? ` Trailing ${model.profile.windowMonths} months · ${model.profile.windowFrom} → ${model.profile.windowTo}.` : ""}
          </p>
        </div>
        <button
          onClick={() => void load()}
          className="inline-flex items-center gap-2 rounded-lg border px-3 py-1.5 text-xs font-medium hover:bg-muted"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
          Recompute
        </button>
      </div>

      {error ? (
        <Card>
          <CardContent className="flex items-center gap-2 p-4 text-sm text-red-500">
            <AlertTriangle className="h-4 w-4" /> Could not load ledger data: {error}
          </CardContent>
        </Card>
      ) : null}

      {!model ? (
        <Card>
          <CardContent className="p-6 text-sm text-muted-foreground">
            {loading ? "Reading your ledger…" : "No data."}
          </CardContent>
        </Card>
      ) : (
        <>
          {/* ---------------- verdict ---------------- */}
          <div className={`rounded-2xl border-2 p-6 ${verdictTone}`}>
            <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-widest text-muted-foreground">
              {model.verdict.action === "buy" ? (
                <CheckCircle2 className="h-4 w-4" />
              ) : (
                <Home className="h-4 w-4" />
              )}
              Recommendation{model.verdict.date ? ` · review ${model.verdict.date}` : ""}
            </div>
            <h2 className="mt-2 text-3xl font-extrabold tracking-tight sm:text-4xl">
              {model.verdict.headline}
            </h2>
            <p className="mt-2 max-w-3xl text-sm text-muted-foreground">{model.verdict.detail}</p>
            <div className="mt-4 grid gap-4 md:grid-cols-2">
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Why</p>
                <ul className="mt-1 space-y-1 text-sm">
                  {model.verdict.reasons.map((r) => (
                    <li key={r} className="flex gap-2">
                      <ArrowRight className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      <span>{r}</span>
                    </li>
                  ))}
                </ul>
              </div>
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">What would flip it</p>
                <ul className="mt-1 space-y-1 text-sm">
                  {model.verdict.flips.map((r) => (
                    <li key={r} className="flex gap-2">
                      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500" />
                      <span>{r}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </div>

          {/* ---------------- profile ---------------- */}
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            <Stat
              label="Monthly income"
              value={f(model.profile.monthlyIncome)}
              hint={`median month${a.includeBonus ? " + bonus" : ", bonus excluded"}`}
            />
            <Stat
              label="Monthly spend"
              value={f(model.profile.monthlyExpense)}
              hint={`rent ${f(model.profile.monthlyRent)} · other ${f(model.profile.monthlyNonHousing)}`}
            />
            <Stat
              label="Savings rate"
              value={`${(((model.profile.monthlyIncome - model.profile.monthlyExpense) / Math.max(model.profile.monthlyIncome, 1)) * 100).toFixed(0)}%`}
              hint={`${f(model.profile.monthlyIncome - model.profile.monthlyExpense)}/mo surplus`}
            />
            <Stat label="Reachable pool" value={f(model.profile.reachablePool)} hint={`of ${f(model.profile.totalAssets)} assets`} />
            <Stat
              label="Qualifies to"
              value={f(Math.max(...model.plans.map((p) => p.maxPriceAt20Pct)))}
              hint="at 20% down, stress-tested"
            />
          </div>

          {/* ---------------- scenarios ---------------- */}
          <div className="grid gap-4 lg:grid-cols-2">
            {model.plans.map((plan) => (
              <Card key={plan.scenario.key}>
                <CardHeader className="pb-2">
                  <CardTitle className="flex items-center justify-between text-base">
                    <span>{plan.scenario.label}</span>
                    <Badge variant="outline">{f(plan.scenario.purchasePrice)}</Badge>
                  </CardTitle>
                  {plan.scenario.note ? (
                    <p className="text-xs text-muted-foreground">{plan.scenario.note}</p>
                  ) : null}
                </CardHeader>
                <CardContent className="space-y-1">
                  <Metric
                    label="Buy now — 20% down"
                    value={`${f(plan.buy20.monthlyAllIn)}/mo`}
                    tone={plan.buy20.monthsUntil === 0 ? "good" : "warn"}
                  />
                  <Metric label="cash at closing" value={f(plan.buy20.cashNeeded)} />
                  <Metric label="welcome tax" value={f(plan.buy20.welcomeTax)} />
                  <Metric label="liquid after closing" value={f(plan.buy20.liquidAfter)} />
                  <Metric
                    label="runway if income stopped"
                    value={
                      plan.buy20.runwayMonths === Number.POSITIVE_INFINITY
                        ? "covered"
                        : `${Math.round(plan.buy20.runwayMonths)} months`
                    }
                    tone={plan.buy20.runwayMonths >= 12 ? "good" : plan.buy20.runwayMonths >= 6 ? "warn" : "bad"}
                  />
                  <Metric label="maxed out — down payment" value={f(plan.buyMax.downPayment)} />
                  <Metric label="maxed out — monthly" value={`${f(plan.buyMax.monthlyAllIn)}/mo`} />
                  <Metric
                    label="all cash — needs"
                    value={f(plan.cash.cashNeeded)}
                    tone={plan.cash.monthsUntil === 0 ? "good" : undefined}
                  />
                  <Metric
                    label="all cash — when"
                    value={plan.cash.closesOn ?? "beyond 50 years"}
                    tone={plan.cash.monthsUntil === 0 ? "good" : undefined}
                  />
                  <Metric
                    label="buying wins after"
                    value={plan.breakevenYears === null ? ">45 years" : `${plan.breakevenYears} years`}
                    tone={plan.breakevenYears !== null && plan.breakevenYears <= 10 ? "good" : "warn"}
                  />
                  <Metric label="burned monthly if you own" value={`${f(plan.unrecoverableMonthly)}/mo`} />
                  {plan.scenario.vehicleMonthly > 0 ? (
                    <Metric
                      label="buying wins after (housing only)"
                      value={plan.breakevenYearsHousingOnly === null ? ">45 years" : `${plan.breakevenYearsHousingOnly} years`}
                      tone={plan.breakevenYearsHousingOnly !== null && plan.breakevenYearsHousingOnly <= 10 ? "good" : "warn"}
                    />
                  ) : null}
                  <div className="mt-3 grid grid-cols-2 gap-2 text-center">
                    <div className="rounded-lg border p-2">
                      <p className="text-[11px] text-muted-foreground">Net worth in 10y</p>
                      <p className="font-mono text-sm font-semibold">{f(plan.nwBuy10)}</p>
                      <p className="text-[10px] text-muted-foreground">rent: {f(plan.nwRent10)}</p>
                    </div>
                    <div className="rounded-lg border p-2">
                      <p className="text-[11px] text-muted-foreground">Net worth in 25y</p>
                      <p className="font-mono text-sm font-semibold">{f(plan.nwBuy25)}</p>
                      <p className="text-[10px] text-muted-foreground">rent: {f(plan.nwRent25)}</p>
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>

          {/* ---------------- assumptions ---------------- */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-base">
                <TrendingUp className="h-4 w-4" /> Assumptions
              </CardTitle>
              <p className="text-xs text-muted-foreground">
                These are the only numbers not taken from your ledger. The verdict is most sensitive to appreciation.
              </p>
            </CardHeader>
            <CardContent className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <Slider
                label="Home appreciation"
                value={a.appreciation * 100}
                min={-2}
                max={8}
                step={0.1}
                display={`${(a.appreciation * 100).toFixed(1)}%/yr`}
                onChange={(v) => setA({ ...a, appreciation: v / 100 })}
              />
              <Slider
                label="Investment return"
                value={a.investmentReturn * 100}
                min={0}
                max={9}
                step={0.1}
                display={`${(a.investmentReturn * 100).toFixed(1)}%/yr`}
                onChange={(v) => setA({ ...a, investmentReturn: v / 100 })}
              />
              <Slider
                label="Mortgage rate"
                value={a.mortgageRate * 100}
                min={2.5}
                max={8}
                step={0.01}
                display={`${(a.mortgageRate * 100).toFixed(2)}%`}
                onChange={(v) => setA({ ...a, mortgageRate: v / 100 })}
              />
              <Slider
                label="Emergency reserve"
                value={a.reserve}
                min={5000}
                max={80000}
                step={1000}
                display={f(a.reserve)}
                onChange={(v) => setA({ ...a, reserve: v })}
              />
              <label className="flex items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={a.includeBonus}
                  onChange={(e) => setA({ ...a, includeBonus: e.target.checked })}
                />
                <span>
                  Bank the annual bonus (+{f(model.profile.bonusEstimate)}/mo) — off by default, it isn&apos;t guaranteed
                </span>
              </label>
              {scenarios.map((sc, i) => (
                <Slider
                  key={sc.key}
                  label={`${sc.label} — price`}
                  value={sc.purchasePrice}
                  min={200000}
                  max={800000}
                  step={5000}
                  display={f(sc.purchasePrice)}
                  onChange={(v) => {
                    const next = [...scenarios];
                    next[i] = { ...sc, purchasePrice: v };
                    setScenarios(next);
                  }}
                />
              ))}
            </CardContent>
          </Card>

          {/* ---------------- charts ---------------- */}
          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-base">
                  <PiggyBank className="h-4 w-4" /> Pool vs cash targets
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="h-56">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={charts?.poolSeries ?? []}>
                      <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                      <XAxis dataKey="label" tick={{ fontSize: 10 }} interval={23} />
                      <YAxis tick={{ fontSize: 10 }} tickFormatter={(v: number) => `${Math.round(v / 1000)}k`} />
                      <Tooltip formatter={(v) => f(Number(v))} />
                      <Line type="monotone" dataKey="pool" name="reachable pool" strokeWidth={2} dot={false} stroke="hsl(var(--primary))" />
                      <ReferenceLine y={charts?.poolSeries?.[0]?.targetA as number} stroke="#94a3b8" strokeDasharray="4 4" />
                      <ReferenceLine y={charts?.poolSeries?.[0]?.targetB as number} stroke="#cbd5e1" strokeDasharray="2 4" />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-base">
                  <Wallet className="h-4 w-4" /> Rent vs owning, monthly
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="h-56">
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={charts?.rentSeries ?? []}>
                      <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                      <XAxis dataKey="label" tick={{ fontSize: 10 }} interval={23} />
                      <YAxis tick={{ fontSize: 10 }} tickFormatter={(v: number) => `${Math.round(v)}`} />
                      <Tooltip formatter={(v) => f(Number(v))} />
                      <Area type="monotone" dataKey="own" name="owning all-in" stroke="#0ea5e9" fill="#0ea5e9" fillOpacity={0.15} />
                      <Area type="monotone" dataKey="rent" name="rent" stroke="#94a3b8" fill="#94a3b8" fillOpacity={0.1} />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              </CardContent>
            </Card>
          </div>

          {/* ---------------- provenance ---------------- */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Where these numbers come from</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-xs text-muted-foreground">
              <div>
                <p className="font-semibold text-foreground">From your ledger (live)</p>
                <p>
                  Income, spend, savings rate and rent are trailing-{model.profile.windowMonths}-month averages of your
                  categorised transactions. The pool is every asset account at market value, minus RRSP money beyond the
                  $60,000 Home Buyers&apos; Plan limit, minus your reserve.
                </p>
                <ul className="mt-1 columns-2 gap-4">
                  {model.profile.poolAccounts.map((x) => (
                    <li key={x.name}>
                      {x.name}: {f(x.amount)}
                    </li>
                  ))}
                </ul>
                {model.profile.excluded.length > 0 ? (
                  <ul className="mt-1">
                    {model.profile.excluded.map((x) => (
                      <li key={x.name}>
                        Excluded — {x.name}: {f(x.amount)} ({x.reason})
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
              <div>
                <p className="font-semibold text-foreground">Jurisdiction rules (verified 2026-10-17)</p>
                <p>
                  Montreal welcome tax 2026: 0.5% ≤ $62,900 · 1% ≤ $315,000 · 1.5% ≤ $552,300 · comparative factor 1.00, no
                  flat fee. Mortgage insurance premium bands per CMHC/Sagen/Canada Guaranty, taxed at the Québec
                  insurance-premium rate of 9% (9.975% from 2027) — GST/QST do not apply to premiums. Mortgage interest
                  compounds semi-annually. Qualifying: 39% GDS / 44% TDS at contract+2% or 5.25%.
                </p>
              </div>
              <div>
                <p className="font-semibold text-foreground">Assumptions you can move above</p>
                <p>
                  Appreciation, investment return, mortgage rate, reserve and prices. Rent is assumed to escalate at
                  3.1%/yr (TAL 2026 base component); your surplus is held flat, which assumes salary growth offsets rent
                  growth. Maintenance 0.5%/yr, selling costs 5%. No capital-gains tax is modelled. Suburban condo fees and
                  property-tax rates are estimates — verify against the actual listing and city.
                </p>
              </div>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
