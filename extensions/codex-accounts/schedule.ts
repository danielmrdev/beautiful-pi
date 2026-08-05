/**
 * Pool schedule grammar and evaluation.
 *
 * Single home for the schedule schema regexes and the pure schedule logic
 * (day-of-week constants, strict HH:MM parsing, active-window evaluation,
 * member roles). Store normalization, the CLI parser, and the scheduled
 * strategy all import from here so a grammar change lands in one place.
 */
import type { PoolSchedule } from "./types.ts";

/** Strict zero-padded HH:MM (00:00–23:59). Groups: hours, minutes. */
export const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
/** ISO date YYYY-MM-DD. */
export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** Two HH:MM times joined by a dash: "HH:MM-HH:MM" (validation of each half is the caller's). */
export const WINDOW_RE = /^(\d{2}:\d{2})-(\d{2}:\d{2})$/;

/** Day-of-week constants (0=Sunday..6=Saturday). */
export const WEEKDAYS = [1, 2, 3, 4, 5];
export const WEEKEND = [0, 6];

/** Parse strict zero-padded HH:MM into minutes since midnight; undefined when invalid. */
export function parseTime(hhmm: string): number | undefined {
  const match = TIME_RE.exec(hhmm.trim());
  if (!match) return undefined;
  return Number(match[1]) * 60 + Number(match[2]);
}

/**
 * True when the schedule's constraints hold for `now`. An absent schedule is
 * inactive (the scheduled strategy then degrades to round-robin). Date range
 * is inclusive; an overnight time window (start > end) wraps past midnight.
 */
export function isScheduleActive(schedule: PoolSchedule | undefined, now: Date): boolean {
  if (!schedule) return false;
  const { dateRange, days, timeWindows } = schedule;
  const nowMs = now.getTime();
  if (dateRange?.start) {
    const startMs = Date.parse(`${dateRange.start}T00:00:00`);
    if (!Number.isNaN(startMs) && nowMs < startMs) return false;
  }
  if (dateRange?.end) {
    // end date is inclusive: compare against end-of-day
    const endMs = Date.parse(`${dateRange.end}T23:59:59.999`);
    if (!Number.isNaN(endMs) && nowMs > endMs) return false;
  }
  if (days && days.length > 0 && !days.includes(now.getDay())) return false;
  if (timeWindows && timeWindows.length > 0) {
    const t = now.getHours() * 60 + now.getMinutes();
    const hit = timeWindows.some((w) => {
      const start = parseTime(w.start);
      const end = parseTime(w.end);
      if (start === undefined || end === undefined) return false;
      if (start <= end) return t >= start && t <= end;
      return t >= start || t <= end;
    });
    if (!hit) return false;
  }
  return true;
}

/** Role of a member: members not listed in `memberRoles` act as primary. */
export function memberRoleOf(
  schedule: PoolSchedule | undefined,
  credentialId: string,
): "primary" | "backup" {
  return schedule?.memberRoles?.[credentialId] ?? "primary";
}
