import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/auth/require-auth";
import { db, schema } from "@/db";
import { eq, and } from "drizzle-orm";
import { validateBody, safeErrorMessage, logApiError } from "@/lib/validate";
import {
  DEFAULT_ASSUMPTIONS,
  DEFAULT_SCENARIOS,
  type HomePlanSettings,
  type HomeScenario,
} from "@/lib/home-plan/engine";

/**
 * Per-user Home Plan assumptions and scenarios.
 *
 * Persisted as one JSON blob in the generic `settings` table under
 * `key='home_plan_v1'`, mirroring tx-columns and display-currency. Before this
 * route, the defaults lived only in `engine.ts`, so changing a rate or pricing
 * a new listing meant editing code and rebuilding the image. Now the page
 * loads the saved plan, writes edits here, and the shipped defaults only seed
 * a user who has never customised anything.
 */

const KEY = "home_plan_v1";

const assumptionsSchema = z.object({
  mortgageRate: z.number().min(0).max(0.25),
  amortizationYears: z.number().int().min(5).max(40),
  investmentReturn: z.number().min(-0.05).max(0.25),
  appreciation: z.number().min(-0.1).max(0.25),
  reserve: z.number().min(0).max(2_000_000),
  maintenanceRate: z.number().min(0).max(0.1),
  sellingCostRate: z.number().min(0).max(0.25),
  stressMonthlyIncome: z.number().min(0).max(100_000),
  grossAnnualIncome: z.number().min(0).max(10_000_000),
  includeBonus: z.boolean(),
});

const scenarioSchema = z.object({
  key: z.string().trim().min(1).max(8),
  label: z.string().trim().min(1).max(80),
  purchasePrice: z.number().min(25_000).max(10_000_000),
  condoFeesMonthly: z.number().min(0).max(10_000),
  utilitiesMonthly: z.number().min(0).max(5_000),
  propertyTaxRate: z.number().min(0).max(0.1),
  vehicleCost: z.number().min(0).max(500_000),
  vehicleMonthly: z.number().min(0).max(10_000),
  note: z.string().trim().max(200).optional(),
});

const putSchema = z
  .object({
    assumptions: assumptionsSchema,
    scenarios: z.array(scenarioSchema).min(1).max(4),
  })
  .refine(
    (v) => new Set(v.scenarios.map((s) => s.key)).size === v.scenarios.length,
    { message: "Scenario keys must be unique" }
  );

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Tolerant read: fill missing fields from the shipped defaults, then validate.
 * A blob saved before a field existed keeps its customised values instead of
 * being thrown away, and a corrupt blob degrades to the defaults.
 */
function parseSaved(raw: unknown): HomePlanSettings | null {
  if (!isRecord(raw)) return null;

  const savedAssumptions = isRecord(raw.assumptions) ? raw.assumptions : {};
  const assumptions = assumptionsSchema.safeParse({
    ...DEFAULT_ASSUMPTIONS,
    ...savedAssumptions,
  });
  if (!assumptions.success) return null;

  const defaultsByKey = new Map(DEFAULT_SCENARIOS.map((s) => [s.key, s]));
  const input = Array.isArray(raw.scenarios) ? raw.scenarios : [];
  const scenarios: HomeScenario[] = [];
  const seen = new Set<string>();
  for (const item of input) {
    const key = isRecord(item) && typeof item.key === "string" ? item.key : null;
    if (!key || seen.has(key)) continue;
    const merged = isRecord(item)
      ? { ...(defaultsByKey.get(key) ?? {}), ...item }
      : null;
    if (!merged) continue;
    const parsed = scenarioSchema.safeParse(merged);
    if (!parsed.success) continue;
    seen.add(key);
    scenarios.push(parsed.data);
  }
  if (scenarios.length === 0) return null;

  return { assumptions: assumptions.data, scenarios };
}

/** Keep defaults for scenarios the user has not customised; append extra ones. */
function withDefaults(saved: HomePlanSettings | null): HomePlanSettings {
  if (!saved) {
    return {
      assumptions: { ...DEFAULT_ASSUMPTIONS },
      scenarios: DEFAULT_SCENARIOS.map((s) => ({ ...s })),
    };
  }
  const savedByKey = new Map(saved.scenarios.map((s) => [s.key, s]));
  const scenarios = DEFAULT_SCENARIOS.map(
    (d) => savedByKey.get(d.key) ?? { ...d }
  );
  for (const s of saved.scenarios) {
    if (!DEFAULT_SCENARIOS.some((d) => d.key === s.key)) scenarios.push(s);
  }
  return { assumptions: saved.assumptions, scenarios };
}

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request);
  if (!auth.authenticated) return auth.response;

  const row = await db
    .select({ value: schema.settings.value })
    .from(schema.settings)
    .where(
      and(
        eq(schema.settings.key, KEY),
        eq(schema.settings.userId, auth.context.userId)
      )
    )
    .limit(1);

  let saved: HomePlanSettings | null = null;
  if (row[0]?.value) {
    try {
      saved = parseSaved(JSON.parse(row[0].value));
    } catch {
      // Corrupt JSON — fall through to the defaults rather than 500 the page.
    }
  }

  return NextResponse.json({
    ...withDefaults(saved),
    customised: Boolean(row[0]?.value),
  });
}

export async function PUT(request: NextRequest) {
  const auth = await requireAuth(request);
  if (!auth.authenticated) return auth.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const parsed = validateBody(body, putSchema);
  if (parsed.error) return parsed.error;

  const settings: HomePlanSettings = {
    assumptions: parsed.data.assumptions,
    scenarios: parsed.data.scenarios,
  };

  try {
    await db
      .insert(schema.settings)
      .values({
        key: KEY,
        userId: auth.context.userId,
        value: JSON.stringify(settings),
      })
      .onConflictDoUpdate({
        target: [schema.settings.key, schema.settings.userId],
        set: { value: JSON.stringify(settings) },
      });
    return NextResponse.json({ ...settings, customised: true });
  } catch (error: unknown) {
    await logApiError("PUT", "/api/home-plan", error, auth.context.userId);
    return NextResponse.json(
      { error: safeErrorMessage(error, "Failed to save the home plan") },
      { status: 500 }
    );
  }
}
