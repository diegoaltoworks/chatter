import { describe, expect, mock, test } from "bun:test";
import type { Logger } from "../../core/logger";
import type { InboundPipeline } from "../pipeline";
import type { MatrixApi, MatrixSyncResponse } from "./api";
import { createMatrixSyncHandler } from "./handler";
import type { MatrixIdentity } from "./updates";

const ME: MatrixIdentity = { userId: "@bot:example.org" };

const noopLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

function syncResponse(): MatrixSyncResponse {
  return {
    next_batch: "s1",
    rooms: {
      join: {
        "!room:example.org": {
          timeline: {
            events: [
              {
                type: "m.room.message",
                event_id: "$1",
                sender: "@alice:example.org",
                origin_server_ts: 0,
                content: { msgtype: "m.text", body: "hi" },
              },
            ],
          },
        },
      },
    },
  };
}

describe("createMatrixSyncHandler", () => {
  test("the message it hands to the pipeline carries the configured channelName as endpointId", async () => {
    const pipeline = mock<InboundPipeline>(async () => ({ action: "ignore" }));

    const handleSync = createMatrixSyncHandler({
      api: {} as unknown as MatrixApi,
      me: ME,
      pipeline,
      allowedChats: [],
      sentEventIds: new Set(),
      logger: noopLogger,
      label: "Matrix[@bot:example.org]",
      channelName: "matrix:support",
    });

    await handleSync(syncResponse());

    expect(pipeline).toHaveBeenCalledTimes(1);
    expect(pipeline.mock.calls[0]?.[0]?.endpointId).toBe("matrix:support");
  });
});
