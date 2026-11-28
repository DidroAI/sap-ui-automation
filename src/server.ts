/**
 * The MCP server: seven tools over the registry of open SAP sessions, and two
 * that turn a session into a repeatable test (record/tools.ts).
 *
 *   sap_sessions    list the SAP sessions open on this machine
 *   sap_use         make one the active session
 *   sap_look        the active screen as compact text (or full)
 *   sap_act         one action (guardrails first), then the new screen
 *   sap_screenshot  a PNG of the session's window or tab
 *   sap_systems     the SAP systems registered in the Chrome extension (SAP_BROWSER=extension)
 *   sap_logon       opens one and logs on: the extension fills SAP's logon page, the server never sees the password
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { createHash } from "node:crypto";
import { actionText, normalizeAction, type NormalizedAction, STEP_VERBS } from "./core/action.js";
import { type BatchStep, idOn, isLook, MAX_BATCH, parseBatch, popupPart, shortNote, staleWrite, stopAfter, unseenWrite } from "./batch.js";
import { dateFormatOf, type Notation, notationIn, withNumbers } from "./core/notation.js";
import { commandFieldRefusal, decide, LEAVE_UNSAVED, leavesTransaction, mayDestroy, type Policy, sessionRefusal, tcodeOf, tcodeRefusal } from "./core/guard.js";
import { type Turn, SessionQueue, waitedLine } from "./core/queue.js";
import { Registry } from "./core/registry.js";
import type { ExtensionSystem, LogonOptions, LogonResult } from "./browser/extension/relay.js";
import { ActionError, type Assessment, type Driver, type LookOptions, type SessionInfo, type Surface } from "./core/types.js";
import { type ViewMode, Views } from "./core/views.js";
import { Recorder, type RecorderOptions, recorderOptionsFromEnv } from "./record/recorder.js";
import { type ParsedScreen, parseScreen, stillWorking } from "./record/screen.js";
import { registerRecordTools } from "./record/tools.js";
import { registerCodeTools } from "./record/code-tools.js";
import { codeOf } from "./sdk/code.js";
import { type ActOutput, actOutput, screenOf, screenOfInfo, sessionsData, sessionsOutput, structuredFromEnv, withData } from "./structured.js";

export const SERVER_NAME = "sap-ui-automation";
export const SERVER_VERSION = "0.5.1";
/** Claude Code defers MCP tools until searched for, except those marked so. */
const ALWAYS_LOAD = { "anthropic/alwaysLoad": true };

/**
 * What the agent is told about actions that may write, for the write setting
 * the server runs with: one sentence, true for this server. Under confirm the
 * client asks the user (MCP elicitation); a client that cannot gets writes
 * refused, and the first answer says so (`confirmNotice`).
 */
export function writeRule(policy: Policy): string {
  if (policy.write === "off")
    return "An action that may write (save, post, delete...) is refused: the user has set writing off. Then tell the user what you would have saved, leave the transaction without saving (okcode /n) so its lock is released, and stop: do not look for another way.";
  if (policy.write === "on") return "An action that may write (save, post, delete...) runs: the user has set writing on. Say what you saved, with the document number from the status bar.";
  return "An action that may write (save, post, delete...) runs only after the user says yes in a dialog the client shows; if they decline, leave the transaction without saving (okcode /n), then ask how to go on. A client that cannot ask the user gets it refused: then tell the user what you would have saved.";
}

/**
 * The server instructions. Some clients read only the first 512 characters
 * (Codex), so the first paragraph stands on its own: what this is, in the
 * user's words, and where to start. Routing between the tools follows.
 */
function instructions(policy: Policy, systems = false): string {
  return `Works in the SAP screens the user already has open, as that user: SAP GUI for Windows, SAP Web GUI and Fiori in Chrome (transactions such as VA01 or ME23N, ALV grids, popups). ${systems ? "It logs on only to the systems the user registered in the Chrome extension (sap_systems, sap_logon)." : "It never logs on."}
Start with sap_look, or directly with sap_act okcode /n<transaction> when the task names it. Each sap_act answer is the new screen: act again from it. Read the status bar after each call: SAP reports errors there.
${writeRule(policy)}
Type, press, Enter, open a transaction, answer a popup: sap_act ("actions": a whole screen in one call). Several sessions or systems: sap_sessions${systems ? "; a system that is not open: sap_systems, sap_logon" : ""}. Record a flow as a test or to automate it: sap_record, then sap_replay.`;
}

/**
 * The first line of sap_look's answer when the screen is the one the last
 * sap_act answer ended on; the whole view follows it (one call, not two).
 */
export const UNCHANGED = "Unchanged since your last sap_act (same screen); the whole view:";

function text(t: string): CallToolResult {
  return { content: [{ type: "text", text: t }] };
}
function fail(t: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text: t }] };
}
async function answer(f: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await f();
  } catch (e) {
    return fail((e as Error).message);
  }
}

/** "https://myhost:44300" for a browser session; undefined for SAP GUI. */
function originOf(s: SessionInfo): string | undefined {
  try {
    return s.url ? new URL(s.url).origin : undefined;
  } catch {
    return undefined;
  }
}

export function sessionLine(s: SessionInfo, i: number, active: boolean): string {
  const sys = [s.system && `${s.system}${s.client ? ` (${s.client})` : ""}`, s.user].filter(Boolean).join(" ");
  const origin = originOf(s);
  // A tab whose system SAP does not show yet (loading, a popup, not logged on) is not one to work in yet.
  // Fiori: some launchpads never name their system, so only Web GUI, whose status bar always does.
  const unverified = !s.system && s.surface === "webgui" ? "  (not verified: SAP shows no system yet; call sap_sessions again before using it)" : "";
  return `${i + 1}. ${active ? "* " : "  "}${s.surface.padEnd(6)} ${sys.padEnd(22)} ${(s.transaction ?? "").padEnd(8)} "${s.title ?? ""}"  [${s.where}]${origin ? `  origin=${origin}` : ""}  id=${s.id}${unverified}`;
}

const place = (s: SessionInfo) => `${s.system ?? "?"}${s.client ? `/${s.client}` : ""}${s.transaction ? `, ${s.transaction}` : ""}${s.title ? ` ("${s.title}")` : ""}`;

/**
 * An answer that leaves out the status bar because it did not change still
 * says it when it is an error, a warning or an abort: an agent that reads
 * only the last answer must not take a second Enter on the same error for
 * a step that went through.
 */
export function withStatus(shown: string, view: string): string {
  const status = view.split("\n").find((l) => /^(wnd\[0\]\/)?sbar {2}status {2}[EWA]: /.test(l));
  if (!status || shown.includes(status)) return shown;
  return `${shown}\n= ${status}`;
}

/** What to do about a message of the status bar, by its type. */
const STATUS_HINT: Record<string, string> = {
  E: "error: correct the input it names, then Enter",
  W: "warning: Enter accepts it and goes on; another warning may follow, and each takes its own Enter. SAP may keep the fields closed until then, and fills nothing in before",
  A: "termination: SAP ended the transaction",
};

/**
 * An error, a warning or a termination in the status bar is the first thing
 * the answer says, with what to do about it: in the view the status bar is
 * the last line, after every field the message closed. This is that line,
 * to go right under the action's note; undefined when there is no such
 * message, or the answer already has the status line within its first lines.
 */
export function statusTop(shown: string, view: string): string | undefined {
  const m = /^(?:wnd\[0\]\/)?sbar {2}status {2}([EWA]): (.*)$/m.exec(view);
  if (!m || shown.split("\n").slice(0, 2).some((l) => l.endsWith(m[0]))) return undefined;
  return `STATUS ${m[1]}: ${m[2]}  (${STATUS_HINT[m[1] as string]})`;
}

/**
 * A failure that leaves the agent at a loss, with the step to take next. A
 * field SAP closed and a control that does not scroll are, most of the time,
 * a status message or a popup the agent has not answered: SAP keeps the
 * fields closed until then.
 */
export function withNextStep(message: string): string {
  if (/\b(is read-only|greyed out|does not scroll)\b/.test(message) && !/status bar|popup/i.test(message))
    return `${message}\nNext: read the status bar and any popup (WINDOW wnd[1]) in the screen below and answer them first: SAP keeps fields closed until a warning is accepted with Enter or a popup is answered. A field that stays closed cannot be changed on this screen.`;
  return message;
}

/** What the user was shown when asked to confirm: the action runs only if all of it still holds. */
interface Shown {
  session: string;
  /** How many actions the server had run in the session when the user was asked. */
  acts: number;
  surface: string;
  system: string | undefined;
  client: string | undefined;
  transaction: string | undefined;
  title: string | undefined;
  action: NormalizedAction;
  risk: string;
  reason: string;
}

function shownOf(info: SessionInfo, action: NormalizedAction, a: Assessment, acts = 0): Shown {
  return { session: info.id, acts, surface: info.surface, system: info.system, client: info.client, transaction: info.transaction, title: info.title, action, risk: a.risk, reason: a.reason };
}

/** What differs between what the user confirmed and what is there now; empty when nothing does. */
export function changedSince(then: Shown, now: Shown): string[] {
  const out: string[] = [];
  const was = (name: string, a: string | undefined, b: string | undefined) => {
    if ((a ?? "") !== (b ?? "")) out.push(`${name} was "${a ?? ""}", is now "${b ?? ""}"`);
  };
  was("session", then.session, now.session);
  was("surface", then.surface, now.surface);
  was("system", then.system, now.system);
  was("client", then.client, now.client);
  was("transaction", then.transaction, now.transaction);
  was("window title", then.title, now.title);
  was("action", actionText(then.action), actionText(now.action));
  was("what the action does", `${then.risk}: ${then.reason}`, `${now.risk}: ${now.reason}`);
  // A field set by another call while the user read the question: the screen looks the same, the data does not.
  if (now.acts !== then.acts) out.push(`${now.acts - then.acts} other action(s) ran in this session while the user was asked`);
  return out;
}

/** The time the user has to answer the client's confirmation dialog. */
const ELICIT_TIMEOUT_MS = 5 * 60_000;

/**
 * The fields of one action, flat: sap_act takes them at the top level, and
 * each entry of "actions" takes them too (its schema does not repeat them:
 * tools/list is in every conversation). Plain types and no union of
 * objects, so the schema converts to OpenAI's strict mode; normalizeAction
 * checks the rest (a whole "row", a known "key", "to" of a scroll). "do"
 * takes "look" too (STEP_VERBS): agents send it, and it is answered, not refused.
 */
const scalar = z.union([z.string(), z.number(), z.boolean()]);
const actionFields = {
  do: z.enum(STEP_VERBS),
  id: z.string().optional(),
  value: scalar.optional(),
  key: z.union([z.number(), z.string()]).optional(),
  // Whole numbers, checked by normalizeAction: .int() would put the safe-integer bounds into tools/list.
  row: z.number().optional(),
  col: z.string().optional(),
  how: z.string().optional(),
  node: z.string().optional(),
  button: z.string().optional(),
  to: z.union([z.number(), z.string()]).optional(),
  app: z.string().optional(),
  timeout: z.number().optional(),
};
/**
 * What a step of "actions" adds to an action (batch.ts reads them). Loose, so
 * that batch.ts, not the schema, refuses a key or a "do" it does not know,
 * with the list of the ones it does ("expect" has no "screeen"), and nothing runs.
 */
const stepSchema = z
  .object({
    // The action's own fields are those of sap_act (the description lists them); normalizeAction checks each step.
    do: z.string(),
    expect: z.object({}).passthrough().optional(),
    show: z.boolean().optional(),
    unseen: z.boolean().optional(),
  })
  .passthrough();
/** The keys of sap_act's input that are not part of the action. */
const CALL_KEYS = new Set(["session", "full", "actions", "action"]);

export interface ServerOptions {
  policy: Policy;
  surfaces: Surface[];
  /** What sap_act answers with: the changes when that is shorter ("diff", the default), or always the whole screen ("full"). */
  view?: ViewMode;
  /** Where recordings go and whether every session is recorded; default: from SAP_RECORD_DIR and SAP_RECORD. */
  record?: RecorderOptions;
  /**
   * Ends each answer of an action that ran with the SDK line that repeats it.
   * Default (undefined): only while a recording is on, where the agent is
   * building a script; SAP_CODE=on or off forces it either way (codeFromEnv).
   */
  code?: boolean;
  /** Adds structuredContent (structured.ts) to the answers code reads, and declares their output schemas; default: SAP_STRUCTURED=on. */
  structured?: boolean;
  /** The systems registered in the Chrome extension (SAP_BROWSER=extension): adds sap_systems and sap_logon. */
  systems?: SystemsAccess;
}

/** The extension's systems, as the server reaches them (src/browser/extension/index.ts, extensionSystems). */
export interface SystemsAccess {
  list(): Promise<ExtensionSystem[]>;
  logon(system: string, options?: LogonOptions): Promise<LogonResult>;
  /** May the server look at a tab of this address (SAP_ALLOW_ORIGINS)? Absent: every registered system's. */
  looksAt?(url: string): boolean;
  /** The extension's side panel: who the agent is and what it may do. */
  panel?(info: Record<string, unknown>): void;
  /** One step of the agent, for the side panel's activity list. */
  activity?(event: Record<string, unknown>): void;
}

/** The agent's name as people know it, from the client's MCP name ("codex-mcp-client" is Codex). */
export function agentName(client: { name?: string | undefined; title?: string | undefined } | undefined): string {
  const n = `${client?.title ?? ""} ${client?.name ?? ""}`;
  const known: [RegExp, string][] = [
    [/claude[- ]?code/i, "Claude Code"],
    [/claude/i, "Claude"],
    [/codex/i, "Codex"],
    [/cursor/i, "Cursor"],
    [/windsurf/i, "Windsurf"],
    [/visual studio code|vscode|copilot/i, "VS Code"],
    [/gemini/i, "Gemini"],
  ];
  for (const [re, label] of known) if (re.test(n)) return label;
  return (client?.title || client?.name || "Your agent").slice(0, 40);
}

/** The label a control has on a view ("Order" for `ctxtVBAK-VBELN  field  Order = ""`), for the side panel's activity. */
export function labelOn(view: string | undefined, id: unknown): string {
  if (!view || typeof id !== "string" || !id.trim()) return "";
  const want = id.trim().replace(/\[\d+,\d+\]$/, "");
  for (const l of view.split("\n")) {
    const parts = l.trim().split("  ");
    const got = (parts[0] ?? "").replace(/\[\d+,\d+\]$/, "");
    if (got !== want && !got.endsWith(`/${want}`)) continue;
    const label = (parts[2] ?? "").replace(/\s*=.*$/, "").replace(/^"|"$/g, "").trim();
    return label.slice(0, 80);
  }
  return "";
}

/** What the side panel's settings say the agent may do: the server's policy, never a secret. */
export function panelPolicy(policy: Policy): Record<string, unknown> {
  return { write: policy.write, systems: policy.allowSystems, transactions: policy.allowTcodes, blocked: policy.blockTcodes, logoff: !!policy.allowLogoff };
}

const KIND_NAME: Record<string, string> = { webgui: "Web GUI", fiori: "Fiori launchpad", other: "SAP" };
const LOGON_NAME: Record<string, string> = {
  password: "the extension logs on with the saved password",
  sso: "single sign-on: SAP logs on by itself",
  manual: "no password saved: the user logs on in the tab",
};

/** What stands from the last logon (ExtensionSystem.issue): the agent must not retry before the user acts. */
const ISSUE_NAME: Record<string, string> = {
  wrong_password: "SAP refused its saved password: the user updates it in the extension before the next logon",
  user_locked: "SAP said the user is locked: the user has it unlocked, then logs on from the extension's side panel",
};

/** One line per registered system. */
export function systemLine(x: ExtensionSystem, i: number): string {
  const facts = [KIND_NAME[x.kind] ?? "SAP", x.url, x.client && `client ${x.client}`, x.language && `language ${x.language}`, x.user && `user ${x.user}`].filter(Boolean).join(", ");
  const issue = x.issue && ISSUE_NAME[x.issue.reason] ? ` Last logon: ${ISSUE_NAME[x.issue.reason]}.` : "";
  return `${i + 1}. ${x.name}: ${facts}. ${LOGON_NAME[x.logon] ?? ""}${x.open ? " (open in a tab now)" : ""}${issue}`;
}

/** The actions kept per session for a draft test (sap_record {"op":"code"} with no recording on). */
const MAX_HISTORY = 200;

/** "120-180" or "120": the first and last row, counted from 0. */
export function parseRows(rows: string): { from: number; to: number } {
  const m = /^\s*(\d+)\s*(?:(?:-|to|\.\.)\s*(\d+))?\s*$/.exec(rows);
  if (!m) throw new ActionError('"rows" is a range counted from 0, such as "120-180".');
  const from = Number(m[1]);
  const to = m[2] === undefined ? from : Number(m[2]);
  if (to < from) throw new ActionError(`"rows" ends before it starts: ${rows}.`);
  if (to - from >= MAX_ROWS) throw new ActionError(`"rows" may span ${MAX_ROWS} rows at most; ask for ${from}-${from + MAX_ROWS - 1}, then go on from there.`);
  return { from, to };
}
/** The most rows one sap_look reads by scrolling. */
const MAX_ROWS = 200;
/** The rows read when "cols" comes without "rows": from the first row on. */
const COLS_ONLY_ROWS = { from: 0, to: 49 };

/** SAP_CODE: "on" or "off" forces the code line; anything else leaves it to the recording (undefined). */
export function codeFromEnv(value: string | undefined): boolean | undefined {
  if (/^(on|true|1)$/i.test(value ?? "")) return true;
  if (/^(off|false|0)$/i.test(value ?? "")) return false;
  return undefined;
}

export function createServer({ policy, surfaces, view = "diff", record, code = codeFromEnv(process.env.SAP_CODE), structured = structuredFromEnv(process.env.SAP_STRUCTURED), systems }: ServerOptions) {
  const registry = new Registry(surfaces, policy);
  const views = new Views(view);
  const recorder = new Recorder(record ?? recorderOptionsFromEnv(process.env, `${SERVER_NAME} ${SERVER_VERSION}`));
  const server = new McpServer(
    {
      name: SERVER_NAME,
      version: SERVER_VERSION,
      title: "SAP UI MCP",
      description: "See and drive the SAP screens open on this machine (SAP GUI for Windows, Web GUI, Fiori), with guardrails on writes",
      websiteUrl: "https://github.com/DidroAI/sap-ui-mcp",
    },
    { instructions: instructions(policy, !!systems) });
  // The extension's side panel learns who the agent is once the client said its name.
  const agent = () => agentName(server.server.getClientVersion());
  if (systems?.panel) {
    const tellPanel = () => systems.panel?.({ agent: server.server.getClientVersion() ? agent() : "", policy: panelPolicy(policy) });
    tellPanel();
    const before = server.server.oninitialized;
    server.server.oninitialized = () => {
      before?.();
      tellPanel();
    };
  }
  /** One step for the side panel: what ran, waits for the user, or was refused. Field values are cut short; the panel is local. */
  const tell = (info: SessionInfo, action: NormalizedAction, state: "ran" | "waiting" | "refused" | "declined", label = labelOn(views.last(info.id), action.id)) => {
    if (!systems?.activity) return;
    const value = action.do === "key" ? String(action.key ?? "") : action.do === "set" || action.do === "okcode" || action.do === "open" || action.do === "combo" ? String(action.value ?? action.app ?? "").slice(0, 80) : "";
    systems.activity({ state, do: action.do, label, value, transaction: info.transaction ?? "", title: (info.title ?? "").slice(0, 120), system: info.system ?? "", client: info.client ?? "", agent: agent(), at: Date.now() });
  };
  const session = z.string().optional().describe("number, id, system, transaction or sapgui|webgui|fiori; default: the active one");
  const queue = new SessionQueue();
  /** The data of an answer, when structured output is on; undefined (nothing added) when it is off. */
  const data = <T extends Record<string, unknown>>(make: () => T): T | undefined => (structured ? make() : undefined);
  /** What an action that ran answers as data: one of one, and where the session is now. */
  const ranOn = (v: string): ActOutput => ({ ran: 1, total: 1, ...screenOf(v) });
  /** Does an answer end with the SDK line? Asked after the action: a recording is on or off by then. */
  const codeLine = () => code ?? recorder.recording;
  /**
   * The logon each session was last seen with. SAP GUI ids are positions ("ses[0]"): after a log off and a
   * logon to another system the same id is another session, and what the server kept for it (actions,
   * notation, the last view, a refused write) is forgotten.
   */
  const logons = new Map<string, string>();
  async function attach(ref: string | undefined) {
    const hit = await registry.session(ref);
    const { id, system, client, user } = hit.info;
    const logon = [system, client, user].map((x) => (x ?? "").toUpperCase()).join("/");
    const was = logons.get(id);
    if (was !== undefined && was !== logon) {
      for (const m of [history, actShown, actCount, notations]) m.delete(id);
      settingsAsked.delete(id);
      writeRefused.delete(id);
      views.forget(id);
    }
    logons.set(id, logon);
    return hit;
  }
  /** The actions that ran, per session, oldest first. */
  const history = new Map<string, NormalizedAction[]>();
  function remember(session: string, action: NormalizedAction): void {
    const list = history.get(session) ?? [];
    list.push(action);
    if (list.length > MAX_HISTORY) list.splice(0, list.length - MAX_HISTORY);
    history.set(session, list);
  }

  /**
   * The screen each session's last sap_act answer ended on, as a fingerprint
   * of its compact view. A bare sap_look right after it, on the same screen,
   * says so first (UNCHANGED), then gives the whole view: agents called it
   * after most acts, for a screen they already had (169 of them in one
   * benchmark), and a one-line answer made them call it a second time.
   */
  const actShown = new Map<string, string>();
  const fingerprint = (view: string) => createHash("sha1").update(view).digest("hex");
  /** Actions run per session, so a confirmation can tell that another call acted while the user was asked. */
  const actCount = new Map<string, number>();
  const counted = <T>(session: string, f: () => Promise<T>): Promise<T> => {
    actCount.set(session, (actCount.get(session) ?? 0) + 1);
    return f();
  };

  /**
   * Each session's number and date notation (core/notation.ts): from the
   * user's settings when the surface reads them (asked once), else from the
   * screens seen so far. An answer that shows a number with a point or a
   * comma and no notation of its own gets a NUMBERS line from here, or one
   * that says the notation is unknown.
   */
  const notations = new Map<string, Notation>();
  const settingsAsked = new Set<string>();
  async function learn(d: Driver, session: string, view: string): Promise<void> {
    let n: Notation = { ...notations.get(session) };
    if (d.notation && !settingsAsked.has(session)) {
      settingsAsked.add(session);
      const set = await d.notation().catch(() => undefined);
      if (set?.sign) n = { ...n, sign: set.sign, spaced: set.spaced === true, from: "settings" };
      if (set?.date) n.date = set.date;
    }
    const seen = n.from === "settings" ? undefined : notationIn(view);
    if (seen?.sign) n = { ...n, sign: seen.sign, spaced: seen.spaced === true, from: "screen" };
    // A session of the same logon (an /o session) is the same user: it writes numbers and dates the same way.
    if (!n.sign || !n.date) {
      const sib = sameLogon(session);
      if (!n.sign && sib?.sign) n = { ...n, sign: sib.sign, spaced: sib.spaced === true, ...(sib.from ? { from: sib.from } : {}) };
      if (!n.date && sib?.date) n.date = sib.date;
    }
    // Fiori writes dates by the browser's locale, not by the user's SAP setting.
    const date = view.startsWith("FIORI") ? undefined : dateFormatOf(view);
    if (date && !n.date) n.date = date;
    if (n.sign || n.date) notations.set(session, n);
  }
  /** What another session of the same surface, system, client and user knows of the notation. */
  function sameLogon(session: string): Notation | undefined {
    const me = registry.resolve(session);
    if (!me?.system || !me.client || !me.user) return undefined;
    for (const [id, n] of notations) {
      if (id === session || !(n.sign || n.date)) continue;
      const o = registry.resolve(id);
      if (o && o.id === id && o.surface === me.surface && o.system === me.system && o.client === me.client && o.user === me.user) return n;
    }
    return undefined;
  }
  /** `answer` (which shows `view`, or part of it) with the session's NUMBERS line where it needs one. */
  async function said(d: Driver, session: string, view: string, answer: string): Promise<string> {
    await learn(d, session, view).catch(() => {});
    return withNumbers(answer, notations.get(session));
  }

  /** The queue a call on `ref` waits in: the session's id, found without opening it. */
  async function laneOf(ref: string | undefined): Promise<string> {
    return (await registry.target(ref)).id;
  }

  /** The result, with a first line that says how long it waited for the call before it, when it did. */
  function withTurn(r: CallToolResult, turn: Turn): CallToolResult {
    const line = waitedLine(turn);
    const first = r.content[0];
    if (!line || first?.type !== "text") return r;
    return { ...r, content: [{ ...first, text: `${line}\n${first.text}` }, ...r.content.slice(1)] };
  }

  /**
   * Runs `f` when every call before it on the session has ended: one call at a time per session. `f` gets
   * the session the call queued for, so a sap_use, a logon or a new list while it waits does not move it.
   */
  async function serial(ref: string | undefined, label: string, f: (at: string | undefined) => Promise<CallToolResult>): Promise<CallToolResult> {
    const lane = await laneOf(ref);
    return queue.run(lane, label, async (turn) => withTurn(await f(lane), turn));
  }

  server.registerTool(
    "sap_sessions",
    {
      title: "List open SAP sessions",
      description:
        "The SAP sessions open (SAP GUI windows; Web GUI and Fiori tabs in Chrome); * marks the active one. Needed only with several sessions, or when a tool says none matches. " +
          "Parallel work: one session per task and its `session` on every call; calls on different sessions run at once, calls on one session wait their turn. An okcode /o<tcode> opens a new session of the same logon. " +
        (systems
          ? "A system that is not open: sap_systems lists the ones the user registered, sap_logon opens one and logs on (newSession: true for another session in a new window)."
          : "None: ask the user to open SAP and log on; this server never logs on."),
      inputSchema: {},
      ...(structured ? { outputSchema: sessionsOutput } : {}),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    () =>
      answer(async () => {
        const { sessions, hidden, errors, hint } = await registry.discover();
        const lines = sessions.map((s, i) => sessionLine(s, i, s.id === registry.active));
        if (!sessions.length) lines.push(systems ? `No SAP session found. ${await systemsHint()}` : hint ? `No SAP session found. ${hint}` : "No SAP session found.");
        if (hidden) lines.push(`${hidden} session(s) of systems outside SAP_ALLOW_SYSTEMS are hidden.`);
        for (const e of errors) lines.push(`(${e})`);
        return withData(text(lines.join("\n")), data(() => sessionsData(sessions, registry.active)));
      }),
  );

  /** With no session open: the registered systems, so that the agent can log on without asking for an address. */
  async function systemsHint(): Promise<string> {
    try {
      const list = await systems!.list();
      if (!list.length) return "No system is registered in the Chrome extension either: ask the user to open SAP in Chrome and click Add this SAP page in the extension's side panel (the SAP UI MCP icon in Chrome's toolbar).";
      return `Systems registered in the Chrome extension: ${list.map((x) => x.name).join(", ")}. sap_logon opens one and logs on.`;
    } catch (e) {
      return `(The Chrome extension did not answer: ${(e as Error).message})`;
    }
  }

  if (systems) {
    server.registerTool(
      "sap_systems",
      {
        title: "List the registered SAP systems",
        description:
          "Lists the SAP systems the user registered in the Chrome extension: name, Web GUI or Fiori launchpad, address, client, language, user, and whether the extension can log on by itself. Use it when the task names a system that sap_sessions does not show; then sap_logon.",
        inputSchema: {},
        annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      },
      () =>
        answer(async () => {
          const list = await systems.list();
          if (!list.length) return text("No SAP system is registered in the Chrome extension. Ask the user to open their SAP system in Chrome and click Add this SAP page in the extension's side panel (the SAP UI MCP icon in Chrome's toolbar). Never ask the user for a password.");
          const lines = list.map((x, i) => systemLine(x, i) + (systems.looksAt && !systems.looksAt(x.url) ? " Outside SAP_ALLOW_ORIGINS: this server does not look at its tabs." : ""));
          return text([...lines, "", "sap_logon opens one and logs on. Passwords stay in the extension: this server never sees them, and never asks the user for one."].join("\n"));
        }),
    );

    server.registerTool(
      "sap_logon",
      {
        title: "Open a registered SAP system and log on",
        description:
          "Opens a system registered in the Chrome extension (sap_systems) in a Chrome tab, brings it to the front and logs on as its saved user: the extension types the password into SAP's logon page itself, and this server never sees it. A tab of the system that is logged on already (same client and user) is used as it is, unless newSession is true: then it opens another session in a new window (for parallel work; SAP may ask about other logons). The new session becomes the active one. On a single sign-on system it waits for SAP to log on by itself. When it stops (wrong password, locked user, new password needed, SAP asking about other logons, an identity provider), the answer says what to ask the user: never retry on your own, and never ask the user for a password.",
        inputSchema: {
          system: z.string().describe("the system's name, as sap_systems lists it"),
          otherLogons: z
            .enum(["keep"])
            .optional()
            .describe('only after the user said so: SAP asks whether to end the user\'s other logons, and "keep" continues without ending them'),
          newSession: z.boolean().optional().describe("true: another session in a new window, even when one is open"),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      },
      ({ system, otherLogons, newSession }) =>
        answer(async () => {
          const r = await systems.logon(system, { ...(otherLogons ? { otherLogons } : {}), ...(newSession ? { newSession: true } : {}) });
          const who = `${r.user ? ` as ${r.user}` : ""}${r.client ? `, client ${r.client}` : ""}`;
          const head =
            r.state === "logged_on"
              ? `Logged on to ${r.system}${who}.`
              : r.state === "already"
                ? `${r.system} is open and logged on in a tab already${who}.`
                : r.state === "sso"
                  ? `Opened ${r.system}; SAP logged on by itself (single sign-on).`
                  : `Opened ${r.system}. ${r.message || "SAP shows its logon page and no password is saved: ask the user to log on in the tab that is now in front, then call sap_sessions."}`;
          if (r.state === "needs_user") return text(head);
          // An extension older than newSession reuses the open tab: said as a failure, never as a new session.
          if (newSession && r.state === "already")
            return fail(`${head} No new session was opened: the Chrome extension reused the open tab, so it does not know newSession yet. Ask the user to update the extension (npx -y sap-ui-automation extension install, then reload it in chrome://extensions).`);
          // The tab is shared again once SAP's logon page is gone: find its session, and wait until SAP shows who is logged on.
          const id = r.targetId ? `chrome:${r.targetId}` : undefined;
          let info: SessionInfo | undefined;
          for (let i = 0; i < 20; i++) {
            const { sessions } = await registry.discover();
            info = sessions.find((s) => s.id === id);
            if (info && (info.system || info.surface !== "webgui")) break;
            await new Promise((res) => setTimeout(res, 500));
          }
          if (!info) {
            // SAP_ALLOW_ORIGINS narrows what the server looks at, below what the extension shares.
            const sys = systems.looksAt ? (await systems.list().catch(() => [])).find((x) => x.name === r.system) : undefined;
            if (sys && !systems.looksAt!(sys.url))
              return text(`${head} This server does not look at ${new URL(sys.url).origin}: SAP_ALLOW_ORIGINS leaves it out. Ask whoever set up the server to add it there, or to remove SAP_ALLOW_ORIGINS (the extension already limits the server to the registered systems).`);
            return text(`${head} Its tab is not listed as a SAP session yet: call sap_sessions in a moment.`);
          }
          registry.active = info.id;
          // New or reused, its id, and whether SAP shows the system, client and user the logon was for.
          const how = r.state === "already" ? "reused (it was open already)" : "new";
          const shows = [info.system && `${info.system}${info.client ? ` (${info.client})` : ""}`, info.user].filter(Boolean).join(" ");
          const differs = (r.client && info.client && info.client !== r.client) || (r.user && info.user && info.user.toUpperCase() !== r.user.toUpperCase());
          const verified = !info.system
            ? info.surface === "webgui"
              ? "not verified yet: SAP shows no system, client or user in the tab (still loading, or a popup): call sap_sessions before using it"
              : "the launchpad names no system (some do not): sap_look shows where it is"
            : differs
              ? `SAP shows ${shows}, not the logon's client ${r.client || "?"} and user ${r.user || "?"}: look at the tab before using it`
              : `verified: SAP shows ${shows}`;
          const { sessions } = await registry.discover();
          const next = newSession ? `Pass session "${info.id}" on every call in this session.` : "The session marked * is the active one: go on with sap_look or sap_act.";
          return text([head, `Session ${info.id}: ${how}; ${verified}.`, "", ...sessions.map((s, i) => sessionLine(s, i, s.id === registry.active)), "", next].join("\n"));
        }),
    );
  }

  server.registerTool(
    "sap_use",
    {
      title: "Switch the active SAP session",
      description: 'Makes another session the active one and answers with its screen. Only to switch between several sessions; every other tool also takes "session" for one call.',
      inputSchema: { session: z.string().describe("number, id, system, transaction or sapgui|webgui|fiori") },
      // Read-only for SAP: it changes only which session this server's other tools use by default, then reads that session's screen.
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    ({ session: raw }) =>
      answer(() =>
        serial(raw, "sap_use", async (at) => {
          const { driver, info } = await attach(at);
          registry.active = info.id;
          actShown.delete(info.id);
          const v = await driver.look({ compact: true });
          return text(await said(driver, info.id, v, views.present(info.id, v, true)));
        }),
      ),
  );

  server.registerTool(
    "sap_look",
    {
      title: "Look at the SAP screen",
      description: `The SAP screen as compact text: header, one line per control (id, type, label = "value", state), tables as rows, popups as WINDOW, status bar last. Call it first, for the ids; after sap_act it is rarely needed (that answer is the new screen). Again only to read more: a grid or list shows the rows on screen and the total, read others with id and rows (${MAX_ROWS} at most), never conclude an entry is missing from the rows on screen; a dropdown, tree or text whole: id; menus: id "mbar", one menu whole: id "menu[2]"; toolbar buttons and hidden ids: full. Charts: sap_screenshot.`,
      inputSchema: {
        session,
        full: z.boolean().optional().describe("every id and toolbar button (larger)"),
        diff: z.boolean().optional().describe("only what changed since your last view"),
        id: z.string().optional().describe("one control whole: dropdown, grid, table, tree, list"),
        rows: z.string().optional().describe('with id: rows from 0, e.g. "120-180"'),
        cols: z.string().optional().describe('with id: columns by id or title, e.g. "VBELN,NETWR"'),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      // Claude Code loads MCP tools on demand; the two every task needs are there from the start.
      _meta: ALWAYS_LOAD,
    },
    ({ session: raw, full, diff, id, rows, cols }) =>
      answer(() => serial(raw, "sap_look", (at) => look(at, full, diff, id, rows, cols))).then(confirmNotice),
  );

  async function look(ref: string | undefined, full: boolean | undefined, diff: boolean | undefined, id: string | undefined, rows: string | undefined, cols: string | undefined): Promise<CallToolResult> {
    const { driver, info } = await attach(ref);
    if (rows !== undefined && !id) throw new ActionError('"rows" needs "id": the grid, table, tree or list to read.');
    if (cols !== undefined && !id) throw new ActionError('"cols" needs "id": the grid or table control whose columns to keep.');
    if (id) {
      // Columns without rows: the rows from the first one on (a page of them; the answer says where it ends).
      const range = rows !== undefined ? parseRows(rows) : cols !== undefined ? COLS_ONLY_ROWS : undefined;
      const options: LookOptions = { compact: !full, id, ...(range ? { rows: range } : {}), ...(cols !== undefined ? { cols: cols.split(",") } : {}) };
      // One control is not the screen: what the agent holds of the screen stays as it is.
      const part = await driver.look(options);
      return text(await said(driver, info.id, part, part));
    }
    // What the last sap_act answer ended on, if nothing came between: asked once.
    const acted = actShown.get(info.id);
    actShown.delete(info.id);
    if (full) {
      const whole = await driver.look({ compact: false });
      // The full view holds everything the compact one does: later changes are counted from here.
      const c = await driver.look({ compact: true });
      views.remember(info.id, c);
      return text(await said(driver, info.id, c, whole));
    }
    const view = await driver.look({ compact: true });
    // Asked for the changes ("diff"): those, also right after an action (live 2026-11-23: the whole 8 KB view came back).
    if (acted !== undefined && acted === fingerprint(view)) return text(await said(driver, info.id, view, diff ? views.present(info.id, view, false) : `${UNCHANGED}\n${views.present(info.id, view, true)}`));
    return text(await said(driver, info.id, view, views.present(info.id, view, !diff)));
  }

  /** The screen as it is, whole, after `head`: the answer to "actions":[] and to {"do":"look"} in sap_act. */
  async function current(ref: string | undefined, head: string): Promise<CallToolResult> {
    return serial(ref, "sap_look", async (at) => {
      const { driver, info } = await attach(at);
      const v = await driver.look({ compact: true });
      actShown.delete(info.id);
      const shown = withStatus(views.present(info.id, v, true), v);
      const top = statusTop(shown, v);
      return withData(text(await said(driver, info.id, v, `${head}${top ? `\n${top}` : ""}\n\n${shown}`)), data((): ActOutput => ({ ran: 0, total: 0, ...screenOf(v) })));
    });
  }

  /** Can the client ask the user (MCP elicitation, form mode)? Under SAP_WRITE=confirm, a write runs only after it did. */
  const canElicit = () => !!server.server.getClientCapabilities()?.elicitation?.form;
  /** The sap-ui-automation CLI's own client (src/cli/daemon.ts): it has nobody to ask, and says so in its own words. */
  const viaCli = () => server.server.getClientVersion()?.name === "sap-gui-cli";
  /** Who cannot ask: the CLI, or "this client". */
  const asker = () => (viaCli() ? "the sap-ui-automation CLI cannot ask the user" : "this client cannot ask the user (it does not support MCP elicitation)");
  /** Why a write is refused under confirm when the client cannot ask the user. */
  const cannotAsk = (reason: string) =>
    `this action may write to SAP (${reason}) and writing is set to confirm, but ${asker()}. Nothing ran. Tell the user what you would have saved; do not look for another way. ${LEAVE_UNSAVED} To get writes, the user can use a client that asks (MCP elicitation), or set SAP_WRITE=on on a test system and approve sap_act in the client's own tool approval; SAP_WRITE=off makes the server read-only.`;
  /**
   * Confirm mode with a client that cannot ask the user: said once, before
   * anything else of the first answer, so the agent knows before the work
   * that a save will be refused (stdio.ts also says it in the server's log).
   */
  let noticed = false;
  function confirmNotice(r: CallToolResult): CallToolResult {
    if (noticed || policy.write !== "confirm" || r.isError) return r;
    noticed = true;
    if (canElicit()) return r;
    const first = r.content[0];
    if (first?.type !== "text") return r;
    return { ...r, content: [{ ...first, text: `NOTE: writing is set to confirm, and ${viaCli() ? "the sap-ui-automation CLI cannot ask the user" : "this client cannot ask the user (no MCP elicitation)"}: actions that may write will be refused. Say so to the user before working towards a save.\n${first.text}` }, ...r.content.slice(1)] };
  }

  /**
   * Where the time of an action went, when asked for (SAP_TIMINGS=on, or "timing":true in the action):
   * a line after the note. `marks` are the times the phases ended, from the start of the call.
   */
  const timingsOn = /^(on|true|1)$/i.test(process.env.SAP_TIMINGS ?? "");
  function timed(note: string, d: Driver, wanted: boolean, t0: number, phases: [string, number][]): string {
    if (!wanted) return note;
    const total = Date.now() - t0;
    const driver = d.timing?.();
    return `${note}\n(timing: ${total} ms in the server: ${phases.map(([k, v]) => `${k} ${v}`).join(", ")}${driver ? `; the action ${driver}` : ""})`;
  }

  /** Leaves a transaction the agent may not work in, and says how that went. */
  async function leave(d: Driver): Promise<string> {
    try {
      await counted(d.info.id, () => d.act(normalizeAction({ do: "okcode", value: "/n" })));
      return "The server left it with /n; input that was not saved there is gone.";
    } catch (e) {
      return `The server could not leave it with /n (${(e as Error).message.split("\n")[0]}): leave it before doing anything else.`;
    }
  }

  /**
   * With structured output on, an answer that is not an error must carry its
   * data (the SDK checks it against the output schema): one that has none
   * gets the counts alone.
   */
  function withAnyData(r: CallToolResult, actions?: unknown): CallToolResult {
    if (!structured || r.isError || r.structuredContent) return r;
    return withData(r, { ran: 0, total: Array.isArray(actions) ? actions.length : 1, screen: {} } satisfies ActOutput);
  }

  /** Runs an action that passed the guard, then checks where it led. */
  async function perform(d: Driver, action: NormalizedAction, whole = false, risk?: string, clock?: { t0: number; judged: number; wanted: boolean }): Promise<CallToolResult> {
    const session = d.info.id;
    const a0 = Date.now();
    // "/oVA03" opens the transaction in a new session (SAP GUI: a window; Web GUI: a browser window): follow it there.
    const opens = action.do === "okcode" && typeof action.value === "string" && /^\/o\S/i.test(action.value) && (d.info.surface === "sapgui" || d.info.surface === "webgui");
    const before = opens ? new Set((await registry.discover()).sessions.map((s) => s.id)) : undefined;
    // While a recording is on, an action that works becomes a step of it.
    const done = shortNote(await counted(session, () => recorder.act(d, action, risk, () => d.act(action))));
    const acted = Date.now();
    // The line that repeats this action in a script: last in the note block. Kept for a draft test when the action ran where it should.
    const line = codeLine() ? `\ncode: ${codeOf(action)}` : "";
    const ok = async (t: string, v: string, on = session, dr: Driver = d) => {
      remember(session, action);
      actShown.set(on, fingerprint(v));
      return withData(text(await said(dr, on, v, t)), data(() => ranOn(v)));
    };
    const note = (screen: () => Promise<string>) =>
      screen().then((v) => ({ v, n: clock ? timed(done, d, clock.wanted, clock.t0, [["judge", clock.judged], ["act", acted - a0], ["answer", Date.now() - acted]]) : done }));
    if (before) {
      for (let i = 0; i < 10; i++) {
        const fresh = (await registry.discover()).sessions.find((s) => s.surface === d.info.surface && !before.has(s.id));
        if (fresh) {
          registry.active = fresh.id;
          const nd = await registry.driver(fresh.id);
          const { v, n } = await note(() => nd.look({ compact: true }));
          return ok(`${n}\nA new session opened (${fresh.where}); it is now the active one. The previous session is still open (sap_sessions lists both): to work in one of them, pass its id, session "${fresh.id}" for this one and "${session}" for the one before.${line}\n\n${views.present(fresh.id, v, true)}`, v, fresh.id, nd);
        }
        await new Promise((r) => setTimeout(r, 500));
      }
      const { v, n } = await note(() => d.look({ compact: true }));
      // SAP's own answer when the logon has all the sessions it allows (6 by default, rdisp/max_alt_modes).
      const full = /maximum number of (sap gui )?sessions|maximale anzahl.*modi|nombre maximal de sessions/i.test(v);
      const why = full
        ? `SAP refused: this logon has all the sessions it allows. Close one you no longer need${systems ? ", or open another logon with sap_logon and newSession: true (each logon has its own sessions)" : ""}; answer SAP's popup first.`
        : "No new session appeared within 5 s (SAP allows at most 6 per logon).";
      return ok(`${n}\n${why} This is still the previous session.${line}\n\n${views.present(session, v, whole)}`, v);
    }
    // A menu entry, a favourite or a tree node can open a transaction no okcode named.
    const after = await d.refresh().catch(() => undefined);
    const landed = after && sessionRefusal(policy, after);
    if (landed) {
      const left = await leave(d);
      const screen = await d
        .look({ compact: true })
        .then((v) => views.present(session, v, true))
        .catch((e: Error) => `(the screen could not be read: ${e.message.split("\n")[0]})`);
      return fail(`${done}\nThis led to a transaction the agent may not work in: ${landed}. ${left}\n\n${screen}`);
    }
    const { v, n } = await note(() => d.look({ compact: true }));
    const shown = withStatus(views.present(session, v, whole), v);
    const top = statusTop(shown, v);
    return ok(`${n}${top ? `\n${top}` : ""}${line}\n\n${shown}`, v);
  }

  /** Sessions that had a write refused: the next refusal is one line (core/guard.ts `decide`). */
  const writeRefused = new Set<string>();
  /** The session as it is now, and what the guard says about this action on it. A look-ahead (`goesOnAfter`) keeps no record. */
  async function judge(ref: string | undefined, action: NormalizedAction, lookAhead = false) {
    const { driver, info } = await attach(ref);
    // The transaction the session is in counts too, however it was opened.
    const here = sessionRefusal(policy, info);
    if (here && !leavesTransaction(policy, action))
      return { driver, info, refused: `this session is in a transaction the agent may not work in: ${here}. Leave it with {"do":"okcode","value":"/n"} or open an allowed transaction with {"do":"okcode","value":"/n<transaction>"}.` };
    // Opening an app by its intent is the Fiori launchpad's: said here, before the user is asked to confirm an action that cannot run.
    if (action.do === "open" && info.surface !== "fiori")
      throw new ActionError('open works in a Fiori launchpad tab only (sap_sessions lists the tabs). On an SAP GUI or Web GUI screen, open a transaction with {"do":"okcode","value":"/n<transaction>"}.');
    const assessment = await driver.assess(action);
    const verdict = decide(policy, action, assessment, writeRefused.has(info.id), info.surface === "fiori");
    // A look-ahead refuses nothing to the agent: the first refusal it sees stays the long one.
    if (!lookAhead && !verdict.run && "refused" in verdict && verdict.refused.startsWith("this action may write")) writeRefused.add(info.id);
    return { driver, info, assessment, verdict };
  }

  /** Runs a held action if the session and the action's assessment are still what the user was shown. */
  async function runConfirmed(shown: Shown, whole = false): Promise<CallToolResult> {
    const j = await judge(shown.session, shown.action);
    if ("refused" in j) return fail(`Refused: ${j.refused}`);
    if (!j.verdict.run && "refused" in j.verdict) return fail(`Refused: ${j.verdict.refused}`);
    const changed = changedSince(shown, shownOf(j.info, shown.action, j.assessment, actCount.get(shown.session) ?? 0));
    if (changed.length) return fail(`Not run: the screen changed since the confirmation was asked (${changed.join("; ")}). Look at the screen and call sap_act again.`);
    return perform(j.driver, shown.action, whole, j.assessment.risk);
  }

  /**
   * An action that could not run, said with where the session is now when
   * that is not what the agent last saw: an id from an earlier screen fails
   * here, and the agent gets the screen it is really on in the same answer.
   */
  async function failedOn(ref: string | undefined, e: unknown): Promise<CallToolResult> {
    const message = withNextStep((e as Error).message);
    try {
      const { driver, info } = await attach(ref);
      const now = await driver.look({ compact: true });
      const last = views.last(info.id);
      // Where the session is, in one line: the header and the window in front.
      const lines = now.split("\n");
      const here = [lines[0], lines.filter((l) => l.startsWith("WINDOW ")).at(-1)].filter(Boolean).join("  ");
      if (last === now) return fail(`${message}\nThe screen is as you last saw it: ${here}`);
      return fail(await said(driver, info.id, now, `${message}\n${last === undefined ? "The screen is:" : "The screen is not as you last saw it:"}\n\n${views.present(info.id, now)}`));
    } catch {
      return fail(message);
    }
  }

  async function run(ref: string | undefined, input: unknown, whole = false): Promise<CallToolResult> {
    // "timing" asks for where the time went; it is not part of the action.
    let raw = input;
    let wanted = timingsOn;
    if (raw && typeof raw === "object" && !Array.isArray(raw) && "timing" in raw) {
      const { timing, ...rest } = raw as Record<string, unknown>;
      wanted = timing === true || timingsOn;
      raw = rest;
    }
    // Fields of a batch step mean nothing on one action: said, not silently dropped.
    const stepOnly = raw && typeof raw === "object" && !Array.isArray(raw) ? ["expect", "show", "unseen"].filter((k) => k in raw) : [];
    if (stepOnly.length) return fail(`Refused: ${stepOnly.map((k) => `"${k}"`).join(", ")} belong${stepOnly.length === 1 ? "s" : ""} to a step of "actions" (a batch), not to a single action. Send {"actions":[{...action, ${stepOnly.map((k) => `"${k}": ...`).join(", ")}}]}, or leave ${stepOnly.length === 1 ? "it" : "them"} out.`);
    // One normalised action for the guard, for assess and for act.
    const action = normalizeAction(raw);
    const field = commandFieldRefusal(action);
    if (field) return fail(`Refused: ${field}`);
    // The guard and the action run in the session's turn; asking the user does not hold the session.
    type Held = { info: SessionInfo; assessment: Assessment; confirm: string };
    const box: { held?: Held } = {};
    // The call keeps to the session it queued for: a sap_use or a new logon while it waits does not move it.
    const at = await laneOf(ref);
    const done = await queue.run(at, actionText(action), async (turn): Promise<CallToolResult | undefined> => {
      const q0 = Date.now();
      let j: Awaited<ReturnType<typeof judge>>;
      try {
        j = await judge(at, action);
      } catch (e) {
        return withTurn(await failedOn(at, e), turn);
      }
      if ("refused" in j) return withTurn(fail(`Refused: ${j.refused}`), turn);
      const { driver, info, assessment, verdict } = j;
      // A write goes only to the screen the agent was last shown (staleWrite); before any first view there is nothing to compare.
      const seen = assessment.risk === "commit" && !("refused" in verdict) ? views.last(info.id) : undefined;
      if (seen !== undefined) {
        const now = await settled(driver);
        const stale = staleWrite(parseScreen(seen), parseScreen(now));
        if (stale) return withTurn(fail(`Not run: ${stale}.\n\n${views.present(info.id, now, true)}`), turn);
      }
      if (verdict.run) {
        const label = labelOn(views.last(info.id), action.id);
        const r = await perform(driver, action, whole, assessment.risk, { t0: q0, judged: Date.now() - q0, wanted }).catch((e: unknown) => failedOn(at, e));
        if (!r.isError) tell(info, action, "ran", label);
        return withTurn(r, turn);
      }
      if ("refused" in verdict) {
        tell(info, action, "refused");
        return withTurn(fail(`Refused: ${verdict.refused}`), turn);
      }
      if (!canElicit()) return withTurn(fail(`Refused: ${cannotAsk(verdict.confirm)}`), turn);
      box.held = { info, assessment, confirm: verdict.confirm };
      return undefined;
    });
    if (done || !box.held) return done ?? fail("Not run.");
    return confirmHeld(box.held, action, whole);
  }

  /** An action the guard holds for the user's yes: the client asks the user (MCP elicitation); it runs on a yes, if the screen is still what the user was shown. */
  async function confirmHeld(held: { info: SessionInfo; assessment: Assessment; confirm: string }, action: NormalizedAction, whole: boolean): Promise<CallToolResult> {
    const { info, assessment, confirm } = held;
    const shown = shownOf(info, action, assessment, actCount.get(info.id) ?? 0);
    const what = `${confirm}, on ${place(info)}`;
    const label = labelOn(views.last(info.id), action.id);
    tell(info, action, "waiting", label);
    let answer: Awaited<ReturnType<typeof server.server.elicitInput>>;
    try {
      answer = await server.server.elicitInput(
        {
          mode: "form",
          message: `Allow this action in SAP? It may write to the system.\n\nWhat: ${confirm}\nWhere: ${place(info)} [${info.where}]\nAction: ${actionText(action)}`,
          requestedSchema: { type: "object", properties: {} },
        },
        { timeout: ELICIT_TIMEOUT_MS },
      );
    } catch (e) {
      return fail(`Not run: the user could not be asked to confirm (${(e as Error).message.split("\n")[0]}).`);
    }
    if (answer.action !== "accept") {
      // Claude Code run headless (claude -p) says it can ask, then answers every question "cancel" at once, unseen by anyone.
      const who =
        answer.action === "decline"
          ? "the user declined"
          : "the confirmation was dismissed, or the client could not show it (a client run without a user, such as claude -p, dismisses every question): no yes came for";
      tell(info, action, "declined", label);
      const said = `Not run: ${who} this action (${what}). Stop here: do not retry it or look for another way; tell the user it was not done and ask how to go on. ${LEAVE_UNSAVED}`;
      return withData(text(said), data((): ActOutput => ({ ran: 0, total: 1, stopped: { why: "declined", text: said.split(". Stop here")[0] as string }, screen: screenOfInfo(info) })));
    }
    const r = await serial(shown.session, actionText(action), () => runConfirmed(shown, whole));
    tell(info, action, r.isError ? "declined" : "ran", label);
    // The agent does not see the dialog: without this line it told the user a confirmed popup "Yes" had saved
    // without asking them (live 2026-11-21, interactive Claude Code).
    const [first, ...more] = r.content;
    if (r.isError || first?.type !== "text") return r;
    return { ...r, content: [{ ...first, text: `The user confirmed this action in the client (${confirm}).\n${first.text}` }, ...more] };
  }

  /**
   * After a step that led to another screen: may the batch go on with the
   * `next` step? Yes when that step names a control that is on the new screen
   * (compact view, else the full one) and does not write; an okcode and an
   * open name no control and go on when they do not write. A step without an
   * id (a key) means the screen it was sent for: the batch ends there.
   */
  async function goesOnAfter(d: Driver, session: string, next: BatchStep, view: string, inPopup = false): Promise<boolean> {
    const a = next.action;
    const id = typeof a.id === "string" ? a.id : undefined;
    // Through a popup a step opened: only an action on a control of that popup goes on.
    const part = (v: string) => (inPopup ? popupPart(v) : v);
    if (inPopup && !id) return false;
    if (!id && a.do !== "okcode" && a.do !== "open") return false;
    if (id && !idOn(part(view), id)) {
      const full = await d.look({ compact: false }).catch(() => "");
      if (!idOn(part(full), id)) return false;
    }
    try {
      const j = await judge(session, a, true);
      return !("refused" in j) && j.verdict.run && j.assessment.risk !== "commit";
    } catch {
      return false;
    }
  }

  /** The screen once SAP is done with the step before it (at most 15 s), as the compact view. */
  async function settled(d: Driver): Promise<string> {
    const until = Date.now() + 15_000;
    let view = await d.look({ compact: true });
    while (stillWorking(view) && Date.now() < until) {
      await new Promise((r) => setTimeout(r, 250));
      view = await d.look({ compact: true });
    }
    return view;
  }

  /**
   * Several actions in one call (batch.ts). Each is judged by the guard when
   * its turn comes, on the screen as it is then, and recorded as its own
   * step. The batch holds the session for all of them: no other call runs
   * in between. It ends before the next action when one fails, is refused or
   * waits for the user's yes, and when the screen is not what the agent could
   * foresee (`stopAfter`). The answer says what ran and why it ended, then
   * the screen once.
   */
  async function runBatch(ref: string | undefined, input: unknown, whole = false, call?: CallContext): Promise<CallToolResult> {
    const token = call?._meta?.progressToken;
    const steps = parseBatch(input);
    const total = Array.isArray(input) ? input.length : steps.length;
    if (!steps.length) return current(ref, total ? "No action to run: this is the screen." : 'No actions sent ("actions" is empty): this is the screen.');
    // What can be refused without a screen is refused before anything runs.
    for (const [i, s] of steps.entries()) {
      const no =
        commandFieldRefusal(s.action) ??
        tcodeRefusal(policy, tcodeOf(s.action)) ??
        (s.action.do === "okcode" && /^\/o\S/i.test(String(s.action.value)) ? `"${String(s.action.value)}" opens a new session: send it on its own, not in "actions"` : undefined);
      if (no) return fail(`Refused: action ${steps[i]?.n ?? i + 1} of ${total}: ${no}\nNothing ran.`);
    }
    const rest = (from: number) => (from > total ? "" : from === total ? ` Action ${total} did not run.` : ` Actions ${from} to ${total} did not run.`);
    type Held = { info: SessionInfo; assessment: Assessment; confirm: string; action: NormalizedAction };
    const box: { held?: Held; head?: string; ran?: number; stopped?: { why: string; text: string } } = {};
    const at = await laneOf(ref);
    const done = await queue.run(at, `${total} actions`, async (turn): Promise<CallToolResult | undefined> => {
      const lines: string[] = [];
      const codes: string[] = [];
      let ran = 0;
      /** Why the batch ended early (`why`: one word for code); `error` when an action failed or was refused; `next` is the first action after the one it names. */
      let end: { why: string; text: string; error: boolean; next: number } | undefined;
      let note: string | undefined;
      let driver: Driver | undefined;
      let id: string | undefined;
      let before: ParsedScreen | undefined;
      /** The screen the agent saw when it sent the batch. */
      let start: ParsedScreen | undefined;
      let view: string | undefined;
      for (const [i, s] of steps.entries()) {
        const n = s.n;
        const last = i === steps.length - 1;
        const what = `action ${n} (${actionText(s.action)})`;
        // The client cancelled the call (the user pressed Esc): the actions after the one running end here.
        if (call?.signal.aborted) {
          end = { why: "cancelled", text: `the client cancelled the call before ${what}`, error: false, next: n };
          break;
        }
        let j: Awaited<ReturnType<typeof judge>>;
        try {
          // The session the first action ran on is the session of all of them.
          j = await judge(id ?? at, s.action);
        } catch (e) {
          // No session, or an id that names nothing here: with nothing run yet, the answer is the one of a single action.
          if (i === 0) return withTurn(await failedOn(at, e), turn);
          end = { why: "failed", text: `${what} could not run: ${(e as Error).message}`, error: true, next: n + 1 };
          view = undefined;
          break;
        }
        driver = j.driver;
        id = j.info.id;
        if ("refused" in j) {
          end = { why: "refused", text: `${what} was refused: ${j.refused}`, error: true, next: n + 1 };
          break;
        }
        if (!j.verdict.run && "refused" in j.verdict) {
          tell(j.info, s.action, "refused");
          end = { why: "refused", text: `${what} was refused: ${j.verdict.refused}`, error: true, next: n + 1 };
          break;
        }
        before ??= parseScreen(await settled(driver));
        // The screen the agent saw when it sent the batch: the one it was last shown, else the one the batch began on.
        if (!start) {
          const seen = views.last(id);
          start = seen === undefined ? before : parseScreen(seen);
        }
        const blind = j.assessment.risk === "commit" ? unseenWrite(s, start, before) : undefined;
        if (blind) {
          end = { why: "unseen", text: `${what} did not run: ${blind}`, error: false, next: n };
          break;
        }
        if (!j.verdict.run && !canElicit()) {
          end = { why: "refused", text: `${what} was refused: ${cannotAsk(j.verdict.confirm)}`, error: true, next: n + 1 };
          break;
        }
        if (!j.verdict.run) {
          box.held = { info: j.info, assessment: j.assessment, confirm: j.verdict.confirm, action: s.action };
          end = { why: "held", text: `${what} may write and waits for the user's yes`, error: false, next: n + 1 };
          break;
        }
        let said: string;
        const label = labelOn(view ?? views.last(j.info.id), s.action.id);
        try {
          const d = driver;
          said = await counted(d.info.id, () => recorder.act(d, s.action, j.assessment.risk, () => d.act(s.action)));
        } catch (e) {
          end = { why: "failed", text: `${what} failed: ${(e as Error).message}`, error: true, next: n + 1 };
          view = undefined;
          break;
        }
        ran = n;
        remember(id, s.action);
        tell(j.info, s.action, "ran", label);
        if (token !== undefined)
          await call?.sendNotification({ method: "notifications/progress", params: { progressToken: token, progress: i + 1, total: steps.length, message: `${what} done` } }).catch(() => {});
        lines.push(`${n}. ${shortNote(said)}${s.note ? ` ${s.note}` : ""}`);
        codes.push(codeOf(s.action));
        // A menu entry, a favourite or a tree node can open a transaction no okcode named.
        const info = await driver.refresh().catch(() => undefined);
        const landed = info && sessionRefusal(policy, info);
        if (landed) {
          end = { why: "transaction", text: `action ${n} led to a transaction the agent may not work in: ${landed}. ${await leave(driver)}`, error: true, next: n + 1 };
          view = undefined;
          break;
        }
        view = await settled(driver);
        const after = parseScreen(view);
        const stop = stopAfter(s.action, before, after, s.expect);
        const next = steps[i + 1];
        if (stop && !last) {
          // Another screen the agent expected (Enter on an initial screen, Back, a popup answered): the next action shows where it means to be.
          if ((stop.why === "screen" || stop.why === "popup") && next && (await goesOnAfter(driver, id, next, view, stop.why === "popup"))) {
            lines[lines.length - 1] += ` (${stop.text})`;
          } else {
            end = { why: stop.why, text: `after action ${n}, ${stop.text}`, error: false, next: n + 1 };
            break;
          }
        }
        // Nothing follows the last action: only what it said it expects is worth a line.
        if (stop?.why === "expect") note = `Action ${n}: ${stop.text}.`;
        if (s.show && !last) lines.push(`--- the screen after action ${n}\n${views.present(id, view, whole)}\n---`);
        before = after;
      }
      // All ran: the actions run (a look is none), and the Enters left out after an okcode.
      const skipped = steps.filter((s) => s.note).length;
      const head = end
        ? `Ran ${ran} of ${total} actions. Stopped: ${end.text.replace(/[.\s]+$/, "")}.${rest(end.next)}`
        : `Ran ${steps.length} action${steps.length === 1 ? "" : "s"}${skipped ? `; ${skipped} Enter skipped` : ""}.`;
      const body = [head, ...(note ? [note] : []), ...lines, ...(codeLine() && codes.length ? [`code:\n${codes.join("\n")}`] : [])].join("\n");
      const stopped = end ? { why: end.why, text: end.text } : undefined;
      if (box.held) {
        // The held action's own answer follows: what it did after the user's yes, or that the user said no.
        box.head = body;
        box.ran = ran;
        if (stopped) box.stopped = stopped;
        return undefined;
      }
      let screen = "";
      let seen: string | undefined;
      if (driver && id) {
        try {
          const v = view ?? (await settled(driver));
          seen = v;
          actShown.set(id, fingerprint(v));
          const shown = withStatus(views.present(id, v, whole), v);
          const top = statusTop(shown, v);
          screen = `${top ? `\n${top}` : ""}\n\n${shown}`;
        } catch (e) {
          screen = `\n\n(the screen could not be read: ${(e as Error).message.split("\n")[0]})`;
        }
      }
      const out = data((): ActOutput => ({ ran, total, ...(stopped ? { stopped } : {}), ...(seen !== undefined ? screenOf(seen) : { screen: {} }) }));
      const all = driver && id && seen !== undefined ? await said(driver, id, seen, `${body}${screen}`) : `${body}${screen}`;
      return withTurn(withData(end?.error ? fail(all) : text(all), out), turn);
    });
    if (done || !box.held) return done ?? fail("Not run.");
    const r = await confirmHeld(box.held, box.held.action, whole);
    const first = r.content[0];
    if (first?.type !== "text") return r;
    // As data: the actions before the held one, and what the held one did (ran after the user's yes, or not).
    const after = r.structuredContent as ActOutput | undefined;
    const merged = after && data((): ActOutput => ({ ...after, ran: (box.ran ?? 0) + after.ran, total, stopped: after.stopped ?? box.stopped }));
    return withData({ ...r, content: [{ ...first, text: `${box.head}\n\n${first.text}` }, ...r.content.slice(1)] }, merged);
  }

  server.registerTool(
    "sap_act",
    {
      title: "Act on the SAP screen",
      description: `Acts on the SAP screen; answers with the new screen, on the same screen only the changes ("~" changed line, "+" new, "-" gone, "=" unchanged), so sap_look after it is rarely needed. Ids from the latest view; the last part is enough.
"STATUS E": the step did not go through, correct the field it names; W: Enter accepts it; S: done (document numbers). A new "WINDOW wnd[1]" is a popup: answer it before anything else.
set only types: fill every field, then one Enter (key 0). Codes: f4 on the field lists them.
do and its fields:
set id, value; a table cell: id (the table), row, col; "\\n" breaks lines in a text editor
key key: Enter, Back, Execute, Save, Cancel, Exit, F1-F24, Shift+F3, or SAP's number
press id (click too); btn[N] is function key N
okcode value: "/nVA03" starts a transaction, "/oVA03" in a new session; it submits on its own (no Enter after it); the command field cannot be typed into
select id (tab, radio, menu entry, list item); with row: a table row (value false: deselect)
check id, value true|false
combo id, key (entry key or text; without: lists them)
f4, focus, dblclick id
grid id, row, col, how double|select|cell
tree id, node, how double|select|expand|collapse
toolbar id, button
scroll id, to: a row from 0, next, prev, first, last, left, right
open app "#SalesOrder-manage" (Fiori launchpad)
timeout: seconds per step (default 180).
actions: [...] up to ${MAX_BATCH} in one call, a screen's fields then its key: [{"do":"set","id":"ctxtVBAK-AUART","value":"OR"},{"do":"key","key":0}]. Stops at the first surprise (failure, refusal, a write awaiting yes, popup, E/W/A status, another screen unless the next action's id is on it and it does not write; okcode "/n<tcode>" and open go on into it). Per step: expect {"screen":"4001"}|{"screen":"*"} (any)|{"popup":true}|{"status":"W"} goes on through it; show:true adds the screen after it; unseen:true lets a write run on a screen first reached in the batch.
Do not repeat a failed action unchanged.
${writeRule(policy)}`,
      // Loose: "action":{...}, the older shape of one action, still works (clients and recordings that send it), and so do "timing" and other keys an action passes on.
      inputSchema: z
        .object({
          ...actionFields,
          do: actionFields.do.optional(),
          actions: z.array(stepSchema).optional(),
          session,
          full: z.boolean().optional().describe("answer with the whole screen, not the changes"),
        })
        .passthrough(),
      ...(structured ? { outputSchema: actOutput } : {}),
      // A closed SAP system, not the open web: openWorldHint is false on every tool.
      annotations: { readOnlyHint: false, destructiveHint: mayDestroy(policy), openWorldHint: false },
      // Claude Code loads MCP tools on demand; the two every task needs are there from the start.
      _meta: ALWAYS_LOAD,
    },
    (input, extra) =>
      answer(async () => {
        const { actions, action, session: raw, full } = input as { actions?: unknown; action?: unknown; session?: string; full?: boolean };
        return act(raw, input, actions, action, full, extra);
      }).then(confirmNotice),
  );

  /** sap_act, once the session reference is settled. */
  async function act(ref: string | undefined, input: Record<string, unknown>, actions: unknown, action: unknown, full: boolean | undefined, call?: CallContext): Promise<CallToolResult> {
    // The action's fields at the top level, as the schema lists them; anything but the call's own keys goes with them.
    let flat = Object.fromEntries(Object.entries(input).filter(([k, v]) => !CALL_KEYS.has(k) && v !== undefined));
    if (actions !== undefined && action === undefined) {
      // Beside "actions", keys that say nothing of an action of their own are taken as meant (live, Haiku, 2026-11-25,
      // a fifth of batches on both surfaces): "expect" goes to the last action, "do":"look" is the screen the answer shows
      // anyway, "app" names nothing. Any other action field is still refused.
      const { expect: e, app: _app, do: d, ...rest } = flat;
      if (d === undefined || isLook({ do: d })) {
        flat = rest;
        const last = Array.isArray(actions) ? actions.at(-1) : undefined;
        if (e !== undefined && last && typeof last === "object" && !Array.isArray(last) && (last as Record<string, unknown>).expect === undefined)
          actions = [...(actions as unknown[]).slice(0, -1), { ...(last as Record<string, unknown>), expect: e }];
      }
    }
    const one = Object.keys(flat).length > 0;
    if (actions !== undefined && one && !("do" in flat)) return fail(`${Object.keys(flat).map((k) => `"${k}"`).join(", ")} next to "actions" belongs inside an action of "actions" (each step has its own, e.g. [{"do":"key","key":0,"expect":{"popup":true}}]). Nothing ran.`);
    if (actions !== undefined && (one || action !== undefined)) return fail('Send one action ("do" and its fields) or "actions", not both.');
    if (one && action !== undefined) return fail('Send the action\'s fields ("do", "id", ...) at the top level, not also inside "action".');
    if (actions !== undefined) return withAnyData(await runBatch(ref, actions, full === true, call), actions);
    // {"do":"look"}: not an action; the screen.
    if (isLook(one ? flat : action)) return withAnyData(await current(ref, "look is not an action: this is the screen."));
    // Nothing at all (sent beside another sap_act in the same turn, live 2026-11-25): the screen, as for "actions": [].
    if (!one && action === undefined) return withAnyData(await current(ref, "No action sent: this is the screen."));
    return withAnyData(await run(ref, one ? flat : action, full === true));
  }

  server.registerTool(
    "sap_screenshot",
    {
      title: "Screenshot of the SAP session",
      description: "A PNG of the session's window or tab, only for what sap_look cannot give as text (charts, areas the view marks opaque) or when the user asks for a picture: it costs several text views. Never to find ids.",
      inputSchema: { session },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    ({ session: raw }) =>
      answer(() =>
        // In the session's turn, as every other tool: never mid-action, never beside another call on the driver.
        serial(raw, "screenshot", async (at) => {
          const png = await (await registry.driver(at)).screenshot();
          return { content: [{ type: "image", data: png.toString("base64"), mimeType: "image/png" }] };
        }),
      ),
  );

  registerRecordTools(server, registry, policy, recorder, serial, (id) => history.get(id) ?? [], structured);
  registerCodeTools(server, registry, policy, recorder, serial);
  withoutSdkDefaults(server);

  return { server, registry, recorder };
}

type ListTools = (request: unknown, extra: unknown) => Promise<{ tools: { inputSchema: Record<string, unknown>; outputSchema?: Record<string, unknown>; execution?: { taskSupport?: string } }[] }>;
/** What the SDK hands a tool beside its arguments, as far as sap_act uses it: cancellation and progress. */
interface CallContext {
  signal: AbortSignal;
  _meta?: { progressToken?: string | number | undefined } | undefined;
  sendNotification: (n: { method: "notifications/progress"; params: { progressToken: string | number; progress: number; total: number; message: string } }) => Promise<void>;
}

type CallTool = (
  request: { params: { name: string; arguments?: Record<string, unknown> } },
  extra: unknown,
) => Promise<{ isError?: boolean; content?: { type: string; text?: string }[] }>;

/**
 * tools/list without what the SDK adds to every tool and no client needs (and
 * tools/call with plain words for arguments that do not fit): the
 * "$schema" keyword of its JSON Schema conversion, and
 * "execution":{"taskSupport":"forbidden"}, which is the spec's default. Some
 * 25 tokens per tool in every conversation. The SDK has no option for either,
 * so the handler it installed is wrapped (test/surface.test.ts checks it).
 */
function withoutSdkDefaults(server: McpServer): void {
  const handlers = (server.server as unknown as { _requestHandlers?: Map<string, ListTools> })._requestHandlers;
  const inner = handlers?.get("tools/list");
  if (!handlers || !inner) return;
  handlers.set("tools/list", async (request, extra) => {
    const out = await inner(request, extra);
    for (const t of out.tools) {
      delete t.inputSchema.$schema;
      // A tool without parameters says so, as the spec recommends.
      if (t.inputSchema.type === "object" && !Object.keys((t.inputSchema.properties as object | undefined) ?? {}).length) t.inputSchema.additionalProperties = false;
      if (t.outputSchema) delete t.outputSchema.$schema;
      if (t.execution && Object.keys(t.execution).length === 1 && t.execution.taskSupport === "forbidden") delete t.execution;
    }
    return out;
  });
  const call = (handlers as unknown as Map<string, CallTool>).get("tools/call");
  if (call)
    (handlers as unknown as Map<string, CallTool>).set("tools/call", async (request, extra) => {
      const p = request.params;
      // sap_record takes "op"; agents send sap_act's "do" to it as well.
      if (p.name === "sap_record" && p.arguments && p.arguments.op === undefined && typeof p.arguments.do === "string") {
        const { do: op, ...rest } = p.arguments;
        p.arguments = { ...rest, op };
      }
      const out = await call(request, extra);
      const first = out.content?.[0];
      if (out.isError && first?.type === "text" && first.text) first.text = plainValidationError(p.name, first.text);
      return out;
    });
}

/**
 * The SDK's answer to arguments that do not fit a tool's schema ("MCP error -32602: Input validation error:
 * Invalid arguments for tool sap_look: Invalid input: expected boolean, received string at full"), said as the
 * other errors are: the field, what is wrong, and where the tool's fields are described.
 */
export function plainValidationError(tool: string, message: string): string {
  const m = /^MCP error -32602: Input validation error: Invalid arguments for tool [\w-]+: ([\s\S]*)$/.exec(message);
  if (!m) return message;
  const parts = (m[1] ?? "").split(/;\s*|\n/).map((x) => x.trim()).filter(Boolean);
  const said = parts.map((x) => {
    const at = / at ([\w.[\]"-]+)$/.exec(x);
    const what = (at ? x.slice(0, at.index) : x).replace(/^Invalid (input|option): /, "");
    return at ? `"${at[1]}": ${what}` : what;
  });
  const help = tool === "sap_record" ? ' {"op":"help"} lists every op with its fields.' : " The tool's description lists its fields.";
  return `${tool} was called with arguments that do not fit: ${said.join("; ")}.${help}`;
}
