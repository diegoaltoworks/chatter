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
 * Reconnect quirk (BOTH modes): WhatsApp closes the socket mid-pairing as a
 * matter of course - always with 515 "restart required" the moment a QR scan
 * registers the device, and again while a pairing code is being typed. The
 * link only completes if the client comes straight back with the same stored
 * credentials, so this script reconnects automatically (bounded) until the
 * connection reports "open". See src/channels/whatsapp/pairing.ts.
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
import { type PairingSocket, runPairing } from "../src/channels/whatsapp/pairing";
import { resolveQrGenerate } from "../src/channels/whatsapp/qr";

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

// A dying socket can hand back several QR refreshes before it settles; print
// the full explanation once and just the raw code on the rest.
let printedQrFallbackHelp = false;

/**
 * Prints the raw QR payload plus pairing-code instructions. Reached whenever
 * the terminal render is unavailable or throws — pairing must never dead-end
 * silently just because a QR couldn't be drawn.
 */
function printQrFallback(qr: string): void {
  if (!printedQrFallbackHelp) {
    printedQrFallbackHelp = true;
    console.log(
      "\nCouldn't render a QR image here. Raw code below (rarely scannable as text\n" +
        "directly, but confirms pairing is alive) — re-run with --code <phoneNumber>\n" +
        "for pairing-code mode instead:\n",
    );
  }
  console.log(qr);
}

async function renderQr(qr: string): Promise<void> {
  const qrcodeTerminal = await import("qrcode-terminal").catch(() => undefined);
  const generate = resolveQrGenerate(qrcodeTerminal);
  if (!generate) {
    if (!printedQrFallbackHelp) {
      console.error(
        "❌ QR mode requires the optional peer dependency 'qrcode-terminal' (not installed, or its " +
          "exports weren't recognized). Install it with `bun add qrcode-terminal`, or re-run with " +
          "--code <phoneNumber> for pairing-code mode instead.",
      );
    }
    printQrFallback(qr);
    return;
  }
  console.log("\nScan this QR code: WhatsApp -> Settings -> Linked Devices -> Link a Device.\n");
  try {
    generate(qr, { small: true });
  } catch (error) {
    console.error(`❌ QR render failed: ${(error as Error).message}`);
    printQrFallback(qr);
  }
}

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

  if (reset) {
    const { clear } = await useTursoAuthState(db, sessionSecret as string, sessionId, runtime);
    await clear();
    console.log(`Session "${sessionId}" wiped. Pairing fresh...`);
  }

  const { version } = await baileys.fetchLatestBaileysVersion();

  // Every attempt re-reads the stored session: a reconnect after a 515 MUST
  // carry the credentials the scan just registered, never a blank state.
  const connect = async (attempt: number): Promise<PairingSocket> => {
    const { state, saveCreds } = await useTursoAuthState(
      db,
      sessionSecret as string,
      sessionId,
      runtime,
    );

    if (attempt === 0 && state.creds.registered) {
      console.log(
        `Already paired. Session "${sessionId}" is connected-ready. Run with --reset to re-pair.`,
      );
      process.exit(0);
    }

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
    return sock as unknown as PairingSocket;
  };

  const result = await runPairing({
    connect,
    loggedOutCode: baileys.DisconnectReason.loggedOut,
    phoneNumber,
    onQr: renderQr,
    onPairingCode: (code) => {
      console.log("\n==============================================");
      console.log(`  Pairing code for +${phoneNumber}:  ${code}`);
      console.log("==============================================");
      console.log("On the phone: WhatsApp -> Settings -> Linked Devices ->");
      console.log("Link a Device -> 'Link with phone number instead' -> enter the code.");
      console.log("Waiting for confirmation (leave this running)...");
    },
    onStatus: (message) => console.log(message),
  });

  if (!result.ok) {
    console.error(`❌ ${result.message}`);
    process.exit(1);
  }

  console.log(`\n✅ Paired session "${sessionId}" as ${result.userId}. Session saved (encrypted).`);
  console.log("The running server will pick this session up on its next connect.");
  process.exit(0);
}

start().catch((error) => {
  console.error("❌ Unexpected error:", error);
  process.exit(1);
});
