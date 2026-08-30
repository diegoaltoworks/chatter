/**
 * Persona machinery — dynamic prompt layers and named greetings driven by a
 * JSON registry. Published as the `@diegoaltoworks/chatter/personas` subpath
 * so the core install stays untouched by it; this module adds no required
 * dependencies.
 *
 * @packageDocumentation
 */

export type { Greeter, GreeterOptions } from "./greeter";
export { createGreeter } from "./greeter";
export type {
  PersonaContact,
  PersonaDefinition,
  PersonaEndpoint,
  PersonaKey,
  PersonaRegistry,
  PersonaResolver,
  PersonaResolverOptions,
} from "./resolver";
export { createPersonaResolver } from "./resolver";
export { timeContext } from "./timeContext";
