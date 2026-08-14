/**
 * Live clock line for prompts that answer time-relative questions ("what's
 * next", "today", "tomorrow") — a chat surface has no other way to know the
 * current date/time for the zones it cares about.
 */

export function timeContext(zones: string[], now: number = Date.now()): string {
  if (zones.length === 0) return "";
  const at = new Date(now);
  const parts = zones.flatMap((zone) => {
    try {
      const formatted = new Intl.DateTimeFormat("en-GB", {
        timeZone: zone,
        weekday: "long",
        day: "numeric",
        month: "long",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).format(at);
      return [`${formatted} (${zone})`];
    } catch {
      // An invalid IANA zone name must not throw into the chat path; skip it.
      return [];
    }
  });
  if (parts.length === 0) return "";
  return `Current date and time: ${parts.join(" / ")}.`;
}
