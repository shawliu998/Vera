export const COURT_CALENDAR_CALCULATION_ALGORITHM_VERSION =
  "aletheia-court-calendar-business-days-v1" as const;

export type CourtCalendarStartPolicy = "same_day" | "next_day";
export type CourtCalendarOverrideStatus = "open" | "closed";
export type CourtCalendarCalculationErrorCode =
  | "INVALID_INPUT"
  | "CALENDAR_RANGE_INSUFFICIENT";

export interface CourtCalendarDateOverride {
  date: string;
  status: CourtCalendarOverrideStatus;
}

export interface CourtCalendarCalculationInput {
  /** A YYYY-MM-DD date interpreted in Asia/Shanghai, never as an instant. */
  triggerDate: string;
  offsetDays: number;
  startPolicy: CourtCalendarStartPolicy;
  /** JavaScript weekday numbering: Sunday is 0 and Saturday is 6. */
  weeklyNonWorkingDays: readonly number[];
  dateOverrides: readonly CourtCalendarDateOverride[];
  /** Inclusive calendar validity interval. */
  effectiveFrom: string;
  effectiveTo: string;
}

export type CourtCalendarTraceReason =
  | "regular_working_day"
  | "weekly_non_working_day"
  | "override_open"
  | "override_closed"
  | "zero_offset_trigger_date";

export interface CourtCalendarTraceEntry {
  date: string;
  weekday: number;
  counted: boolean;
  reason: CourtCalendarTraceReason;
  countedDays: number;
}

export interface CourtCalendarCalculationResult {
  algorithmVersion: typeof COURT_CALENDAR_CALCULATION_ALGORITHM_VERSION;
  dueDate: string;
  trace: readonly CourtCalendarTraceEntry[];
}

export class CourtCalendarCalculationError extends Error {
  constructor(
    public readonly code: CourtCalendarCalculationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "CourtCalendarCalculationError";
  }
}

interface LocalDate {
  year: number;
  month: number;
  day: number;
}

function invalidInput(message: string): never {
  throw new CourtCalendarCalculationError("INVALID_INPUT", message);
}

function insufficientRange(date: string): never {
  throw new CourtCalendarCalculationError(
    "CALENDAR_RANGE_INSUFFICIENT",
    `The verified court calendar does not cover ${date}.`,
  );
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
      ? 29
      : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function parseLocalDate(value: unknown, field: string): LocalDate {
  if (typeof value !== "string") invalidInput(`${field} must be YYYY-MM-DD.`);
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) invalidInput(`${field} must be YYYY-MM-DD.`);

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
    invalidInput(`${field} is not a valid Gregorian date.`);
  }
  return { year, month, day };
}

function formatLocalDate(date: LocalDate): string {
  if (date.year < 0 || date.year > 9999) {
    invalidInput("The calculation exceeds the supported YYYY-MM-DD date range.");
  }
  return `${String(date.year).padStart(4, "0")}-${String(date.month).padStart(2, "0")}-${String(date.day).padStart(2, "0")}`;
}

function toUtcDate(date: LocalDate): Date {
  const result = new Date(0);
  result.setUTCHours(0, 0, 0, 0);
  result.setUTCFullYear(date.year, date.month - 1, date.day);
  return result;
}

function nextDate(date: LocalDate): LocalDate {
  const result = toUtcDate(date);
  result.setUTCDate(result.getUTCDate() + 1);
  return {
    year: result.getUTCFullYear(),
    month: result.getUTCMonth() + 1,
    day: result.getUTCDate(),
  };
}

function weekday(date: LocalDate): number {
  return toUtcDate(date).getUTCDay();
}

function validateInput(input: CourtCalendarCalculationInput): {
  triggerDate: LocalDate;
  effectiveFrom: string;
  effectiveTo: string;
  weeklyNonWorkingDays: ReadonlySet<number>;
  overrides: ReadonlyMap<string, CourtCalendarOverrideStatus>;
} {
  if (!input || typeof input !== "object") invalidInput("Input must be an object.");
  const triggerDate = parseLocalDate(input.triggerDate, "triggerDate");
  const effectiveFromDate = parseLocalDate(input.effectiveFrom, "effectiveFrom");
  const effectiveToDate = parseLocalDate(input.effectiveTo, "effectiveTo");
  const effectiveFrom = formatLocalDate(effectiveFromDate);
  const effectiveTo = formatLocalDate(effectiveToDate);
  const trigger = formatLocalDate(triggerDate);

  if (effectiveFrom > effectiveTo) {
    invalidInput("effectiveFrom must not be after effectiveTo.");
  }
  if (trigger < effectiveFrom || trigger > effectiveTo) {
    insufficientRange(trigger);
  }
  if (!Number.isInteger(input.offsetDays) || input.offsetDays < 0 || input.offsetDays > 3650) {
    invalidInput("offsetDays must be an integer from 0 through 3650.");
  }
  if (input.startPolicy !== "same_day" && input.startPolicy !== "next_day") {
    invalidInput("startPolicy must be same_day or next_day.");
  }
  if (!Array.isArray(input.weeklyNonWorkingDays)) {
    invalidInput("weeklyNonWorkingDays must be an array of weekdays from 0 through 6.");
  }

  const weeklyNonWorkingDays = new Set<number>();
  for (const value of input.weeklyNonWorkingDays) {
    if (!Number.isInteger(value) || value < 0 || value > 6) {
      invalidInput("weeklyNonWorkingDays must contain only integers from 0 through 6.");
    }
    if (weeklyNonWorkingDays.has(value)) {
      invalidInput("weeklyNonWorkingDays must not contain duplicate weekdays.");
    }
    weeklyNonWorkingDays.add(value);
  }

  if (!Array.isArray(input.dateOverrides)) {
    invalidInput("dateOverrides must be an array.");
  }
  const overrides = new Map<string, CourtCalendarOverrideStatus>();
  for (const override of input.dateOverrides) {
    if (!override || typeof override !== "object") {
      invalidInput("Each date override must be an object.");
    }
    const date = formatLocalDate(parseLocalDate(override.date, "dateOverrides[].date"));
    if (date < effectiveFrom || date > effectiveTo) {
      invalidInput("Each date override must be inside the effective calendar interval.");
    }
    if (override.status !== "open" && override.status !== "closed") {
      invalidInput("dateOverrides[].status must be open or closed.");
    }
    if (overrides.has(date)) {
      invalidInput(`dateOverrides must not contain duplicate date ${date}.`);
    }
    overrides.set(date, override.status);
  }

  return {
    triggerDate,
    effectiveFrom,
    effectiveTo,
    weeklyNonWorkingDays,
    overrides,
  };
}

/**
 * Calculates a local Asia/Shanghai business-day deadline without constructing a
 * timezone-dependent timestamp. Both effective interval endpoints are inclusive.
 */
export function calculateCourtCalendarBusinessDays(
  input: CourtCalendarCalculationInput,
): CourtCalendarCalculationResult {
  const calendar = validateInput(input);
  const triggerDate = formatLocalDate(calendar.triggerDate);

  if (input.offsetDays === 0) {
    return {
      algorithmVersion: COURT_CALENDAR_CALCULATION_ALGORITHM_VERSION,
      dueDate: triggerDate,
      trace: [
        {
          date: triggerDate,
          weekday: weekday(calendar.triggerDate),
          counted: false,
          reason: "zero_offset_trigger_date",
          countedDays: 0,
        },
      ],
    };
  }

  let current =
    input.startPolicy === "same_day"
      ? calendar.triggerDate
      : nextDate(calendar.triggerDate);
  let countedDays = 0;
  const trace: CourtCalendarTraceEntry[] = [];

  while (true) {
    const date = formatLocalDate(current);
    if (date < calendar.effectiveFrom || date > calendar.effectiveTo) {
      insufficientRange(date);
    }

    const override = calendar.overrides.get(date);
    const reason: CourtCalendarTraceReason =
      override === "open"
        ? "override_open"
        : override === "closed"
          ? "override_closed"
          : calendar.weeklyNonWorkingDays.has(weekday(current))
            ? "weekly_non_working_day"
            : "regular_working_day";
    const counted = reason === "override_open" || reason === "regular_working_day";
    if (counted) countedDays += 1;
    trace.push({
      date,
      weekday: weekday(current),
      counted,
      reason,
      countedDays,
    });
    if (countedDays === input.offsetDays) {
      return {
        algorithmVersion: COURT_CALENDAR_CALCULATION_ALGORITHM_VERSION,
        dueDate: date,
        trace,
      };
    }
    current = nextDate(current);
  }
}
