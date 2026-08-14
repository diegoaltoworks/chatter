/**
 * Named greetings for known contacts — rides the same persona window as the
 * chat that follows, so a call greeted in one persona/language continues in
 * it. Ships no content: templates are entirely caller-supplied.
 */

import type { PersonaResolver } from "./resolver";

export interface GreeterOptions {
  resolver: PersonaResolver;
  /** Greeting templates keyed by persona id, each containing a `{name}` placeholder. */
  templates: Record<string, readonly string[]>;
  /** Injectable randomness for tests. Default `Math.random`. */
  random?: () => number;
}

export interface Greeter {
  /** A named greeting for a known contact in their current persona, or null (unknown contact, or no template pool for that persona). */
  greet(contactId: string): string | null;
}

function capitalize(name: string): string {
  return name.charAt(0).toUpperCase() + name.slice(1);
}

export function createGreeter({
  resolver,
  templates,
  random = Math.random,
}: GreeterOptions): Greeter {
  return {
    greet(contactId: string): string | null {
      try {
        const contact = resolver.contactFor(contactId);
        if (!contact?.name) return null;

        const personaId = resolver.rollPersonaId(contactId) ?? resolver.defaultPersonaId();
        const pool = personaId ? templates[personaId] : undefined;
        if (!pool || pool.length === 0) return null;

        const template = pool[Math.floor(random() * pool.length)];
        if (!template) return null;
        return template.replaceAll("{name}", capitalize(contact.name));
      } catch {
        return null;
      }
    },
  };
}
