/**
 * Content-free by design: chatter stores no schedule data of its own.
 * `id`/`fireAt`/`channel`/`chatId` are the minimum the claim/grace/delivery
 * machinery needs; `payload` is opaque caller data for the compose step.
 */
export interface ScheduleEntry {
  /** Stable, caller-assigned id — the claim table's primary key. */
  id: string;
  /** Epoch ms the entry is due to fire. */
  fireAt: number;
  /** Sender-registry channel name to deliver through. */
  channel: string;
  /** Channel-specific recipient id. */
  chatId: string;
  /** Opaque caller data passed to the compose step; chatter never reads it. */
  payload?: unknown;
}

/** Turns an entry into outbound text. Chatter never inspects the result beyond checking it is non-blank. */
export type ComposeFn = (entry: ScheduleEntry) => Promise<string> | string;

export interface ScheduleClaimStore {
  /** Atomically claims `id` for this instance; resolves false if another instance already holds it. */
  claim(id: string, now: number): Promise<boolean>;
  /** Releases this instance's claim on `id`, e.g. after a failed send, so it can be retried within grace. */
  release(id: string): Promise<void>;
}

export interface TickResult {
  /** Ids delivered this tick. */
  sent: string[];
  /** Ids due within grace but already claimed by another instance. */
  notClaimed: string[];
  /** Ids due but past their grace window — skipped, never claimed or delivered. */
  stale: string[];
  /** Ids claimed this tick whose delivery failed; the claim was released so a later tick can retry. */
  failed: string[];
}
