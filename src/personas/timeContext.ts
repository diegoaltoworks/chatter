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
      // Assembled from parts, not `format()`: the separators `format()` puts
      // between fields change with the runtime's ICU data (a newer one adds a
      // comma after the weekday), and this line must read the same everywhere.
      const fields = new Intl.DateTimeFormat("en-GB", {
        timeZone: zone,
        weekday: "long",
        day: "numeric",
        month: "long",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).formatToParts(at);
      const part = (type: Intl.DateTimeFormatPartTypes) =>
        fields.find((field) => field.type === type)?.value ?? "";
      const formatted = `${part("weekday")} ${part("day")} ${part("month")} ${part("year")} at ${part("hour")}:${part("minute")}`;
      return [`${formatted} (${zone})`];
    } catch {
      // An invalid IANA zone name must not throw into the chat path; skip it.
      return [];
    }
  });
  if (parts.length === 0) return "";
  return `Current date and time: ${parts.join(" / ")}.`;
}
