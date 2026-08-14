/**
 * Pure fire-time filtering. A schedule fires once its time has passed, but
 * only within a grace window — a stale entry (the process was down, or the
 * tick was delayed) past grace is skipped rather than delivered late.
 */

import type { ScheduleEntry } from "./types";

export function isDue(entry: ScheduleEntry, now: number): boolean {
  return entry.fireAt <= now;
}

export function isWithinGrace(entry: ScheduleEntry, now: number, graceMs: number): boolean {
  return now - entry.fireAt <= graceMs;
}

/** Due entries still inside their grace window, in caller-supplied order. */
export function dueDrops(entries: ScheduleEntry[], now: number, graceMs: number): ScheduleEntry[] {
  return entries.filter((entry) => isDue(entry, now) && isWithinGrace(entry, now, graceMs));
}

/** Due entries whose grace window has already passed — reported so callers can log them, never delivered. */
export function staleDrops(
  entries: ScheduleEntry[],
  now: number,
  graceMs: number,
): ScheduleEntry[] {
  return entries.filter((entry) => isDue(entry, now) && !isWithinGrace(entry, now, graceMs));
}
