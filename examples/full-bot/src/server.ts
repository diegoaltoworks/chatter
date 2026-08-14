#!/usr/bin/env bun
/**
 * Full bot: chatter's server wired to the WhatsApp channel, a neutral
 * persona registry, reply gates, image requests, and a scheduler tick — the
 * downstream shape docs/channels.md and docs/personas.md describe end to
 * end. Config-driven throughout; every credential comes from the
 * environment, none of it real.
 *
 * Usage:
 *   Set OPENAI_API_KEY, TURSO_URL, TURSO_AUTH_TOKEN, CHATTER_SECRET,
 *   WA_SESSION_SECRET (see README.md), then:
 *   bun run start
 */

import { createServer } from "@diegoaltoworks/chatter";
import { createScheduler } from "@diegoaltoworks/chatter/scheduler";
import { createDailyLimiter, createTursoUsageStore, pickDailyLimit } from "@diegoaltoworks/chatter/usage";
import {
  createCloudinaryUploadClient,
  createImageGenerator,
  createImageUploader,
  createOpenAIImageClient,
  createTursoImageCacheStore,
  resolveCloudinaryConfig,
  resolveImageConfig,
} from "@diegoaltoworks/chatter/images";
import { createPersonaResolver } from "@diegoaltoworks/chatter/personas";
import {
  createWhatsAppChannel,
  createWhatsAppImageHandler,
  createWhatsAppInboundHandler,
  loadBaileys,
  type WhatsAppMessageEvent,
} from "@diegoaltoworks/chatter/whatsapp";

// The channel needs `onMessage` before it connects, but the handler needs
// `deps` (client/store/prompts/db) that only exist once `createServer` has
// built them. `customRoutes` runs after those deps are built but before
// channels start, so it's where the two get wired together — see
// docs/channels.md#answering-messages.
let handleInbound: ((event: WhatsAppMessageEvent) => Promise<void>) | undefined;
let scheduler: ReturnType<typeof createScheduler> | undefined;

// Share ONE registry across every WhatsApp channel instance in this process
// — see docs/channels.md#answering-messages. Declared here, not inline at
// the handler call site, so a second channel (another session, another
// number) is wired against the same instance rather than a fresh one.
const sessionIdentities = new Map<string, string[]>();

const whatsapp = createWhatsAppChannel({
  sessionSecret: process.env.WA_SESSION_SECRET ?? "",
  sessionIds: (process.env.WA_SESSION_IDS ?? "default").split(","),
  onMessage: (event) => handleInbound?.(event),
});

const personaResolver = createPersonaResolver({
  registryPath: "./config/personas.json",
  vars: { botName: "FullBot" },
});

async function main() {
  const app = await createServer({
    bot: {
      name: "FullBot",
      personName: "My Company",
      publicUrl: "https://bot.mycompany.com",
      description: "Full example: WhatsApp channel, personas, gates, images, scheduler.",
    },
    openai: {
      apiKey: process.env.OPENAI_API_KEY ?? "",
    },
    database: {
      url: process.env.TURSO_URL ?? "",
      authToken: process.env.TURSO_AUTH_TOKEN ?? "",
    },
    auth: {
      secret: process.env.CHATTER_SECRET ?? "",
    },
    knowledgeDir: "./knowledge",
    promptsDir: "./prompts",
    channels: [whatsapp],
    customRoutes: async (_app, deps) => {
      const env = process.env as Record<string, string | undefined>;
      const imageConfig = resolveImageConfig(env);
      const cloudinaryConfig = resolveCloudinaryConfig(env);
      const imageGenerator = createImageGenerator(imageConfig, {
        client: createOpenAIImageClient(imageConfig),
      });
      const imageUploader = createImageUploader(cloudinaryConfig, {
        generator: imageGenerator,
        uploadClient: createCloudinaryUploadClient(cloudinaryConfig),
        cacheStore: createTursoImageCacheStore(deps.db, "image_cache"),
      });
      const imageLimiter = createDailyLimiter(
        { perKeyDailyLimit: pickDailyLimit(process.env.IMAGE_LIMIT_PER_DAY, 5), globalDailyLimit: 200 },
        { store: createTursoUsageStore(deps.db, "image_usage") },
      );

      handleInbound = createWhatsAppInboundHandler({
        client: deps.client,
        store: deps.store,
        prompts: deps.prompts,
        answerFn: deps.config.answerFn,
        bucketsFor: deps.config.bucketsFor,
        registry: sessionIdentities,
        allowedChats: (process.env.WA_CHAT_ALLOWLIST ?? "").split(",").filter(Boolean),
        channelHint: "Channel: WhatsApp.",
        personaResolver: ({ senderPhone }) => personaResolver.resolvePersonaLayer(senderPhone) ?? undefined,
        images: createWhatsAppImageHandler({
          images: imageUploader,
          checkAndReserve: (senderId) => imageLimiter.checkAndReserve(senderId),
          downloadPhoto: async (message) => {
            const baileys = await loadBaileys();
            return new Uint8Array((await baileys.downloadMediaMessage(message, "buffer", {})) as Buffer);
          },
          strings: {
            ack: "Working on it!",
            limitReached: "That's enough images for today — try again tomorrow.",
            moderationBlocked: "I can't draw that one.",
            error: "Something went wrong generating that image.",
          },
        }),
      });

      // A minimal scheduler tick: this example keeps no schedule store of
      // its own (chatter never stores schedule content — see
      // docs/scheduler.md), so `fetchPending` returns nothing. A real host
      // replaces it with its own reminders/nudges store.
      scheduler = createScheduler({
        db: deps.db,
        senders: deps.senders,
        fetchPending: () => [],
        fallbackMessage: "You have a reminder.",
      });
      scheduler.start();
    },
  });

  const port = 8181;
  Bun.serve({ port, fetch: app.fetch });
  console.log(`Full-bot chatter server running on http://localhost:${port}`);

  const shutdown = async () => {
    scheduler?.stop();
    await app.stopChannels();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main();
