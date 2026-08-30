/**
 * Persona registry resolver — windowed persona selection driven by a JSON
 * registry. Framework-free and content-free: it knows how to roll and load a
 * persona layer, never what a persona says. A registry/prompt failure
 * degrades to `null` (the caller's default layer) rather than throwing into
 * a chat request.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createConsoleLogger, type Logger } from "../core/logger";

export interface PersonaDefinition {
  name: string;
  /** Path to the persona's prompt file, resolved against `promptsDir`. */
  prompt: string;
  language?: string;
}

export interface PersonaContact {
  name?: string;
  role?: string;
  /** Persona id rolled for this contact. */
  persona: string;
  /** Overrides `personaProbability` for this contact when set. */
  probability?: number;
}

/**
 * A persona bound to one of the bot's own endpoints - which of its numbers,
 * tokens or rooms the message arrived on, rather than who sent it.
 */
export interface PersonaEndpoint {
  /** Persona id this endpoint always answers as. */
  persona: string;
}

export interface PersonaRegistry {
  /** Persona id used when a contact is unmapped or its roll doesn't land. */
  defaultPersona: string;
  /** 0–1 chance a mapped contact gets their persona on a fresh roll. Default 0.5. */
  personaProbability?: number;
  /** Minutes a roll is held before the next message re-rolls it. Default 10. */
  personaWindowMinutes?: number;
  contacts?: Record<string, PersonaContact>;
  /**
   * Personas keyed on the endpoint that received the message
   * (`ChannelMessage.endpointId`), for a bot whose voice is decided by which
   * of its own identities was reached rather than by who reached it.
   */
  endpoints?: Record<string, PersonaEndpoint>;
  personas: Record<string, PersonaDefinition>;
}

/**
 * Who a persona is resolved for. A bare string is the contact id, which is
 * every call that predates endpoint keying; the object form adds the endpoint
 * the message arrived on, and either half may be omitted.
 */
export type PersonaKey = string | { contactId?: string; endpointId?: string };

export interface PersonaResolverOptions {
  /** Inline registry — takes priority over `registryPath` when both are set. */
  registry?: PersonaRegistry;
  /** Path to a JSON registry file, read once and memoized. */
  registryPath?: string;
  /** Base directory prompt paths resolve against. Defaults to `registryPath`'s directory, or cwd for an inline registry. */
  promptsDir?: string;
  /** Injectable randomness for tests. Default `Math.random`. */
  random?: () => number;
  /** Injectable clock for tests. Default `Date.now`. */
  now?: () => number;
  /** Template vars (`{{name}}`) interpolated into loaded prompt files. */
  vars?: Record<string, string>;
  /** Logger for registry/prompt load failures. Default: a console logger writing to stderr. */
  logger?: Logger;
}

export interface PersonaResolver {
  /**
   * The persona id in effect right now. A key naming an endpoint that the
   * registry binds resolves to that persona deterministically - no roll, no
   * window - because an endpoint-bound voice is a property of the identity
   * reached, not something that varies over a conversation. Otherwise the
   * contact is rolled at `personaProbability` once per window and held for
   * `personaWindowMinutes`. `null` means "use the default persona" (no key,
   * an unmapped contact, or a lost roll).
   */
  rollPersonaId(key: PersonaKey): string | null;
  /**
   * The interpolated prompt layer for the persona {@link rollPersonaId}
   * yields, falling back to the default persona's layer. Feeds
   * `prepareChat`'s `personaLayer` directly.
   */
  resolvePersonaLayer(key: PersonaKey): string | null;
  /** Deterministic layer for an explicit persona id (no dice roll), or null. */
  personaLayerFor(personaId: string | null): string | null;
  /** Registry contact record, or undefined. */
  contactFor(contactId: string): PersonaContact | undefined;
  /** The registry's configured default persona id, or null on failure. */
  defaultPersonaId(): string | null;
}

const DEFAULT_WINDOW_MINUTES = 10;
const DEFAULT_PROBABILITY = 0.5;

function interpolate(template: string, vars: Record<string, string>): string {
  return Object.entries(vars).reduce(
    (acc, [key, value]) => acc.replaceAll(`{{${key}}}`, value),
    template,
  );
}

export function createPersonaResolver(options: PersonaResolverOptions = {}): PersonaResolver {
  if (!options.registry && !options.registryPath) {
    throw new Error("createPersonaResolver requires a registry or registryPath");
  }

  const random = options.random ?? Math.random;
  const now = options.now ?? Date.now;
  const vars = options.vars ?? {};
  const logger = options.logger ?? createConsoleLogger();
  const promptsDir =
    options.promptsDir ?? (options.registryPath ? dirname(options.registryPath) : process.cwd());

  let registry: PersonaRegistry | undefined = options.registry;
  let registryLoadError: unknown;
  // `null` means a prior load attempt failed — cached so a bad file is not
  // re-read on every chat message; fix requires a new resolver.
  const promptCache = new Map<string, string | null>();
  const window = new Map<string, { personaId: string | null; expiresAt: number }>();
  const warned = new Set<string>();

  function warnOnce(kind: string, message: string, error: unknown) {
    if (warned.has(kind)) return;
    warned.add(kind);
    logger.warn(message, error);
  }

  function loadRegistry(): PersonaRegistry {
    if (registry) return registry;
    if (registryLoadError !== undefined) throw registryLoadError;
    try {
      // biome-ignore lint/style/noNonNullAssertion: validated in the constructor guard above
      registry = JSON.parse(readFileSync(options.registryPath!, "utf-8")) as PersonaRegistry;
      return registry;
    } catch (error) {
      registryLoadError = error;
      warnOnce(
        "registry",
        `Persona registry load failed (${options.registryPath}); falling back to the default persona for every contact.`,
        error,
      );
      throw error;
    }
  }

  function contactFor(contactId: string): PersonaContact | undefined {
    try {
      return loadRegistry().contacts?.[contactId];
    } catch {
      return undefined;
    }
  }

  /**
   * The persona bound to an endpoint, if the registry binds one. Read
   * straight off the registry: no roll and no window entry, so two messages
   * reaching the same endpoint always answer in the same voice.
   */
  function endpointPersonaId(endpointId: string | undefined): string | null {
    if (!endpointId) return null;
    try {
      return loadRegistry().endpoints?.[endpointId]?.persona ?? null;
    } catch {
      return null;
    }
  }

  function rollPersonaId(key: PersonaKey): string | null {
    const { contactId, endpointId }: { contactId?: string; endpointId?: string } =
      typeof key === "string" ? { contactId: key } : key;
    const boundToEndpoint = endpointPersonaId(endpointId);
    if (boundToEndpoint) return boundToEndpoint;
    if (contactId === undefined) return null;
    try {
      const reg = loadRegistry();
      const nowMs = now();
      const existing = window.get(contactId);
      if (existing && existing.expiresAt > nowMs) {
        return existing.personaId;
      }
      // Evict expired holds on every fresh roll so the map stays bounded by
      // contacts active within the last window, not all contacts ever seen.
      for (const [held, value] of window) {
        if (value.expiresAt <= nowMs) window.delete(held);
      }

      const contact = reg.contacts?.[contactId];
      let personaId: string | null = null;
      // Per-contact probability overrides the global one, when a contact sets one.
      const probability = contact?.probability ?? reg.personaProbability ?? DEFAULT_PROBABILITY;
      if (contact && random() < probability) {
        personaId = contact.persona === reg.defaultPersona ? null : contact.persona;
      }

      const windowMs = (reg.personaWindowMinutes ?? DEFAULT_WINDOW_MINUTES) * 60 * 1000;
      window.set(contactId, { personaId, expiresAt: nowMs + windowMs });
      return personaId;
    } catch {
      return null;
    }
  }

  function personaLayerFor(personaId: string | null): string | null {
    if (!personaId) return null;
    try {
      const definition = loadRegistry().personas[personaId];
      if (!definition) return null;
      if (promptCache.has(personaId)) return promptCache.get(personaId) ?? null;
      try {
        const prompt = interpolate(
          readFileSync(resolve(promptsDir, definition.prompt), "utf-8"),
          vars,
        );
        promptCache.set(personaId, prompt);
        return prompt;
      } catch (error) {
        promptCache.set(personaId, null);
        warnOnce(
          `prompt:${personaId}`,
          `Persona prompt load failed for "${personaId}" (${definition.prompt}); falling back to the default persona.`,
          error,
        );
        return null;
      }
    } catch {
      return null;
    }
  }

  function defaultPersonaId(): string | null {
    try {
      return loadRegistry().defaultPersona ?? null;
    } catch {
      return null;
    }
  }

  function resolvePersonaLayer(key: PersonaKey): string | null {
    return personaLayerFor(rollPersonaId(key)) ?? personaLayerFor(defaultPersonaId());
  }

  return {
    rollPersonaId,
    resolvePersonaLayer,
    personaLayerFor,
    contactFor,
    defaultPersonaId,
  };
}
