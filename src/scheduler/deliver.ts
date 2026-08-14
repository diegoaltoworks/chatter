import type { ChannelSenderRegistry } from "../channels/senders";
import type { ScheduleEntry } from "./types";

export interface DeliverOptions {
  senders: ChannelSenderRegistry;
  /** Try voice first when the channel supports it; text is always the guaranteed fallback. */
  voiceAttempted?: boolean;
}

/** Delivers a composed message. Text is guaranteed; voice is only ever a best-effort first attempt. */
export async function deliver(
  entry: ScheduleEntry,
  message: string,
  options: DeliverOptions,
): Promise<boolean> {
  if (options.voiceAttempted) {
    const voiceSent = await options.senders.sendVoice(entry.channel, entry.chatId, message);
    if (voiceSent) return true;
  }
  return options.senders.sendText(entry.channel, entry.chatId, message);
}
