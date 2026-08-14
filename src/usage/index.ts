/**
 * Usage metering — daily spend guards for anything that costs money per call.
 *
 * Published as the `@diegoaltoworks/chatter/usage` subpath so the core install
 * stays untouched by it. The limiter itself is pure; the Turso store is the
 * shipped persistence binding and needs `@libsql/client`, which chatter
 * already expects for retrieval.
 *
 * @packageDocumentation
 */

export type {
  DailyLimitCheck,
  DailyLimiter,
  DailyLimiterDeps,
  DailyLimitReason,
  DailyLimitsConfig,
  DailyLimitsStore,
} from "./limits";
export { createDailyLimiter, GLOBAL_LIMIT_KEY, pickDailyLimit, utcDayKey } from "./limits";
export { createTursoUsageStore } from "./tursoStore";
