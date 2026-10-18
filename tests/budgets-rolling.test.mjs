import { computeRolling, addMonths, budgetYearStart, monthsBetween } from "../src/lib/budgets/rolling.ts";

let pass = 0, fail = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass++; else fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `\n      got ${JSON.stringify(got)}\n     want ${JSON.stringify(want)}`}`);
};

const M = (o) => new Map(Object.entries(o));

// 1. underspend carries forward
{
  const budgets = M({ "2026-01": 500, "2026-02": 500 });
  const spend = M({ "2026-01": 400 });
  const feb = computeRolling(1, "2026-02", budgets, spend);
  check("underspend raises next month", [feb.carryIn, feb.effectiveBudget], [100, 600]);
}

// 2. overspend carries forward (negative)
{
  const budgets = M({ "2026-01": 500, "2026-02": 500 });
  const spend = M({ "2026-01": 700 });
  const feb = computeRolling(1, "2026-02", budgets, spend);
  check("overspend lowers next month", [feb.carryIn, feb.effectiveBudget], [-200, 300]);
}

// 3. chained across several months
{
  const budgets = M({ "2026-01": 500, "2026-02": 500, "2026-03": 500 });
  const spend = M({ "2026-01": 400, "2026-02": 700 });
  // Jan: +100 -> Feb base 500+100=600, spent 700 -> carry -100 -> Mar 400
  const mar = computeRolling(1, "2026-03", budgets, spend);
  check("chain compounds over months", [mar.carryIn, mar.effectiveBudget], [-100, 400]);
}

// 4. annual reset: December's carry does not reach January
{
  const budgets = M({ "2025-12": 500, "2026-01": 500 });
  const spend = M({ "2025-12": 100 });
  const jan = computeRolling(1, "2026-01", budgets, spend);
  check("carry resets in January", [jan.carryIn, jan.effectiveBudget], [0, 500]);
}

// 5. an unplanned month breaks the chain instead of inventing a carry
{
  const budgets = M({ "2026-01": 500, "2026-03": 500 }); // nothing in February
  const spend = M({ "2026-01": 100, "2026-02": 900 });
  const mar = computeRolling(1, "2026-03", budgets, spend);
  check("unbudgeted month does not carry", mar.carryIn, 400); // 500-100, Feb ignored
}

// 6. twelve consecutive over-budget months raise the base
{
  const budgets = new Map(), spend = new Map();
  for (let i = 1; i <= 12; i++) {
    const m = `2025-${String(i).padStart(2, "0")}`;
    budgets.set(m, 500);
    spend.set(m, 650);
  }
  budgets.set("2026-01", 500);
  const jan = computeRolling(1, "2026-01", budgets, spend);
  check("12 months over raises base to median actual", [jan.adjustedBase, jan.autoAdjustment], [650, 150]);
}

// 7. twelve consecutive under-budget months lower the base
{
  const budgets = new Map(), spend = new Map();
  for (let i = 1; i <= 12; i++) {
    const m = `2025-${String(i).padStart(2, "0")}`;
    budgets.set(m, 500);
    spend.set(m, 300);
  }
  budgets.set("2026-01", 500);
  const jan = computeRolling(1, "2026-01", budgets, spend);
  check("12 months under lowers base", [jan.adjustedBase, jan.autoAdjustment], [300, -200]);
}

// 8. eleven months is not enough
{
  const budgets = new Map(), spend = new Map();
  for (let i = 2; i <= 12; i++) {
    const m = `2025-${String(i).padStart(2, "0")}`;
    budgets.set(m, 500);
    spend.set(m, 650);
  }
  budgets.set("2026-01", 500);
  const jan = computeRolling(1, "2026-01", budgets, spend);
  check("11 months does not trigger the rule", [jan.autoAdjustment, jan.streak.months], [0, 11]);
}

// 9. mixed months never trigger it
{
  const budgets = new Map(), spend = new Map();
  for (let i = 1; i <= 12; i++) {
    const m = `2025-${String(i).padStart(2, "0")}`;
    budgets.set(m, 500);
    spend.set(m, i === 6 ? 100 : 650);
  }
  budgets.set("2026-01", 500);
  const jan = computeRolling(1, "2026-01", budgets, spend);
  check("one good month blocks the raise", jan.autoAdjustment, 0);
}

// date helpers
check("addMonths across a year", addMonths("2026-01", -1), "2025-12");
check("budget year start", budgetYearStart("2026-10"), "2026-01");
check("monthsBetween inclusive", monthsBetween("2025-11", "2026-02"), ["2025-11", "2025-12", "2026-01", "2026-02"]);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
