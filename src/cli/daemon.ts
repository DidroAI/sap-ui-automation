/**
 * The daemon behind the agent CLI (`sap-ui-automation look`, `sap-ui-automation act` ...): one
 * long-lived process that keeps what a single MCP server keeps between
 * calls (the registry of sessions and their drivers, the Chrome connection,
 * the views an answer is diffed against, the recorder).
 *
 * It hosts the MCP server itself (`createServer`) and calls it through an
 * in-memory MCP client: the guard, the views, the recorder and every answer
 * are exactly the MCP server's. CLI calls reach it over a local socket (a
 * Unix domain socket, a named pipe on Windows) as one JSON line each way.
 *
 * One daemon per user and working directory, or per SAP_CLI_SESSION when
 * that is set. It starts on the first call, with that call's environment,
 * and exits after SAP_CLI_IDLE minutes without a call (default 30).
 */
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, closeSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { connect, createServer as createNetServer, type Server as NetServer, type Socket } from "node:net";
import { homedir, tmpdir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { policyFromEnv } from "../core/guard.js";
import type { Surface } from "../core/types.js";
import { viewModeFromEnv } from "../core/views.js";
import { recorderOptionsFromEnv } from "../record/recorder.js";
import { createServer, SERVER_NAME, SERVER_VERSION } from "../server.js";
import { extensionMode } from "../browser/chrome.js";

export type Env = Record<string, string | undefined>;

/** Where a daemon listens, and the files that go with it. */
export interface DaemonAddress {
  key: string;
  /** The socket path (Unix) or pipe name (Windows) to listen on and connect to. */
  path: string;
  /** Holds the secret a call must send; readable by the user only. */
  tokenFile: string;
  /** The daemon's stdout and stderr. */
  logFile: string;
  stateDir: string;
}

/**
 * The SAP_* variables the server reads. Others are not the daemon's settings:
 * the CLI's own (SAP_CLI_*) only say where files go and which daemon to use,
 * and SAP_USER, SAP_PASSWORD or SAP_VAR_* are for exported scripts.
 * test/cli-agent.test.ts checks this list against the sources.
 */
export const SETTINGS = [
  "SAP_ALLOW_LOGOFF",
  "SAP_ALLOW_ORIGINS",
  "SAP_ALLOW_SYSTEMS",
  "SAP_ALLOW_TCODES",
  "SAP_BLOCK_TCODES",
  "SAP_BROWSER",
  "SAP_CHROME_ARGS",
  "SAP_CHROME_CDP",
  "SAP_CHROME_PATH",
  "SAP_CHROME_PROFILE",
  "SAP_CODE",
  "SAP_CODE_TOOLS",
  "SAP_DIAG_CAPTURE",
  "SAP_DIAG_CELL",
  "SAP_DIAG_COMBO",
  "SAP_DIAG_PORT",
  "SAP_DIAG_QUIET_MS",
  "SAP_DIAG_REQUEST_MS",
  "SAP_DOWNLOAD_DIR",
  "SAP_EXTENSION_CODE",
  "SAP_EXTENSION_PORT",
  "SAP_EXTENSION_START_CHROME",
  "SAP_EXTENSION_WAIT",
  "SAP_FIORI_URL",
  "SAP_FIORI_WAIT",
  "SAP_GUI_METHOD",
  "SAP_RECORD",
  "SAP_RECORD_DIR",
  "SAP_START_URL",
  "SAP_STRUCTURED",
  "SAP_SURFACES",
  "SAP_TIMINGS",
  "SAP_VIEW",
  "SAP_WEBGUI_URL",
  "SAP_WRITE",
] as const;
const SETTING_NAMES = new Set<string>(SETTINGS);

/** A setting whose value is never printed. */
export const isSecret = (name: string) => /PASSWORD|CODE$|TOKEN|SECRET|KEY/.test(name) && name !== "SAP_CODE";

/**
 * The settings a daemon runs under: the SAP_* variables the server reads.
 * Names are upper-cased: Windows does not tell SAP_WRITE from sap_write.
 */
export function settingsOf(env: Env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    const name = k.toUpperCase();
    if (v === undefined || !SETTING_NAMES.has(name)) continue;
    out[name] = v;
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

/** The settings with secret values hidden, to show. */
export function shownSettings(settings: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(settings).map(([k, v]) => [k, isSecret(k) ? "(hidden)" : v]));
}

/** The settings that differ, said for a person: empty when there is none. A secret's value is not said. */
export function settingsDiff(daemon: Record<string, string>, call: Record<string, string>): string[] {
  const names = [...new Set([...Object.keys(daemon), ...Object.keys(call)])].sort();
  const said = (n: string, v: string | undefined) => (v === undefined ? "unset" : isSecret(n) ? "set (hidden)" : `"${v}"`);
  return names.filter((n) => daemon[n] !== call[n]).map((n) => `${n}: daemon ${said(n, daemon[n])}, this call ${said(n, call[n])}`);
}

function userTag(): string {
  try {
    return userInfo().username.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 32) || "user";
  } catch {
    return "user";
  }
}

/** A directory only this user can use (Unix: refused when someone else owns it or it is a link). */
function privateDir(dir: string, platform: NodeJS.Platform): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (platform !== "win32") {
    const st = lstatSync(dir);
    const uid = process.getuid?.();
    if (!st.isDirectory() || (uid !== undefined && st.uid !== uid)) throw new Error(`${dir} is not a directory of this user: the sap-ui-automation daemon will not use it.`);
    if ((st.mode & 0o077) !== 0) chmodSync(dir, 0o700);
  }
  return dir;
}

/**
 * The daemon for this user and directory (or SAP_CLI_SESSION). The state
 * directory is SAP_CLI_STATE_DIR when set (tests), else under
 * XDG_RUNTIME_DIR or the temp directory (Unix), or LOCALAPPDATA (Windows).
 */
export function daemonAddress(env: Env, cwd: string, platform: NodeJS.Platform = process.platform): DaemonAddress {
  const user = userTag();
  const scope = env.SAP_CLI_SESSION ? `session:${env.SAP_CLI_SESSION}` : `cwd:${platform === "win32" ? resolve(cwd).toLowerCase() : resolve(cwd)}`;
  const key = createHash("sha256").update(`${user}\n${scope}`).digest("hex").slice(0, 16);
  const base =
    env.SAP_CLI_STATE_DIR ??
    (platform === "win32"
      ? join(env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "sap-ui-automation", "daemons")
      : join(env.XDG_RUNTIME_DIR ?? tmpdir(), `sap-gui-${process.getuid?.() ?? user}`));
  const stateDir = privateDir(base, platform);
  // A Unix socket path must stay under ~104 bytes: the key keeps it short.
  const path = platform === "win32" ? `\\\\.\\pipe\\sap-gui-${user}-${key}` : join(stateDir, `${key}.sock`);
  return { key, path, tokenFile: join(stateDir, `${key}.token`), logFile: join(stateDir, `${key}.log`), stateDir };
}

/** What a CLI call sends: one line of JSON. */
export type Request =
  | { token: string; op: "call"; settings: Record<string, string>; tool: string; args: Record<string, unknown> }
  | { token: string; op: "status" }
  | { token: string; op: "stop" };

/** What the daemon answers: one line of JSON. */
export type Response =
  | { ok: true; result: CallToolResult }
  | { ok: true; status: DaemonStatus }
  | { ok: true; stopped: true }
  | { ok: false; code: "token" | "settings" | "bad-request"; error: string };

export interface DaemonStatus {
  pid: number;
  version: string;
  cwd: string;
  startedAt: string;
  lastCallAt: string;
  idleExitMinutes: number;
  calls: number;
  settings: Record<string, string>;
}

export interface DaemonOptions {
  address: DaemonAddress;
  /** The environment of the call that started it: its SAP_* settings are the daemon's for its whole life. */
  env: Env;
  cwd: string;
  /** The SAP surfaces; default: from env (tests pass fakes). */
  surfaces: Surface[];
  /** Exit after this long without a call. */
  idleMs: number;
  /** Called once the daemon has closed (after stop, idle or a signal). */
  onClosed?: () => void | Promise<void>;
}

export interface Daemon {
  close(): Promise<void>;
  readonly closed: Promise<void>;
  status(): DaemonStatus;
}

export const DEFAULT_IDLE_MINUTES = 30;

export function idleMsFromEnv(env: Env): number {
  const raw = env.SAP_CLI_IDLE;
  if (raw === undefined || raw === "") return DEFAULT_IDLE_MINUTES * 60_000;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`SAP_CLI_IDLE is minutes, a number above 0 (got "${raw}")`);
  return n * 60_000;
}

/** A call may run for a while (a replay, an action SAP takes minutes on): the MCP client's own 60 s limit does not apply. */
const CALL_TIMEOUT_MS = 60 * 60_000;
/** The most a request line may hold. */
const MAX_REQUEST = 1 << 20;

/** Starts a daemon listening on its address; resolves once it listens. */
export async function startDaemon(o: DaemonOptions): Promise<Daemon> {
  const settings = settingsOf(o.env);
  const token = randomBytes(24).toString("hex");
  // SAP_BROWSER=extension: the systems registered in the extension (sap_systems, sap_logon).
  const systems = extensionMode(o.env) ? (await import("../browser/extension/index.js")).systemsAccess : undefined;
  const { server, registry } = createServer({
    policy: policyFromEnv(o.env),
    surfaces: o.surfaces,
    view: viewModeFromEnv(o.env),
    record: recorderOptionsFromEnv(o.env, `${SERVER_NAME} ${SERVER_VERSION} (cli)`, o.cwd),
    ...(systems ? { systems: systems(o.env) } : {}),
  });
  const client = new Client({ name: "sap-gui-cli", version: SERVER_VERSION });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);

  const startedAt = new Date();
  let lastCallAt = startedAt;
  let calls = 0;
  // Calls run one after another, whatever session they name: the CLI is one agent's, and its steps are in order.
  let chain: Promise<unknown> = Promise.resolve();
  let idle: ReturnType<typeof setTimeout> | undefined;
  let closing: Promise<void> | undefined;
  let markClosed!: () => void;
  const closed = new Promise<void>((r) => (markClosed = r));
  const sockets = new Set<Socket>();

  const status = (): DaemonStatus => ({
    pid: process.pid,
    version: SERVER_VERSION,
    cwd: o.cwd,
    startedAt: startedAt.toISOString(),
    lastCallAt: lastCallAt.toISOString(),
    idleExitMinutes: o.idleMs / 60_000,
    calls,
    settings: shownSettings(settings),
  });

  const armIdle = () => {
    if (idle) clearTimeout(idle);
    idle = setTimeout(() => void close(), o.idleMs);
    idle.unref?.();
  };

  async function handle(req: Request): Promise<Response> {
    if (!req || typeof req !== "object" || typeof (req as { token?: unknown }).token !== "string") return { ok: false, code: "bad-request", error: "Not a request." };
    if (req.token !== token) return { ok: false, code: "token", error: "Wrong daemon token." };
    if (req.op === "status") return { ok: true, status: status() };
    if (req.op === "stop") {
      setImmediate(() => void close());
      return { ok: true, stopped: true };
    }
    if (req.op !== "call" || typeof req.tool !== "string") return { ok: false, code: "bad-request", error: "Unknown request." };
    // The settings a call was made under must be the daemon's, exactly.
    //
    // The daemon's guard (SAP_WRITE, the system and transaction lists, the
    // origins) was fixed when it started. A call whose environment says
    // something else must not run under it: with SAP_WRITE=off in the call
    // and "on" in the daemon, it would write where its user said no. The
    // daemon does not restart itself to take the new settings either: that
    // would silently drop the active session and an
    // open recording, and two agents in one directory with different
    // settings would keep restarting each other. It refuses, says which
    // settings differ, and the caller stops it (`sap-ui-automation daemon stop`) when
    // the new settings are meant. Stricter settings are refused as well:
    // equal is the only check that needs no judgement of what is looser.
    const differ = settingsDiff(settings, req.settings ?? {});
    if (differ.length)
      return {
        ok: false,
        code: "settings",
        error: `Not run: the sap-ui-automation daemon for this directory runs with other settings than this call (${differ.join("; ")}). Run "sap-ui-automation daemon stop", then repeat the call: a new daemon starts with this call's settings (the active session and an open recording are lost). Or call with the daemon's settings.`,
      };
    calls++;
    lastCallAt = new Date();
    const run = chain.then(async () => {
      try {
        return (await client.callTool({ name: req.tool, arguments: req.args ?? {} }, undefined, { timeout: CALL_TIMEOUT_MS })) as CallToolResult;
      } catch (e) {
        return { isError: true, content: [{ type: "text", text: (e as Error).message }] } as CallToolResult;
      }
    });
    chain = run.catch(() => {});
    const result = await run;
    lastCallAt = new Date();
    return { ok: true, result };
  }

  const net: NetServer = createNetServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    let buf = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buf += chunk;
      if (buf.length > MAX_REQUEST) return void socket.destroy();
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      const line = buf.slice(0, nl);
      buf = "";
      socket.pause();
      if (idle) clearTimeout(idle);
      let req: Request;
      try {
        req = JSON.parse(line) as Request;
      } catch {
        socket.end(`${JSON.stringify({ ok: false, code: "bad-request", error: "Not JSON." } satisfies Response)}\n`);
        if (!closing) armIdle();
        return;
      }
      void handle(req)
        .then((r) => socket.end(`${JSON.stringify(r)}\n`))
        .catch((e: Error) => socket.end(`${JSON.stringify({ ok: false, code: "bad-request", error: e.message } satisfies Response)}\n`))
        .finally(() => {
          if (!closing) armIdle();
        });
    });
  });

  async function listen(): Promise<void> {
    await new Promise<void>((ok, ko) => {
      net.once("error", ko);
      net.listen(o.address.path, () => {
        net.off("error", ko);
        ok();
      });
    });
  }
  try {
    // Two daemons starting together take turns: one never removes the socket the other just made.
    await underLock(process.platform === "win32" ? undefined : join(o.address.stateDir, `${o.address.key}.lock`), async () => {
      try {
        await listen();
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        // A socket file left by a daemon that died: nobody answers on it, so it goes. A live one keeps its socket.
        if (code !== "EADDRINUSE" || process.platform === "win32" || (await answers(o.address.path))) throw e;
        rmSync(o.address.path, { force: true });
        await listen();
      }
    });
  } catch (e) {
    await client.close().catch(() => {});
    throw e;
  }
  if (process.platform !== "win32") chmodSync(o.address.path, 0o600);
  // The token is written once the daemon listens, so a daemon that lost the race to listen never overwrites the live one's.
  const tmp = `${o.address.tokenFile}.${process.pid}.tmp`;
  writeFileSync(tmp, token, { mode: 0o600 });
  renameSync(tmp, o.address.tokenFile);
  armIdle();

  async function close(): Promise<void> {
    closing ??= (async () => {
      if (idle) clearTimeout(idle);
      await new Promise<void>((r) => net.close(() => r()));
      for (const s of sockets) s.destroy();
      // A call still running ends first: its answer is lost, but SAP is not left halfway.
      await chain.catch(() => {});
      await client.close().catch(() => {});
      await registry.closeAll().catch(() => {});
      try {
        if (readFileSync(o.address.tokenFile, "utf8") === token) rmSync(o.address.tokenFile, { force: true });
      } catch {}
      await o.onClosed?.();
      markClosed();
    })();
    return closing;
  }

  return { close, closed, status };
}

/** Is this process alive? */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Runs fn holding a lock file (created with O_EXCL). A lock whose process is
 * gone, or that is older than a minute, is taken over. No file: no lock.
 */
export async function underLock<T>(file: string | undefined, fn: () => Promise<T>, waitMs = 10_000): Promise<T> {
  if (!file) return fn();
  const until = Date.now() + waitMs;
  for (;;) {
    try {
      const fd = openSync(file, "wx", 0o600);
      writeSync(fd, String(process.pid));
      closeSync(fd);
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      let stale = false;
      try {
        // Read and dated through one descriptor: the lock looked at is the lock judged.
        const fd = openSync(file, "r");
        try {
          const pid = Number(readFileSync(fd, "utf8"));
          stale = (pid > 0 && !alive(pid)) || Date.now() - fstatSync(fd).mtimeMs > 60_000;
        } finally {
          closeSync(fd);
        }
      } catch {}
      if (stale) rmSync(file, { force: true });
      else if (Date.now() > until) throw new Error(`${file} is held by another daemon that is starting.`);
      else await new Promise((r) => setTimeout(r, 25));
    }
  }
  try {
    return await fn();
  } finally {
    rmSync(file, { force: true });
  }
}

/** Does something answer on this socket or pipe? */
function answers(path: string): Promise<boolean> {
  return new Promise((r) => {
    const s = connect(path);
    s.once("connect", () => (s.destroy(), r(true)));
    s.once("error", () => r(false));
  });
}

export class DaemonUnreachable extends Error {}

/** Sends one request and reads the one answer. Rejects with DaemonUnreachable when nothing listens. */
export function send(path: string, req: Request): Promise<Response> {
  return new Promise((resolveIt, reject) => {
    const s = connect(path);
    let buf = "";
    let connected = false;
    s.setEncoding("utf8");
    s.once("connect", () => {
      connected = true;
      s.write(`${JSON.stringify(req)}\n`);
    });
    s.on("data", (c: string) => (buf += c));
    s.once("error", (e: NodeJS.ErrnoException) => {
      if (!connected) reject(new DaemonUnreachable(e.code ?? e.message));
      else reject(new Error(`The sap-ui-automation daemon broke off the call (${e.message}).`));
    });
    s.once("close", () => {
      if (!connected) return;
      const line = buf.split("\n")[0] ?? "";
      if (!line) return reject(new Error("The sap-ui-automation daemon closed without answering (it may have been stopped during the call)."));
      try {
        resolveIt(JSON.parse(line) as Response);
      } catch {
        reject(new Error("The sap-ui-automation daemon answered something that is not JSON."));
      }
    });
  });
}

export function readToken(address: DaemonAddress): string | undefined {
  try {
    return readFileSync(address.tokenFile, "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}
