import { describe, expect, mock, test } from "bun:test";
import type { Logger } from "../../core/logger";
import { conversationKeyFor, type InboundPipeline } from "../pipeline";
import type { TelegramApi, TelegramUpdate } from "./api";
import { createTelegramUpdateHandler } from "./handler";
import type { TelegramBotIdentity } from "./updates";

const ME: TelegramBotIdentity = { id: 100, username: "MyBot" };

const noopLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

function update(overrides: Partial<TelegramUpdate["message"]> = {}): TelegramUpdate {
  return {
    update_id: 1,
    message: {
      message_id: 1,
      chat: { id: 200, type: "private" },
      from: { id: 300 },
      text: "hi",
      ...overrides,
    },
  } as unknown as TelegramUpdate;
}

describe("createTelegramUpdateHandler", () => {
  test("the message it hands to the pipeline carries the configured channelName as endpointId", async () => {
    const pipeline = mock<InboundPipeline>(async () => ({ action: "ignore" }));

    const handleUpdate = createTelegramUpdateHandler({
      api: {} as unknown as TelegramApi,
      me: ME,
      pipeline,
      allowedChats: [],
      logger: noopLogger,
      label: "Telegram[MyBot]",
      channelName: "telegram:support",
    });

    await handleUpdate(update());

    expect(pipeline).toHaveBeenCalledTimes(1);
    expect(pipeline.mock.calls[0]?.[0]?.endpointId).toBe("telegram:support");
  });

  test("a default channel's conversation key is the bare chat id - no history migration", async () => {
    const pipeline = mock<InboundPipeline>(async () => ({ action: "ignore" }));

    const handleUpdate = createTelegramUpdateHandler({
      api: {} as unknown as TelegramApi,
      me: ME,
      pipeline,
      allowedChats: [],
      logger: noopLogger,
      label: "Telegram[MyBot]",
    });

    await handleUpdate(update());

    const [msg, turn] = pipeline.mock.calls[0] ?? [];
    // Left unset so the pipeline's own rule applies; pinning it here would
    // make endpoint-keyed history unreachable on this transport.
    expect(turn?.conversationId).toBeUndefined();
    expect(conversationKeyFor(msg?.chatId ?? "", msg?.endpointId)).toBe("200");
  });
});
