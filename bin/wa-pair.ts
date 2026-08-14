/**
 * WhatsApp pairing CLI: `bun run wa-pair [sessionId] [options]`
 *
 * Links a WhatsApp number to the `./whatsapp` channel and persists the
 * encrypted session (see `useTursoAuthState`) so the running server picks it
 * up on its next connect. Two modes:
 *
 *   bun run wa-pair                       QR mode (default) - scan with
 *                                          WhatsApp -> Settings -> Linked
 *                                          Devices -> Link a Device.
 *   bun run wa-pair --code 447700900123   Pairing-code mode - for headless
 *                                          setups with no terminal to scan
 *                                          from; enter the printed code on
 *                                          the phone instead.
 *
 * Pairing-code flow quirk: after the code is entered, WhatsApp CLOSES the
 * socket and expects an immediate reconnect to complete registration - this
 * script reconnects automatically while a code is outstanding.
 *
 * ToS note: Baileys is an unofficial WhatsApp client. A linked number can be
 * banned - use one you can afford to lose.
 *
 * Usage:
 *   bun run wa-pair [sessionId] [--code <phoneNumber>] [--reset]
 *
 * Requires in the environment: TURSO_URL, TURSO_AUTH_TOKEN, WA_SESSION_SECRET.
 */

import { createClient } from "@libsql/client";
import { type AuthStateRuntime, useTursoAuthState } from "../src/channels/whatsapp/authState";
import { loadBaileys } from "../src/channels/whatsapp/baileys";

const args = process.argv.slice(2);

function flagValue(name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

if (args.includes("--help") || args.includes("-h")) {
  console.log(`
WhatsApp pairing CLI

Usage:
  bun run wa-pair [sessionId] [options]

Arguments:
  sessionId               Which session to pair (default: "default"). Use a
                           distinct id per WhatsApp number for multi-session.

Options:
  --code <phoneNumber>    Pair via pairing code instead of QR (digits only,
                           e.g. 447700900123). For headless setups.
  --reset                 Wipe the stored session first, then pair fresh.
  --help, -h               Show this help.

Environment:
  TURSO_URL, TURSO_AUTH_TOKEN   Required. The database auth state is stored in.
  WA_SESSION_SECRET             Required. Encrypts the stored session at rest.
`);
  process.exit(0);
}

const sessionId = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--code") ?? "default";
if (args.includes("--code") && !flagValue("--code")) {
  console.error("❌ --code requires a phone number, e.g. --code 447700900123");
  process.exit(1);
}
const phoneNumber = flagValue("--code")?.replace(/[^0-9]/g, "");
const reset = args.includes("--reset");

const sessionSecret = process.env.WA_SESSION_SECRET;
if (!sessionSecret) {
  console.error("❌ WA_SESSION_SECRET is required (any strong passphrase; keep it stable).");
  process.exit(1);
}
if (!process.env.TURSO_URL) {
  console.error("❌ TURSO_URL is required.");
  process.exit(1);
}

const db = createClient({
  url: process.env.TURSO_URL,
  authToken: process.env.TURSO_AUTH_TOKEN || "",
});

const MAX_RECONNECTS = 12; // patient: survives repeated socket bounces while a pairing code is entered
let codeRequested = false;
let reconnects = 0;
let didReset = false;

async function start(): Promise<void> {
  const baileys = await loadBaileys().catch((error) => {
    console.error(`❌ ${(error as Error).message}`);
    process.exit(1);
  });
  const runtime: AuthStateRuntime = {
    bufferJSON: baileys.BufferJSON,
    initAuthCreds: baileys.initAuthCreds,
    appStateSyncKeyFromObject: (value) =>
      baileys.proto.Message.AppStateSyncKeyData.fromObject(value),
  };
  const { state, saveCreds, clear } = await useTursoAuthState(
    db,
    sessionSecret as string,
    sessionId,
    runtime,
  );

  if (reset && !didReset) {
    didReset = true;
    await clear();
    console.log(`Session "${sessionId}" wiped. Pairing fresh...`);
    return start();
  }

  if (state.creds.registered && !codeRequested) {
    console.log(
      `Already paired. Session "${sessionId}" is connected-ready. Run with --reset to re-pair.`,
    );
    process.exit(0);
  }

  const { version } = await baileys.fetchLatestBaileysVersion();
  const noop = () => undefined;
  const logger: Record<string, unknown> = {
    level: "silent",
    trace: noop,
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    fatal: noop,
  };
  logger.child = () => logger;

  const sock = baileys.makeWASocket({
    version,
    auth: {
      creds: state.creds,
      // biome-ignore lint/suspicious/noExplicitAny: structural pino-compatible logger
      keys: baileys.makeCacheableSignalKeyStore(state.keys, logger as any),
    },
    // biome-ignore lint/suspicious/noExplicitAny: structural pino-compatible logger
    logger: logger as any,
    markOnlineOnConnect: false,
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr && !phoneNumber) {
      const qrcodeTerminal = await import("qrcode-terminal").catch(() => undefined);
      if (!qrcodeTerminal) {
        console.error(
          "❌ QR mode requires the optional peer dependency 'qrcode-terminal'. Install it with " +
            "`bun add qrcode-terminal`, or re-run with --code <phoneNumber> for pairing-code mode instead.",
        );
        process.exit(1);
      }
      console.log(
        "\nScan this QR code: WhatsApp -> Settings -> Linked Devices -> Link a Device.\n",
      );
      // biome-ignore lint/suspicious/noExplicitAny: qrcode-terminal ships no types
      (qrcodeTerminal as any).default.generate(qr, { small: true });
    }

    if (connection === "open") {
      console.log(
        `\n✅ Paired session "${sessionId}" as ${sock.user?.id}. Session saved (encrypted).`,
      );
      console.log("The running server will pick this session up on its next connect.");
      process.exit(0);
    }

    if (connection === "close") {
      const statusCode = (lastDisconnect?.error as { output?: { statusCode?: number } })?.output
        ?.statusCode;

      // Expected during pairing-code flow: WhatsApp restarts the socket
      // after the code is entered. Reconnect to complete registration.
      if (codeRequested && reconnects < MAX_RECONNECTS) {
        reconnects++;
        console.log(
          `Connection closed (${statusCode ?? "?"}) - reconnecting (code STILL VALID, keep going on the phone) (${reconnects}/${MAX_RECONNECTS})...`,
        );
        setTimeout(() => void start(), 2000);
        return;
      }

      if (statusCode === baileys.DisconnectReason.loggedOut) {
        console.error("❌ Pairing rejected (logged out). Run wa-pair again for a fresh code.");
      } else {
        console.error(`❌ Connection closed (${statusCode ?? "?"}). Run wa-pair again.`);
      }
      process.exit(1);
    }
  });

  if (phoneNumber && !codeRequested && !state.creds.registered) {
    setTimeout(async () => {
      try {
        const code = await sock.requestPairingCode(phoneNumber);
        codeRequested = true;
        console.log("\n==============================================");
        console.log(`  Pairing code for +${phoneNumber}:  ${code}`);
        console.log("==============================================");
        console.log("On the phone: WhatsApp -> Settings -> Linked Devices ->");
        console.log("Link a Device -> 'Link with phone number instead' -> enter the code.");
        console.log("Waiting for confirmation (leave this running)...");
      } catch (error) {
        console.error("❌ Failed to request pairing code:", error);
        process.exit(1);
      }
    }, 3000);
  }
}

start().catch((error) => {
  console.error("❌ Unexpected error:", error);
  process.exit(1);
});
