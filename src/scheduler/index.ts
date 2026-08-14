/**
 * Scheduler — exactly-once outbound delivery on a caller-supplied fire time.
 * Published as the `@diegoaltoworks/chatter/scheduler` subpath so the core
 * install stays untouched by it.
 *
 * Content-free: chatter stores no schedule data of its own. A caller
 * supplies candidate {@link ScheduleEntry} objects each tick (its own store,
 * cron, queue, anything); this module adds the parts that are easy to get
 * wrong in a multi-instance deployment — an exactly-once claim in Turso so
 * two instances never both deliver the same entry, a fire-time grace window
 * so a delayed tick doesn't send stale messages, a pluggable compose step
 * (static text or an LLM call via `answerFn`/`completeOnce`) that always
 * falls back rather than blocking delivery, and delivery through the
 * channel sender registry with an optional voice-attempted/text-guaranteed
 * mode.
 *
 * @packageDocumentation
 */

export type { ScheduleClaimRow } from "./claimStore";
export {
  canClaim,
  createTursoScheduleClaimStore,
  DEFAULT_CLAIM_TABLE,
  DEFAULT_CLAIM_TIMEOUT_MS,
} from "./claimStore";
export type { AnswerComposeOptions } from "./compose";
export { composeMessage, createAnswerCompose } from "./compose";
export type { DeliverOptions } from "./deliver";
export { deliver } from "./deliver";
export { dueDrops, isDue, isWithinGrace, staleDrops } from "./dueDrops";
export type { Scheduler, SchedulerConfig } from "./scheduler";
export {
  createScheduler,
  DEFAULT_FALLBACK_MESSAGE,
  DEFAULT_GRACE_MS,
  DEFAULT_INTERVAL_MS,
} from "./scheduler";
export type { TickOptions } from "./tick";
export { runTick } from "./tick";
export type { ComposeFn, ScheduleClaimStore, ScheduleEntry, TickResult } from "./types";
