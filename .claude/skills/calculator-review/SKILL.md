---
name: calculator-review
description: Review or fix a customs calculation in tnved_checker (duty, VAT, excise, customs fee, batch, personal shipments, car, spec import, preferences, quotas) by tracing it from inputs to the final sum against the acts. Use for "проверь расчёт", "калькулятор считает неверно", "почему такая сумма".
---

# Calculator review

1. Read [docs/calculators.md](../../../docs/calculators.md) first; for the acts behind a formula and their audit records, the relevant parts of [docs/source-audit.md](../../../docs/source-audit.md) (fee п.38 ПКМ № 79, excise ст.336 НК КР, Решение Совета ЕЭК № 107, `QUOTA_DB`); for preferences and `TNVED_MAP`, [docs/base-architecture.md](../../../docs/base-architecture.md).
2. Trace one concrete case end to end: `readCalcForm()` → item (currency converted to сом at read time via `nbkrRateFor`) → `itemDuty(item, customsValueSom)` (the only place a duty is computed) → `parseRateInfo` shape → `vatFreeHits` (unconditional vs conditional) → excise inside the VAT base → `customsFeeGoods` once per declaration → `computeBatch` transport distribution.
3. Check, in this order: source data (rate string, code present in `ETT_DB`, `TNVED_MAP` resolution), check date, currency and nominal, units (kg, cm³, litres, per 1000 kg in USD for 1701), rate shape (simple / max / specific / usd / plus / minof), rounding, exemptions and their conditions, preferences (scale the duty, never the base; not for `it.auto`), quotas (classic vs agreement), warnings (`calcWarnings` — `findX()` returns an array, test `.length`), the estimate print-out.
4. Compute the expected result by hand from the act and compare intermediate values, not only the total.
5. Fix the root cause in the single place it belongs; a fix that would make single-item and batch results disagree is the wrong fix.
6. Verify with the vm loader (`require('./server/src/services/base').load()`), `engine-browser.test.js` (calculator, batch, spec, personal, auto), and a browser check of the form; keep the edge cases of every bracket as regression points.
7. If the formula or the data was checked against its act, update the `SOURCE_AUDIT` record (`avto`, `personal`, `excise`, `nalog`…) in the same commit; append to `session.md`.
