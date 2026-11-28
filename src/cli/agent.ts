/**
 * The agent CLI: the MCP tools as shell commands, for coding agents that
 * have a shell (Claude Code, Codex, Cursor).
 *
 *   sap-ui-automation look            → sap_look       sap-ui-automation act '<json>'  → sap_act ('[...]': "actions")
 *   sap-ui-automation use <ref>       → sap_use
 *   sap-ui-automation screenshot      → sap_screenshot sap-ui-automation record <op>   → sap_record
 *   sap-ui-automation sessions        → sap_sessions (through a running daemon; else the one-shot listing)
 *   sap-ui-automation daemon status|stop
 *
 * `act` (and `okcode`, `open`) prints sap_act's whole answer, as an MCP
 * client gets it: the notes, then the lines that changed or the new screen.
 * `look` prints a few short lines (where the screen is, the status bar).
 * Each writes the path of a file that holds the whole answer. Screen lines
 * are cut at MAX_LINE; notes and the reason of an error never are.
 * The calls go to a daemon (daemon.ts) that keeps the SAP connection and
 * the MCP server's state between them.
 */
import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, readdirSync, rmSync, writeSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { disconnectChrome } from "../browser/chrome.js";
import { surfacesFromEnv } from "../surfaces.js";
import {
  type DaemonAddress,
  daemonAddress,
  DaemonUnreachable,
  type Env,
  readToken,
  type Request,
  type Response,
  send,
  settingsOf,
  shownSettings,
  startDaemon,
  idleMsFromEnv,
} from "./daemon.js";

export const AGENT_HELP = `Agent CLI (look prints a short summary and writes the whole screen to a file; act prints its whole answer, as sap_act gives it):
  sap-ui-automation look [--full] [--diff] [--id <id> [--rows 0-50] [--cols A,B]] [--print]
  sap-ui-automation act '<json action>' [--full]     e.g. act '{"do":"set","id":"ctxtVBAK-VBELN","value":"4711"}'
  sap-ui-automation act '[<json action>, ...]'       one screen's actions in one call, e.g. act '[{"do":"set","id":"ctxtVBAK-VKORG","value":"1000"},{"do":"key","key":0}]'
  sap-ui-automation act set <id> <value> | press <id> | key <n> | okcode <cmd> | select <id> | check <id> [true|false]
              | combo <id> [key] | f4 <id> | dblclick <id> | scroll <id> <to> | open <intent>    shorthand for one action
  sap-ui-automation okcode <cmd>                     same as act okcode <cmd>, e.g. okcode /nVA03 (it submits: no Enter after it)
  sap-ui-automation open <intent>                    same as act open <intent>: a Fiori app, e.g. open '#SalesOrder-manage'
  sap-ui-automation use <ref>                        make a session the active one (sessions lists them)
  sap-ui-automation screenshot                       a PNG of the session's window or tab
  sap-ui-automation record <op> ['<json>']           start <name>, assert '{"check":"status","contains":"saved"}', stop, list, ...
  sap-ui-automation daemon status|stop               the background process that keeps the SAP connection
  look, act, okcode, open, screenshot and record take --session <ref>. Exit code: 0 done, 1 error or refused, 2 usage.
  Writes need SAP_WRITE=on here: the CLI cannot ask the user, so confirm refuses them; your own command approval is the confirmation.
  SAP_CLI_DIR=dir       where answers go (default .sap-gui/screens); SAP_CLI_IDLE=30  minutes before the daemon exits
  SAP_CLI_SESSION=name  one daemon for every directory that sets this name (default: one per directory)`;

export interface AgentContext {
  env: Env;
  cwd: string;
  out: (line: string) => void;
  err: (line: string) => void;
  /** Starts a daemon when none answers. Default: `sap-ui-automation daemon run`, detached. */
  start?: (address: DaemonAddress, ctx: AgentContext) => Promise<void> | void;
  /** How long a starting daemon has to answer. */
  startTimeoutMs?: number;
}

/** The commands this module answers. */
export const AGENT_COMMANDS = new Set(["look", "act", "okcode", "open", "use", "screenshot", "record", "daemon"]);

class Usage extends Error {}

interface Parsed {
  positional: string[];
  flags: Map<string, string | true>;
}

const VALUE_FLAGS = new Set(["session", "id", "rows", "cols"]);
const BOOL_FLAGS = new Set(["full", "diff", "print"]);

function parse(argv: string[]): Parsed {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === "--") {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (!a.startsWith("--") || a.length === 2) {
      positional.push(a);
      continue;
    }
    const eq = a.indexOf("=");
    const name = a.slice(2, eq < 0 ? undefined : eq);
    if (VALUE_FLAGS.has(name)) {
      const v = eq >= 0 ? a.slice(eq + 1) : argv[++i];
      if (v === undefined) throw new Usage(`--${name} needs a value.`);
      flags.set(name, v);
    } else if (BOOL_FLAGS.has(name) && eq < 0) flags.set(name, true);
    else throw new Usage(`Unknown option --${name}.`);
  }
  return { positional, flags };
}

function only(p: Parsed, allowed: string[], cmd: string): void {
  for (const k of p.flags.keys()) if (!allowed.includes(k)) throw new Usage(`${cmd} does not take --${k}.`);
}

function json(raw: string, what: string): Record<string, unknown> {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch (e) {
    throw new Usage(`${what} is not JSON (${(e as Error).message}). Quote it for the shell: '{"do":"key","key":0}'.`);
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Usage(`${what} must be a JSON object.`);
  return v as Record<string, unknown>;
}

/** `act <verb> ...`: the positional shorthand, for the verbs whose arguments have one obvious order. */
const SHORTHAND: Record<string, string[]> = {
  set: ["id", "value"],
  press: ["id"],
  click: ["id"],
  key: ["key"],
  okcode: ["value"],
  select: ["id"],
  check: ["id", "value"],
  combo: ["id", "key"],
  f4: ["id"],
  dblclick: ["id"],
  scroll: ["id", "to"],
  open: ["app"],
};

/**
 * `act '[...]'`: the actions of a batch (sap_act's "actions"), each a JSON
 * object; sap_act checks them. Undefined when the words are not a JSON array.
 */
export function actionsOf(words: string[]): Record<string, unknown>[] | undefined {
  const [first, ...rest] = words;
  if (first === undefined || !first.trimStart().startsWith("[")) return undefined;
  if (rest.length) throw new Usage("act takes one JSON list of actions; quote it as one argument.");
  let v: unknown;
  try {
    v = JSON.parse(first);
  } catch (e) {
    throw new Usage(`The actions are not JSON (${(e as Error).message}). Quote them for the shell: '[{"do":"set","id":"...","value":"..."},{"do":"key","key":0}]'.`);
  }
  if (!Array.isArray(v) || !v.length || v.some((x) => !x || typeof x !== "object" || Array.isArray(x))) throw new Usage("act '[...]' takes a non-empty list of JSON actions (objects).");
  return v as Record<string, unknown>[];
}

export function actionOf(words: string[]): Record<string, unknown> {
  const [first, ...rest] = words;
  if (first === undefined) throw new Usage(`act needs an action: '{"do":"key","key":0}' or a shorthand such as: act set <id> <value>.`);
  if (first.trimStart().startsWith("{")) {
    if (rest.length) throw new Usage("act takes one JSON action; quote it as one argument.");
    return json(first, "The action");
  }
  const names = SHORTHAND[first];
  if (!names) throw new Usage(`"${first}" has no shorthand: write the action as JSON, e.g. act '{"do":"${first}",...}'. Shorthands: ${Object.keys(SHORTHAND).join(", ")}.`);
  if (rest.length > names.length) throw new Usage(`act ${first} takes ${names.map((n) => `<${n}>`).join(" ")}; for more (a grid cell, a row), write the action as JSON.`);
  const action: Record<string, unknown> = { do: first };
  rest.forEach((v, i) => {
    const name = names[i] as string;
    if ((name === "key" && first === "key") || name === "to") action[name] = /^\d+$/.test(v) ? Number(v) : v;
    else if (first === "check" && name === "value") action[name] = v === "false" ? false : v === "true" ? true : v;
    else action[name] = v;
  });
  return action;
}

interface Call {
  tool: string;
  args: Record<string, unknown>;
  /** How the answer is printed. */
  kind: "screen" | "list" | "text" | "image";
  print: boolean;
  /** The file name's tag: look, act, ... */
  tag: string;
}

function callOf(cmd: string, p: Parsed): Call {
  const session = p.flags.get("session") as string | undefined;
  const withSession = (args: Record<string, unknown>) => (session !== undefined ? { ...args, session } : args);
  const print = p.flags.get("print") === true;
  switch (cmd) {
    case "sessions":
      only(p, [], cmd);
      return { tool: "sap_sessions", args: {}, kind: "list", print, tag: cmd };
    case "use": {
      only(p, ["print"], cmd);
      const ref = p.positional[0];
      if (!ref || p.positional.length > 1) throw new Usage("use takes one session: a number, id, system, transaction, or sapgui, webgui, fiori (sap-ui-automation sessions lists them).");
      return { tool: "sap_use", args: { session: ref }, kind: "screen", print, tag: cmd };
    }
    case "look": {
      only(p, ["session", "full", "diff", "id", "rows", "cols", "print"], cmd);
      if (p.positional.length) throw new Usage(`look takes options only (--id, --rows, --cols, --full, --diff), not "${p.positional[0]}".`);
      const args: Record<string, unknown> = {};
      for (const k of ["id", "rows", "cols"]) if (p.flags.has(k)) args[k] = p.flags.get(k);
      if (p.flags.get("full")) args.full = true;
      if (p.flags.get("diff")) args.diff = true;
      return { tool: "sap_look", args: withSession(args), kind: "screen", print, tag: cmd };
    }
    case "act": {
      only(p, ["session", "full", "print"], cmd);
      const actions = actionsOf(p.positional);
      const args: Record<string, unknown> = actions ? { actions } : { action: actionOf(p.positional) };
      if (p.flags.get("full")) args.full = true;
      return { tool: "sap_act", args: withSession(args), kind: "screen", print, tag: cmd };
    }
    // `okcode /nVA03` and `open #SalesOrder-manage`: agents write them as commands of their own.
    case "okcode":
    case "open":
      if (p.positional.length !== 1) throw new Usage(cmd === "okcode" ? "okcode takes one command, e.g. okcode /nVA03." : "open takes one app intent, e.g. open '#SalesOrder-manage'.");
      return callOf("act", { ...p, positional: [cmd, ...p.positional] });
    case "screenshot":
      only(p, ["session"], cmd);
      return { tool: "sap_screenshot", args: withSession({}), kind: "image", print, tag: cmd };
    case "record": {
      only(p, ["session", "print"], cmd);
      const [op, more, ...extra] = p.positional;
      if (!op) throw new Usage("record needs an operation: start, assert, capture, variable, note, undo, status, stop, list, export.");
      if (extra.length) throw new Usage(`record ${op} takes one more argument at most: JSON, or a name.`);
      let args: Record<string, unknown> = { op };
      if (more !== undefined) {
        if (more.trimStart().startsWith("{")) args = { ...json(more, `record ${op}'s argument`), op };
        else if (op === "note") args.text = more;
        else if (op === "start" || op === "export") args.name = more;
        else throw new Usage(`record ${op} takes JSON, e.g. record assert '{"check":"status","contains":"saved"}'.`);
      }
      return { tool: "sap_record", args: withSession(args), kind: "text", print, tag: "record" };
    }
  }
  throw new Usage(`Unknown command "${cmd}".`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Starts `sap-ui-automation daemon run` in the background, detached from this call, with this call's environment. */
function spawnDaemon(address: DaemonAddress, ctx: AgentContext): void {
  const entry = process.argv[1];
  if (!entry) throw new Error("Cannot tell how this CLI was started: start the daemon with sap-ui-automation daemon run.");
  const log = openSync(address.logFile, "a", 0o600);
  try {
    const child = spawn(process.execPath, [...process.execArgv, entry, "daemon", "run"], {
      cwd: ctx.cwd,
      env: ctx.env as NodeJS.ProcessEnv,
      detached: true,
      stdio: ["ignore", log, log],
      windowsHide: true,
    });
    child.unref();
  } finally {
    closeSync(log);
  }
}

/**
 * One request to the daemon for this directory. With `autostart`, a daemon
 * is started when none answers; without, undefined then.
 */
async function request(address: DaemonAddress, make: (token: string) => Request, ctx: AgentContext, autostart: boolean): Promise<Response | undefined> {
  const wait = ctx.startTimeoutMs ?? 15_000;
  let deadline = Date.now() + wait;
  let started = false;
  for (;;) {
    const token = readToken(address);
    if (token) {
      try {
        const r = await send(address.path, make(token));
        // A token file from a daemon that died, read before the new one wrote its own: read it again.
        if (!r.ok && r.code === "token" && Date.now() < deadline) {
          await sleep(100);
          continue;
        }
        return r;
      } catch (e) {
        if (!(e instanceof DaemonUnreachable)) throw e;
      }
    }
    if (!autostart) return undefined;
    if (!started) {
      started = true;
      deadline = Date.now() + wait;
      await (ctx.start ?? spawnDaemon)(address, ctx);
    } else if (Date.now() > deadline) {
      throw new Error(`The sap-ui-automation daemon did not start within ${Math.round(wait / 1000)} s. Its log: ${address.logFile}`);
    }
    await sleep(50);
  }
}

/** The directory answers go to. */
function screensDir(ctx: AgentContext): string {
  return resolve(ctx.cwd, ctx.env.SAP_CLI_DIR || join(".sap-gui", "screens"));
}

/** Answers kept in the directory; older ones go. */
const KEEP = 200;

/** Writes `data` to `<dir>/<n>-<tag>.<ext>`, n one above the highest there; concurrent calls never share a file. */
export function writeAnswer(dir: string, tag: string, ext: string, data: string | Buffer): string {
  mkdirSync(dir, { recursive: true });
  const numbered = readdirSync(dir)
    .map((f) => ({ f, n: Number(/^(\d+)-/.exec(f)?.[1]) }))
    .filter((x) => Number.isInteger(x.n))
    .sort((a, b) => a.n - b.n);
  if (numbered.length > KEEP) for (const { f } of numbered.slice(0, numbered.length - KEEP)) rmSync(join(dir, f), { force: true });
  let n = (numbered.at(-1)?.n ?? 0) + 1;
  for (;;) {
    const path = join(dir, `${n}-${tag}.${ext}`);
    let fd: number;
    try {
      fd = openSync(path, "wx", 0o600);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") {
        n++;
        continue;
      }
      throw e;
    }
    try {
      if (typeof data === "string") writeSync(fd, data);
      else writeSync(fd, data);
    } finally {
      closeSync(fd);
    }
    return path;
  }
}

/** A path inside cwd as a relative path with forward slashes (the same on Windows, and fine in its shells); else the path as is. */
function shown(path: string, cwd: string): string {
  const rel = relative(cwd, path);
  return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel.split("\\").join("/") : path;
}

const MAX_LINE = 240;
const cut = (l: string) => (l.length > MAX_LINE ? `${l.slice(0, MAX_LINE - 1)}…` : l);

const STATUS_BAR = /^(?:[~+=-] )?(?:wnd\[\d+\]\/)?sbar {2}status {2}\S/;

/**
 * The lines worth printing of a screen answer (sap_act, sap_look, sap_use):
 * the lines before the screen (the action's note, the STATUS
 * line, the code line, a note about a new session), the screen's first
 * line (where it is, or how much changed), and the status bar when it says
 * something the STATUS line did not.
 */
export function screenSummary(text: string): string[] {
  const lines = text.split("\n");
  const blank = lines.indexOf("");
  // An action's answer: notes, a blank line, the screen. A look: the screen (after a "waited" note or the server's NOTE).
  let head = blank > 0 ? lines.slice(0, blank) : [];
  let body = blank > 0 ? lines.slice(blank + 1) : lines;
  if (blank <= 0)
    while (body[0]?.startsWith("(This call waited") || body[0]?.startsWith("NOTE: ")) {
      head = [...head, body[0]];
      body = body.slice(1);
    }
  // The notes are said whole; only lines of the screen are cut.
  const out = head.slice(0, 6);
  const top = body.find((l) => l.trim() !== "");
  if (top !== undefined) out.push(cut(top));
  const code = lines.find((l) => /^\s*code:/.test(l));
  if (code && !out.includes(code)) out.push(code);
  const bar = body.find((l) => STATUS_BAR.test(l));
  const hasStatus = out.some((l) => l.startsWith("STATUS "));
  if (bar && bar !== top && !(hasStatus && /status {2}[EWA]: /.test(bar))) out.push(cut(bar));
  return out;
}

/**
 * What `act` prints: sap_act's answer as the MCP client gets it (the notes,
 * then the screen or the lines that changed), each screen line cut at
 * MAX_LINE. Agents that got only "CHANGED n of m lines" ran a look or read
 * the file after nearly every act.
 */
export function actLines(text: string): string[] {
  const lines = text.split("\n");
  const blank = lines.indexOf("");
  if (blank <= 0) return lines;
  return [...lines.slice(0, blank + 1), ...lines.slice(blank + 1).map(cut)];
}

/** The first line of sap_look's answer when the screen is the one the last act answered with (server.ts UNCHANGED). */
const UNCHANGED_HEAD = "Unchanged since your last sap_act";

/** The newest act answer in the directory, if any. */
function lastAct(dir: string): string | undefined {
  let best: { n: number; f: string } | undefined;
  try {
    for (const f of readdirSync(dir)) {
      const m = /^(\d+)-act\.txt$/.exec(f);
      if (m && (!best || Number(m[1]) > best.n)) best = { n: Number(m[1]), f };
    }
  } catch {
    return undefined;
  }
  return best && join(dir, best.f);
}

/** Runs one agent CLI command; answers the exit code. */
export async function agentCommand(argv: string[], ctx: AgentContext): Promise<number> {
  const [cmd = "", ...rest] = argv;
  try {
    if (cmd === "daemon") return await daemonCommand(rest, ctx);
    const call = callOf(cmd, parse(rest));
    const address = daemonAddress(ctx.env, ctx.cwd);
    const settings = settingsOf(ctx.env);
    const r = (await request(address, (token) => ({ token, op: "call", settings, tool: call.tool, args: call.args }), ctx, true)) as Response;
    if (!r.ok) {
      ctx.err(r.error);
      return 1;
    }
    if (!("result" in r)) throw new Error("The sap-ui-automation daemon answered something else than a result.");
    return present(call, r.result, ctx);
  } catch (e) {
    if (e instanceof Usage) {
      ctx.err(`${e.message}\n\n${AGENT_HELP}`);
      return 2;
    }
    ctx.err((e as Error).message);
    return 1;
  }
}

/** `sessions` goes through the daemon only when one is running: without one, the one-shot listing is the same list. */
export async function daemonRunning(ctx: Pick<AgentContext, "env" | "cwd">): Promise<boolean> {
  const address = daemonAddress(ctx.env, ctx.cwd);
  const token = readToken(address);
  if (!token) return false;
  try {
    return (await send(address.path, { token, op: "status" })).ok;
  } catch {
    return false;
  }
}

function present(call: Call, result: CallToolResult, ctx: AgentContext): number {
  const error = result.isError === true;
  const image = result.content.find((c) => c.type === "image");
  if (image && image.type === "image") {
    const path = writeAnswer(screensDir(ctx), call.tag, "png", Buffer.from(image.data, "base64"));
    ctx.out(`screenshot: ${shown(path, ctx.cwd)}`);
    return 0;
  }
  const text = result.content
    .filter((c) => c.type === "text")
    .map((c) => (c.type === "text" ? c.text : ""))
    .join("\n");
  if (call.print || call.kind === "list") {
    ctx.out(text);
    return error ? 1 : 0;
  }
  // A look on the screen the last act answered with: that answer's file is the screen (the view that follows the line is not printed again).
  if (!error && call.tool === "sap_look" && text.startsWith(UNCHANGED_HEAD)) {
    ctx.out(text.split("\n", 1)[0] ?? "");
    const last = lastAct(screensDir(ctx));
    if (last) ctx.out(`screen: ${shown(last, ctx.cwd)}`);
    return 0;
  }
  const lines = text.split("\n");
  let printed: string[];
  if (call.tool === "sap_act") printed = actLines(text);
  else if (error) {
    // The message, whole (a reason is never cut), up to the screen that may follow it.
    const blank = lines.indexOf("");
    printed = blank > 0 ? lines.slice(0, blank) : lines;
  } else if (call.kind === "screen") printed = screenSummary(text);
  else printed = lines.length <= 4 ? lines.map(cut) : lines.slice(0, 3).map(cut);
  const whole = printed.join("\n") === text;
  const out = error ? ctx.err : ctx.out;
  for (const l of printed) out(l);
  // A screen always has its file: the agent can count on the path.
  if (!whole || call.kind === "screen") out(`${call.kind === "screen" ? "screen" : "full answer"}: ${shown(writeAnswer(screensDir(ctx), call.tag, "txt", text), ctx.cwd)}`);
  return error ? 1 : 0;
}

async function daemonCommand(argv: string[], ctx: AgentContext): Promise<number> {
  const [sub] = argv;
  const address = daemonAddress(ctx.env, ctx.cwd);
  if (sub === "status") {
    const r = await request(address, (token) => ({ token, op: "status" }), ctx, false);
    if (!r) return ctx.out("No sap-ui-automation daemon runs for this directory."), 0;
    if (!r.ok || !("status" in r)) return ctx.err(r.ok ? "Unexpected answer." : r.error), 1;
    const s = r.status;
    const settings = Object.entries(shownSettings(s.settings)).map(([k, v]) => `${k}=${v}`).join(" ") || "(no SAP_* setting: SAP_WRITE is confirm, the default; the CLI cannot ask, so writes are refused)";
    ctx.out(`sap-ui-automation daemon ${s.version}, pid ${s.pid}, for ${s.cwd}; since ${s.startedAt}, ${s.calls} call(s), last ${s.lastCallAt}; exits after ${s.idleExitMinutes} min without a call.`);
    ctx.out(`settings: ${settings}`);
    return 0;
  }
  if (sub === "stop") {
    const r = await request(address, (token) => ({ token, op: "stop" }), ctx, false);
    if (!r) return ctx.out("No sap-ui-automation daemon runs for this directory."), 0;
    if (!r.ok) return ctx.err(r.error), 1;
    ctx.out("sap-ui-automation daemon stopped.");
    return 0;
  }
  if (sub === "run") return runDaemon(address, ctx);
  throw new Usage(`daemon takes status or stop${sub ? `, not "${sub}"` : ""}.`);
}

/** `sap-ui-automation daemon run`: the daemon in this process, until it is stopped, idles out or gets a signal. */
async function runDaemon(address: DaemonAddress, ctx: AgentContext): Promise<number> {
  let daemon;
  try {
    daemon = await startDaemon({ address, env: ctx.env, cwd: ctx.cwd, surfaces: surfacesFromEnv(ctx.env), idleMs: idleMsFromEnv(ctx.env) });
  } catch (e) {
    // Another call started one first: that one serves.
    if ((e as NodeJS.ErrnoException).code === "EADDRINUSE") return ctx.err("A sap-ui-automation daemon already runs for this directory."), 0;
    throw e;
  }
  ctx.err(`sap-ui-automation daemon pid ${process.pid} listening on ${address.path} (${new Date().toISOString()})`);
  const stop = () => void daemon.close();
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  await daemon.closed;
  await disconnectChrome().catch(() => {});
  ctx.err(`sap-ui-automation daemon pid ${process.pid} exited (${new Date().toISOString()})`);
  return 0;
}
