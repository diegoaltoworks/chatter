# ADR 0005: Chatter ships no content

## Status

Accepted.

## Context

Several modules independently state a version of the same rule, each in its
own words: personas ship no content - no bot names, no in-character copy, no
default templates; flows ship no flows - a flows directory, its trigger
keywords, its schema and its handler logic are always supplied by the caller;
and the channel gates (`src/channels/gates.ts`) ship no bot name or
in-character phrasing for mute and unmute, so those triggers are inert until
a host configures a pattern.

Restated per-module and nowhere canonical, the rule has no name a reviewer
can cite. A proposal to add hardcoded copy has to be argued against by
reconstructing the pattern from three unrelated quotes, and an actual
violation has nothing to be a violation *of*.

## Decision

Chatter puts no words in a bot's mouth. No bot names, no in-character copy,
no default templates, flows, personas, or acknowledgement strings - a
feature with no configured content stays silent rather than falling back to
placeholder copy.

This is a statement about voice, not about mechanics, and not about every
string chatter ever emits: operational messages (rate-limit notices,
redaction markers) are chatter's own. Chatter ships the *machinery* for
personas, flows, greetings, and mute/unmute gates, and none of the words
those mechanisms speak in character. A deployment's personality is entirely
the host's to write.

The one current exception is `src/core/guardrails.ts`'s `DEFAULT_REFUSAL`,
the wording sent when leaked instructions are detected and no host has
supplied its own line. It exists because the guardrail fires unconditionally
from `answerOnce` and `completeOnce`, so a completely unconfigured host still
needs a safe reply to send. A host may override it with its own wording; it
may not disable it, so the guard can be voiced but never weakened.

## Consequences

- A new module that needs default user-facing copy is the wrong shape;
  the copy belongs in the host's configuration, not the library.
- [Personas](../personas.md), [flows](../flows.md), and
  `src/channels/gates.ts` point at this decision instead of restating the
  principle in their own words.
- A change proposal that adds hardcoded copy can be reviewed as a violation
  of this decision rather than argued from first principles each time.
