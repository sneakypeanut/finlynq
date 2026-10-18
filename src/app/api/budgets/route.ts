import { NextRequest, NextResponse } from "next/server";
import { getBudgets, upsertBudget, deleteBudget, getBudgetRollover, getSpendingByCategoryAndCurrency, getBudgetsInRange, getMonthlySpendByCategory } from "@/lib/queries";
import { computeRolling, indexHistory, addMonths } from "@/lib/budgets/rolling";
import { requireAuth } from "@/lib/auth/require-auth";
import { z } from "zod";
import { validateBody, safeErrorMessage, logApiError } from "@/lib/validate";
import { getRateMap, convertWithRateMap, getDisplayCurrency } from "@/lib/fx-service";
import { verifyOwnership, OwnershipError } from "@/lib/verify-ownership";
import { decryptName } from "@/lib/crypto/encrypted-columns";
import { safeName } from "@/lib/safe-name";

const postSchema = z.object({
  categoryId: z.number(),
  month: z.string(),
  amount: z.number(),
  currency: z.string().optional(),
});

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request); if (!auth.authenticated) return auth.response;
  const { userId, dek } = auth.context;
  const month = request.nextUrl.searchParams.get("month") ?? undefined;
  const displayCurrency = await getDisplayCurrency(userId, request.nextUrl.searchParams.get("currency"));
  const includeRollover = request.nextUrl.searchParams.get("rollover") === "1";
  // Rolling budgets: chained, signed carry with an annual reset and a 12-month
  // correction of the base itself. Supersedes the one-month penalty above.
  const includeRolling = request.nextUrl.searchParams.get("rolling") === "1";
  const includeSpending = request.nextUrl.searchParams.get("spending") === "1";

  const data = await getBudgets(userId, month);
  const rateMap = await getRateMap(displayCurrency, userId);

  // Convert budget amounts to display currency
  // `categoryNameCt` is destructured OUT of the spread, not deleted after it:
  // the ciphertext must never reach the wire (the rule stated in
  // src/lib/dashboard/spending-by-category.ts, and what /api/transactions
  // enforces with its `delete row.categoryNameCt`), and a `...b` spread that
  // carries it is one forgotten `delete` away from shipping it again.
  let enriched = data.map(({ categoryNameCt, ...b }: any) => ({
    ...b,
    // The budgets page renders `b.categoryName` directly (and feeds it to
    // Combobox labels + sort comparators), but `getBudgets` returns only the
    // encrypted `categoryNameCt` — so every budget row rendered with a blank
    // label. Decrypt here, exactly as the dashboard's Spending-by-Category
    // card already does; `safeName` degrades a cold/absent DEK to
    // "Category #<id>" rather than an empty string.
    categoryName: safeName(decryptName(categoryNameCt, dek, null), "Category", b.categoryId),
    convertedAmount: convertWithRateMap(b.amount, b.currency, rateMap),
    displayCurrency,
    spent: 0,
    convertedSpent: 0,
    rolloverAmount: 0,
  }));

  // Include actual spending per category, converted to display currency
  if (includeSpending && month) {
    const startDate = `${month}-01`;
    const [y, m] = month.split("-").map(Number);
    const lastDay = new Date(y, m, 0).getDate();
    const endDate = `${month}-${String(lastDay).padStart(2, "0")}`;
    const spending = await getSpendingByCategoryAndCurrency(userId, startDate, endDate);

    // Aggregate spending per category in display currency
    const spentMap = new Map<number, number>();
    for (const s of spending) {
      if (s.categoryId != null) {
        const converted = Math.abs(convertWithRateMap(s.total, s.currency, rateMap));
        spentMap.set(s.categoryId, (spentMap.get(s.categoryId) ?? 0) + converted);
      }
    }

    enriched = enriched.map((b: any) => ({
      ...b,
      convertedSpent: Math.round((spentMap.get(b.categoryId) ?? 0) * 100) / 100,
    }));
  }

  if (includeRollover && month && !includeRolling) {
    const rollovers = await getBudgetRollover(userId, month);
    const rolloverMap = new Map(rollovers.map((r: any) => [r.categoryId, r.rolloverAmount]));

    enriched = enriched.map((b: any) => ({
      ...b,
      rolloverAmount: rolloverMap.get(b.categoryId) ?? 0,
    }));
  }

  if (includeRolling && month) {
    // The carry chain runs continuously (no year boundary clears it), so load the
    // full lookback window the engine walks, which also covers the 12-month streak.
    const fromMonth = addMonths(month, -36);

    const [y, m] = month.split("-").map(Number);
    const lastDay = new Date(y, m, 0).getDate();

    const [budgetRows, spendRows] = await Promise.all([
      getBudgetsInRange(userId, fromMonth, month),
      getMonthlySpendByCategory(userId, `${fromMonth}-01`, `${month}-${String(lastDay).padStart(2, "0")}`),
    ]);

    // Convert each (month, category, currency) bucket before summing, so a USD
    // purchase cannot be compared against a CAD budget at face value.
    const converted = spendRows.map((r: any) => ({
      ...r,
      spent: Math.abs(convertWithRateMap(r.spent, r.currency, rateMap)),
    }));
    const { budgetByCategory, spendByCategory } = indexHistory(budgetRows as any, converted as any);

    // Only COMPLETED months may contribute carry. A month still in progress has
    // not spent its budget yet, and a future month has not spent anything at all,
    // so counting either would hand the next month a phantom surplus equal to the
    // whole budget. Dropping those rows makes the chain skip them (a month with no
    // budget row breaks the chain by design) while keeping the target month's own
    // base, which is what the row is measured against.
    const nowMonth = new Date().toISOString().slice(0, 7);
    for (const m of budgetByCategory.values()) {
      for (const k of Array.from(m.keys())) {
        if (k >= nowMonth && k !== month) m.delete(k);
      }
    }
    for (const m of spendByCategory.values()) {
      for (const k of Array.from(m.keys())) {
        if (k >= nowMonth && k !== month) m.delete(k);
      }
    }

    enriched = enriched.map((b: any) => {
      const state = computeRolling(
        b.categoryId,
        month,
        budgetByCategory.get(b.categoryId) ?? new Map(),
        spendByCategory.get(b.categoryId) ?? new Map()
      );
      return {
        ...b,
        rolloverAmount: state.carryIn,
        baseAmount: state.baseAmount,
        adjustedBase: state.adjustedBase,
        effectiveBudget: state.effectiveBudget,
        autoAdjustment: state.autoAdjustment,
        autoAdjustReason: state.autoAdjustReason,
        streak: state.streak,
      };
    });
  }

  return NextResponse.json(enriched);
}

export async function POST(request: NextRequest) {
  const auth = await requireAuth(request); if (!auth.authenticated) return auth.response;
  try {
    const body = await request.json();
    const parsed = validateBody(body, postSchema);
    if (parsed.error) return parsed.error;
    // Cross-tenant FK guard (H-1) — `categoryId` is the only client-supplied
    // FK on this route. Without verification, a budget for user B's category
    // would land under user A's user_id and skew A's "spent vs budget" view.
    await verifyOwnership(auth.context.userId, {
      categoryIds: [parsed.data.categoryId],
    });
    const budget = await upsertBudget(auth.context.userId, parsed.data);
    return NextResponse.json(budget, { status: 201 });
  } catch (error: unknown) {
    if (error instanceof OwnershipError) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    await logApiError("POST", "/api/budgets", error, auth.context.userId);
    return NextResponse.json({ error: safeErrorMessage(error, "Failed to save budget") }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  const auth = await requireAuth(request); if (!auth.authenticated) return auth.response;
  const id = parseInt(request.nextUrl.searchParams.get("id") ?? "0");
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });
  await deleteBudget(id, auth.context.userId);
  return NextResponse.json({ success: true });
}
