/**
 * The sap-ui-automation extension as a way into the user's Chrome: no remote
 * debugging switch, no "Allow?" prompt per connection, and only the tabs of
 * the sites the user allowed in the extension.
 *
 * One relay per process (relay.ts), started on first use. Its CDP endpoint is
 * handed to Playwright's `connectOverCDP` like any other Chrome endpoint.
 */
import type { DoctorCheck } from "../../core/types.js";
import type { ChromeEndpoint } from "../chrome.js";
import { allowedOrigins, originAllowed } from "../classify.js";
import { formatCode, readOrCreateCode } from "./pairing.js";
import { STORE_URL } from "./native.js";
import { execFile, spawn } from "node:child_process";
import { ExtensionRelay, type ExtensionInfo, type ExtensionSystem, type LogonOptions, type LogonResult } from "./relay.js";

type Env = Record<string, string | undefined>;

/** An MV3 service worker sleeps after 30 s idle; when asleep it reconnects on its next wake-up. */
const DEFAULT_WAIT_S = 35;

const INSTALL = `Install the SAP UI MCP extension from the Chrome Web Store (${STORE_URL}), then run \`npx -y sap-ui-automation setup --extension\` and restart Chrome once.`;
const PAIR = `Pair it: click the SAP UI MCP icon in Chrome's toolbar and Pair in the side panel (or run \`npx -y sap-ui-automation extension pair\` and paste the code it prints).`;

let relay: ExtensionRelay | undefined;
/** When the relay started listening: the wait for the extension counts from then, not again for every call. */
let startedAt = 0;
/** However long the relay has been waiting already, a call still gives the extension this long. */
const MIN_WAIT_MS = 2000;
let starting: Promise<ExtensionRelay> | undefined;

/** SAP_EXTENSION_WAIT seconds, else 35 s. */
function defaultWaitMs(env: Env): number {
  const s = Number(env.SAP_EXTENSION_WAIT);
  return (Number.isFinite(s) && s >= 0 && env.SAP_EXTENSION_WAIT?.trim() ? s : DEFAULT_WAIT_S) * 1000;
}

function wantedPort(env: Env): number | undefined {
  const raw = env.SAP_EXTENSION_PORT?.trim();
  if (!raw) return undefined;
  const port = Number(raw);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error(`SAP_EXTENSION_PORT must be a port number (got "${raw}")`);
  return port;
}

/** The process's relay, started once. */
export async function extensionRelay(env: Env = process.env): Promise<ExtensionRelay> {
  if (relay) return relay;
  if (starting) return starting;
  starting = (async () => {
    const port = wantedPort(env);
    // The server's version goes in the relay's hello. Loaded here, not at the top: server.ts is large.
    const { SERVER_VERSION } = await import("../../server.js");
    const r = new ExtensionRelay({ code: readOrCreateCode(env).code, version: SERVER_VERSION, ...(port !== undefined ? { port } : {}) });
    await r.start();
    if (panel) r.setPanel(panel);
    startedAt = Date.now();
    relay = r;
    return r;
  })();
  try {
    return await starting;
  } finally {
    starting = undefined;
  }
}

/**
 * Waits for the extension. Doctor (`stopOnRefusal`) stops at a refusal (wrong code, busy): the extension tries
 * again only every 30 s, with the same code. The server itself waits on: any local program can send a bad
 * `auth`, and must not be able to cut the server's wait short.
 */
async function connected(r: ExtensionRelay, ms: number, stopOnRefusal = false): Promise<boolean> {
  if (r.extensionInfo().connected) return true;
  if (!stopOnRefusal) return r.waitForExtension(ms);
  if (r.extensionInfo().lastRefusal) return false;
  let poll: ReturnType<typeof setInterval> | undefined;
  const refused = new Promise<boolean>((resolve) => {
    poll = setInterval(() => {
      if (r.extensionInfo().lastRefusal && !r.extensionInfo().connected) resolve(false);
    }, 200);
  });
  try {
    return await Promise.race([r.waitForExtension(ms), refused]);
  } finally {
    clearInterval(poll);
  }
}

/** The one step to take when no extension is connected. `chromeUp`: is Chrome running (undefined: unknown)? */
function missingStep(info: ExtensionInfo, waitedS: number, chromeUp?: boolean): string {
  if (info.lastRefusal === "code")
    return `The SAP UI MCP extension tried to connect with a pairing code that does not match this server's. Ask the user to click the extension's icon in Chrome and Pair again (or run \`npx -y sap-ui-automation extension pair\` and paste the code it prints).`;
  if (info.lastRefusal === "busy") return "Another sap-ui-automation is connected to the user's SAP UI MCP extension already (one server at a time). Ask the user to close the other agent app that uses it, then click Reconnect in the extension's Settings.";
  if (info.attempts > 0) return `The SAP UI MCP extension reached the server but did not pair. ${PAIR}`;
  if (chromeUp === false) return `Google Chrome is not running, so the extension cannot connect. Ask the user to open Chrome (the extension connects within a few seconds), then try again.`;
  return `No SAP UI MCP extension connected within ${waitedS} s${chromeUp ? " although Chrome is running" : ""}: it is not installed, switched off in chrome://extensions, or in another Chrome profile. ${INSTALL} Then: ${PAIR}`;
}

/** Is Google Chrome running? undefined when this cannot be told. */
export function chromeRunning(platform: NodeJS.Platform = process.platform): Promise<boolean | undefined> {
  const [cmd, args, test] =
    platform === "win32"
      ? (["tasklist", ["/FI", "IMAGENAME eq chrome.exe", "/NH"], (out: string) => /chrome\.exe/i.test(out)] as const)
      : platform === "darwin"
        ? (["pgrep", ["-x", "Google Chrome"], (out: string) => out.trim() !== ""] as const)
        : (["pgrep", ["-f", "(google-chrome|chromium|chrome-linux|/chrome)( |$)"], (out: string) => out.trim() !== ""] as const);
  return new Promise((resolve) => {
    execFile(cmd, [...args], { timeout: 3000, windowsHide: true }, (err, out) => {
      if (err && (err as NodeJS.ErrnoException).code === "ENOENT") return resolve(undefined);
      resolve(test(String(out ?? "")));
    });
  });
}

/**
 * Starts the user's own Google Chrome (their profile, no debugging switch): the extension connects once it runs.
 * On by default on macOS and Windows, where a desktop is there; SAP_EXTENSION_START_CHROME=on|off decides.
 */
export function mayStartChrome(env: Env, platform: NodeJS.Platform = process.platform): boolean {
  const v = env.SAP_EXTENSION_START_CHROME?.trim().toLowerCase();
  if (v) return /^(on|true|1|yes)$/.test(v);
  return platform === "darwin" || platform === "win32";
}

function startChrome(platform: NodeJS.Platform = process.platform): boolean {
  const [cmd, args] = platform === "darwin" ? ["open", ["-a", "Google Chrome"]] : platform === "win32" ? ["cmd", ["/c", "start", "", "chrome"]] : ["google-chrome", []];
  try {
    const child = spawn(cmd, args as string[], { detached: true, stdio: "ignore", windowsHide: true });
    child.on("error", () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/**
 * The CDP endpoint of the extension relay, once the extension is connected
 * (waits up to `waitMs`, by default SAP_EXTENSION_WAIT seconds or 35 s, since
 * the extension's worker may be asleep). Throws with the one step to take.
 */
export async function extensionEndpoint(env: Env = process.env, waitMs: number = defaultWaitMs(env)): Promise<ChromeEndpoint> {
  const r = await extensionRelay(env);
  // The first call waits for the worker to wake; later ones (another surface, the next tool call) do not wait it all again.
  const left = Math.max(MIN_WAIT_MS, startedAt + waitMs - Date.now());
  if (!(await connected(r, Math.min(waitMs, left)))) throw new Error(missingStep(r.extensionInfo(), Math.round((Date.now() - startedAt) / 1000)));
  const version = /(?:Chrome|Chromium)\/([\d.]+)/.exec(r.extensionInfo().userAgent ?? "")?.[1] ?? "";
  return { url: r.cdpUrl, kind: "extension", from: `the SAP UI MCP extension in Chrome${version ? ` ${version}` : ""} (port ${r.port})` };
}

/**
 * The relay, once the extension is connected (waits like extensionEndpoint). `start`: when Chrome is not
 * running, start it (sap_logon: the agent asked to open a system) instead of only saying so.
 */
async function connectedRelay(env: Env, start = false): Promise<ExtensionRelay> {
  const r = await extensionRelay(env);
  if (r.extensionInfo().connected) return r;
  const waitMs = defaultWaitMs(env);
  // A worker that is awake connects within a second or two; one asleep wakes with its 30 s alarm.
  if (await connected(r, Math.min(3000, waitMs))) return r;
  let up = r.extensionInfo().attempts > 0 ? true : await chromeRunning();
  if (up === false && start && mayStartChrome(env) && startChrome()) {
    if (await connected(r, Math.max(waitMs, 20000))) return r;
    up = await chromeRunning();
  }
  const left = Math.max(MIN_WAIT_MS, startedAt + waitMs - Date.now());
  if (up !== false && (await connected(r, Math.min(waitMs, left)))) return r;
  throw new Error(missingStep(r.extensionInfo(), Math.round((Date.now() - startedAt) / 1000), up));
}

/** What the side panel shows of this server; kept for a relay started later. */
let panel: Record<string, unknown> | undefined;

/** The side panel's view of this server: the agent's name and what it may do. */
export function panelInfo(info: Record<string, unknown>): void {
  panel = info;
  relay?.setPanel(info);
}

/** One step of the agent for the side panel's activity list; dropped while no relay runs. */
export function panelActivity(event: Record<string, unknown>): void {
  relay?.tell(event);
}

/** The SAP systems registered in the extension: what sap_systems lists and sap_logon opens. */
export const extensionSystems = {
  list: async (env: Env = process.env): Promise<ExtensionSystem[]> => (await connectedRelay(env)).systems(),
  logon: async (system: string, env: Env = process.env, options: LogonOptions = {}): Promise<LogonResult> => (await connectedRelay(env, true)).logon(system, options),
};

/** sap_systems and sap_logon's way to the extension (server.ts SystemsAccess), for one environment. */
export function systemsAccess(env: Env) {
  return {
    list: () => extensionSystems.list(env),
    logon: (name: string, options?: LogonOptions) => extensionSystems.logon(name, env, options),
    looksAt: (url: string) => originAllowed(url, allowedOrigins(env)),
    panel: panelInfo,
    activity: panelActivity,
  };
}

/** Setup checks: is the extension installed, paired, connected; when not, the one step to take. */
export async function extensionDoctor(env: Env = process.env, waitMs: number = defaultWaitMs(env)): Promise<DoctorCheck[]> {
  const check = "Chrome extension";
  let r: ExtensionRelay;
  try {
    r = await extensionRelay(env);
  } catch (e) {
    return [{ ok: false, check, detail: (e as Error).message, fix: "Close the other program on these ports, or set SAP_EXTENSION_PORT and the same port in the extension's options." }];
  }
  const left = Math.max(MIN_WAIT_MS, startedAt + waitMs - Date.now());
  if (!(await connected(r, Math.min(waitMs, left), true))) {
    const info = r.extensionInfo();
    if (info.lastRefusal === "code") return [{ ok: false, check, detail: "the extension is installed but holds another pairing code", fix: 'Click its icon and Pair again (or run `npx -y sap-ui-automation extension pair` and paste the code it prints).' }];
    if (info.attempts > 0) return [{ ok: false, check, detail: "the extension is installed but not paired with this server", fix: PAIR }];
    return [{ ok: false, check, detail: `no SAP UI MCP extension connected to port ${r.port} within ${Math.round(waitMs / 1000)} s`, fix: `${INSTALL} Then: ${PAIR}` }];
  }
  const info = r.extensionInfo();
  const version = /(?:Chrome|Chromium)\/([\d.]+)/.exec(info.userAgent ?? "")?.[1];
  const systems = await r.systems().catch(() => undefined);
  const { nativeHostAnswers } = await import("./native.js");
  const out: DoctorCheck[] = [
    {
      ok: true,
      check,
      detail: `extension ${info.extensionVersion || "?"} connected and paired${version ? ` in Chrome ${version}` : ""} (port ${r.port}); ${info.tabs} tab(s) of registered systems open`,
    },
    systems?.length
      ? { ok: true, check: "SAP systems", detail: systems.map((x) => `${x.name}${x.logon === "password" ? " (logs on by itself)" : x.logon === "sso" ? " (single sign-on)" : ""}`).join(", ") }
      : { ok: false, check: "SAP systems", detail: "none registered in the extension", fix: "Open your SAP system in Chrome, click the extension's icon and \"Add This SAP Page\"." },
  ];
  const helper = nativeHostAnswers();
  out.push(
    helper.ok
      ? { ok: true, check: "Extension helper", detail: `answers; passwords go to ${helper.keychain ?? "no keychain (none found: the extension saves no password)"}` }
      : { ok: false, check: "Extension helper", detail: helper.error ?? "not installed", fix: "Run `npx -y sap-ui-automation extension install` (again after changing Node.js), then restart Chrome. Without it the extension saves no password." },
  );
  return out;
}

/** Stops the relay: the extension and Playwright see their sockets close. */
export async function stopExtensionRelay(): Promise<void> {
  const r = relay ?? (starting ? await starting.catch(() => undefined) : undefined);
  relay = undefined;
  await r?.close();
}

/** What `sap-ui-automation extension pair` prints. */
export function extensionPairCommand(env: Env = process.env): string[] {
  const { code, file } = readOrCreateCode(env);
  return [
    "Pairing code for the SAP UI MCP extension:",
    "",
    `  ${formatCode(code)}`,
    "",
    file ? `It is kept in ${file} (readable only by you).` : "It comes from SAP_EXTENSION_CODE.",
    "In Chrome, click the SAP UI MCP extension's icon, open Pair with a code instead and paste the code. Pair once per Chrome profile.",
    "Not installed yet? Add SAP UI MCP from the Chrome Web Store (" + STORE_URL + "), then run `npx -y sap-ui-automation setup --extension`.",
  ];
}

export { CdpError, ExtensionRelay, type ExtensionInfo, type ExtensionSystem, type LogonOptions, type LogonResult } from "./relay.js";
export { formatCode, normalizeCode, pairingFile, readOrCreateCode } from "./pairing.js";
