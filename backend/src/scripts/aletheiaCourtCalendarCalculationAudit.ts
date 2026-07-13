import assert from "node:assert/strict";
import {
  COURT_CALENDAR_CALCULATION_ALGORITHM_VERSION,
  CourtCalendarCalculationError,
  calculateCourtCalendarBusinessDays,
} from "../lib/aletheia/courtCalendarCalculation";

function assertError(
  callback: () => unknown,
  code: CourtCalendarCalculationError["code"],
): void {
  assert.throws(callback, (error: unknown) => {
    return error instanceof CourtCalendarCalculationError && error.code === code;
  });
}

function main(): void {
  const weekendMakeupDay = calculateCourtCalendarBusinessDays({
    triggerDate: "2026-02-06",
    offsetDays: 2,
    startPolicy: "next_day",
    weeklyNonWorkingDays: [0, 6],
    dateOverrides: [{ date: "2026-02-07", status: "open" }],
    effectiveFrom: "2026-02-01",
    effectiveTo: "2026-02-28",
  });
  assert.equal(weekendMakeupDay.dueDate, "2026-02-09");
  assert.deepEqual(
    weekendMakeupDay.trace.map(({ date, counted, reason }) => ({
      date,
      counted,
      reason,
    })),
    [
      { date: "2026-02-07", counted: true, reason: "override_open" },
      { date: "2026-02-08", counted: false, reason: "weekly_non_working_day" },
      { date: "2026-02-09", counted: true, reason: "regular_working_day" },
    ],
  );

  const closedWeekdayAcrossYear = calculateCourtCalendarBusinessDays({
    triggerDate: "2025-12-31",
    offsetDays: 2,
    startPolicy: "next_day",
    weeklyNonWorkingDays: [0, 6],
    dateOverrides: [{ date: "2026-01-01", status: "closed" }],
    effectiveFrom: "2025-12-31",
    effectiveTo: "2026-01-10",
  });
  assert.equal(closedWeekdayAcrossYear.dueDate, "2026-01-05");
  assert.equal(closedWeekdayAcrossYear.trace[0]?.reason, "override_closed");

  const sameDayCounting = calculateCourtCalendarBusinessDays({
    triggerDate: "2026-03-03",
    offsetDays: 2,
    startPolicy: "same_day",
    weeklyNonWorkingDays: [0, 6],
    dateOverrides: [],
    effectiveFrom: "2026-03-01",
    effectiveTo: "2026-03-31",
  });
  assert.equal(sameDayCounting.dueDate, "2026-03-04");
  assert.equal(sameDayCounting.trace[0]?.date, "2026-03-03");
  assert.equal(sameDayCounting.trace[0]?.counted, true);

  const zeroOffset = calculateCourtCalendarBusinessDays({
    triggerDate: "2026-03-08",
    offsetDays: 0,
    startPolicy: "next_day",
    weeklyNonWorkingDays: [0, 6],
    dateOverrides: [],
    effectiveFrom: "2026-03-01",
    effectiveTo: "2026-03-31",
  });
  assert.equal(zeroOffset.dueDate, "2026-03-08");
  assert.deepEqual(zeroOffset.trace, [
    {
      date: "2026-03-08",
      weekday: 0,
      counted: false,
      reason: "zero_offset_trigger_date",
      countedDays: 0,
    },
  ]);

  assertError(
    () =>
      calculateCourtCalendarBusinessDays({
        triggerDate: "2026-03-03",
        offsetDays: 1,
        startPolicy: "same_day",
        weeklyNonWorkingDays: [7],
        dateOverrides: [],
        effectiveFrom: "2026-03-01",
        effectiveTo: "2026-03-31",
      }),
    "INVALID_INPUT",
  );
  assertError(
    () =>
      calculateCourtCalendarBusinessDays({
        triggerDate: "2026-03-31",
        offsetDays: 1,
        startPolicy: "next_day",
        weeklyNonWorkingDays: [0, 6],
        dateOverrides: [],
        effectiveFrom: "2026-03-01",
        effectiveTo: "2026-03-31",
      }),
    "CALENDAR_RANGE_INSUFFICIENT",
  );

  console.log(
    JSON.stringify(
      {
        suite: "aletheia-court-calendar-calculation-v1",
        algorithmVersion: COURT_CALENDAR_CALCULATION_ALGORITHM_VERSION,
        status: "passed",
        cases: [
          { name: "weekend makeup day override", result: weekendMakeupDay },
          { name: "weekday closure across year", result: closedWeekdayAcrossYear },
          { name: "same-day counting", result: sameDayCounting },
          { name: "zero offset preserves trigger date", result: zeroOffset },
          { name: "invalid weekday fails closed", result: "INVALID_INPUT" },
          { name: "insufficient range fails closed", result: "CALENDAR_RANGE_INSUFFICIENT" },
        ],
      },
      null,
      2,
    ),
  );
}

main();
