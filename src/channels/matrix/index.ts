/**
 * Matrix client-server transport — a {@link Channel} with NO optional peer
 * dependency: the client-server API is JSON over HTTPS (plus one raw-bytes
 * upload endpoint), reached with plain `fetch`, so this subpath costs a
 * consumer nothing beyond the package itself.
 *
 * ```ts
 * import { createMatrixChannel } from "@diegoaltoworks/chatter/matrix";
 *
 * await createServer({
 *   ...,
 *   channels: [
 *     createMatrixChannel({
 *       homeserverUrl: process.env.MATRIX_HOMESERVER_URL as string,
 *       accessToken: process.env.MATRIX_ACCESS_TOKEN as string,
 *     }),
 *   ],
 * });
 * ```
 *
 * **End-to-end encryption is not supported.** This channel only sees
 * unencrypted rooms — see docs/matrix.md for the full explanation before
 * relying on this for DMs, which most clients encrypt by default.
 *
 * Everything past turning a room event into a `ChannelMessage` runs through
 * `./channels`' `createInboundPipeline`, shared with every other channel —
 * see docs/matrix.md for configuration and docs/build-a-channel.md for the
 * SPI this implements.
 *
 * @packageDocumentation
 */

export {
  createMatrixApi,
  DEFAULT_MAX_MEDIA_BYTES,
  type MatrixAccountDataEvent,
  type MatrixApi,
  type MatrixApiConfig,
  MatrixApiError,
  type MatrixEvent,
  type MatrixInvitedRoom,
  type MatrixJoinedRoom,
  type MatrixMediaKind,
  type MatrixMediaPayload,
  type MatrixRoomTimeline,
  type MatrixStrippedStateEvent,
  type MatrixSyncResponse,
  redactToken,
} from "./api";
export { createMatrixChannel, type MatrixChannelConfig } from "./channel";
export {
  createMatrixSender,
  createMatrixSyncHandler,
  type MatrixSyncHandlerDeps,
} from "./handler";
export { retryDelayMs, runMatrixSyncLoop, syncBackoffMs } from "./sync";
export {
  directInviteFrom,
  directMappingFromEvents,
  directMappingRooms,
  directRoomIds,
  isReplyToBot,
  MAX_TRACKED_SENT_EVENTS,
  type MatrixDirectMapping,
  type MatrixIdentity,
  matrixOwnIdentities,
  matrixSenderKey,
  mentionsBot,
  messageText,
  recordSentEventId,
  toChannelMessage,
  toDirectMapping,
  withDirectRoom,
} from "./updates";
