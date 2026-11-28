import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AgentContext, actionOf, agentCommand, daemonRunning, screenSummary, writeAnswer } from "../src/cli/agent.js";
import { type Daemon, daemonAddress, type Env, SETTINGS, settingsDiff, settingsOf, startDaemon, underLock } from "../src/cli/daemon.js";
import { ActionError, type Action, type Assessment } from "../src/core/types.js";
import { FakeSurface } from "./fakes.js";

// A synthetic screen (no SAP data), the size of a small real one.
const SCREEN = [
  "TRANSACTION ZT01  PROGRAM ZPROG  SCREEN 100  SYSTEM XYZ (100) host",
  'WINDOW wnd[0]  "Synthetic Order: Overview"',
  "okcd  command-field",
  "tbar[0]/btn[3]  button  Back (F3)",
  "tbar[0]/btn[11]  button  Save (Ctrl+S)",
  'ctxtZHDR-TYPE  field  Order Type = "AB"  (edit)',
  'ctxtZHDR-ORG  field  Sales Org. = "1000"  (edit)',
  'ctxtZHDR-CUST  field  Customer = "4711"  (edit)',
  "chkZHDR-DONE  checkbox  [x] Complete",
  'txtZHDR-NOTE  field  Note = ""  (read-only)',
  'tblZPROGTC_ITEMS  table  rows 3 (visible 3) "All items"  (cell id: <id>[col,row], e.g. txtZITM-POSNR[0,0])',
  "  columns: 0 Item=txtZITM-POSNR, 1 Material=ctxtZITM-MATNR, 2 Qty=txtZITM-QTY, 3 Done=chkZITM-DONE",
  "  row 0: Item=10; Material=WIDGET-1; Qty=5; Done [x]",
  "  row 1: Item=20; Material=WIDGET-2; Qty=1; Done [ ]",
  "  row 2: Item=30; Material=WIDGET-3; Qty=12; Done [ ]",
  "cntlGRID/shell  grid  4 rows; columns: A=Col A | B=Col B | C=Col C",
  "  row 0: a | b | c",
  "  row 1: d | e | f",
  "  row 2: g | h | i",
  "  row 3: j | k | l",
  "sbar  status  S: Ready",
].join("\n");

/** Save (key 11) commits; everything else navigates. */
const assess = (a: Action): Assessment => (a.do === "key" && a.key === 11 ? { risk: "commit", reason: "key 11: Save" } : { risk: "navigate", reason: a.do });

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

function setup(env: Env = {}, idleMs = 60_000) {
  const dir = mkdtempSync(join(tmpdir(), "sapcli-"));
  const surface = new FakeSurface("webgui");
  const daemons: Daemon[] = [];
  const base: Env = { SAP_CLI_STATE_DIR: join(dir, "state"), SAP_RECORD_DIR: join(dir, "tests"), ...env };
  cleanups.push(async () => {
    for (const d of daemons) await d.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const run = async (argv: string[], more: Env = {}) => {
    const out: string[] = [];
    const err: string[] = [];
    const ctx: AgentContext = {
      env: { ...base, ...more },
      cwd: dir,
      out: (l) => out.push(l),
      err: (l) => err.push(l),
      start: async (address, c) => {
        daemons.push(await startDaemon({ address, env: c.env, cwd: c.cwd, surfaces: [surface], idleMs }));
      },
      startTimeoutMs: 2000,
    };
    const code = await agentCommand(argv, ctx);
    return { code, out: out.join("\n"), err: err.join("\n"), lines: out.join("\n").split("\n") };
  };
  const screens = () => (existsSync(join(dir, ".sap-gui", "screens")) ? readdirSync(join(dir, ".sap-gui", "screens")).sort((a, b) => parseInt(a) - parseInt(b)) : []);
  const read = (rel: string) => readFileSync(join(dir, rel), "utf8");
  return { dir, surface, daemons, run, screens, read, base };
}

const pathOf = (out: string) => /(?:screen|full answer|screenshot): (\S+)$/m.exec(out)?.[1] ?? "";

describe("look", () => {
  test("prints the header line and the file that holds the screen", async () => {
    const { surface, run, read } = setup({ SAP_WRITE: "off" });
    surface.add({ id: "chrome:1", system: "XYZ", transaction: "ZT01" }, { view: SCREEN });
    const r = await run(["look"]);
    expect(r.code).toBe(0);
    expect(r.lines).toEqual(["TRANSACTION ZT01  PROGRAM ZPROG  SCREEN 100  SYSTEM XYZ (100) host", "sbar  status  S: Ready", "screen: .sap-gui/screens/1-look.txt"]);
    expect(read(pathOf(r.out))).toBe(SCREEN);
  });
  test("--print prints the whole screen; --id, --rows and --cols reach sap_look", async () => {
    const { surface, run } = setup({ SAP_WRITE: "off" });
    surface.add({ id: "chrome:1", system: "XYZ" }, { view: SCREEN });
    expect((await run(["look", "--print"])).out).toBe(SCREEN);
    await run(["look", "--id", "cntlGRID/shell", "--rows=2-3", "--cols", "A,B"]);
    expect(surface.log.at(-1)).toEqual({ op: "look", options: { compact: true, id: "cntlGRID/shell", rows: { from: 2, to: 3 }, cols: ["A", "B"] } });
  });
  test("a second look of the same screen with --diff says nothing changed", async () => {
    const { surface, run } = setup();
    surface.add({ id: "chrome:1", system: "XYZ" }, { view: SCREEN });
    await run(["look"]);
    const r = await run(["look", "--diff"]);
    expect(r.lines[0]).toStartWith("NO CHANGE on ZT01");
  });
});

describe("act", () => {
  test("prints the whole answer, as sap_act gives it: the note, then the lines that changed; and the file", async () => {
    const { surface, run, read, screens } = setup();
    surface.add({ id: "chrome:1", system: "XYZ", transaction: "ZT01" }, { view: SCREEN, onAct: (a, s) => a.do === "set" && (s.view = SCREEN.replace('Customer = "4711"', `Customer = "${a.value}"`)) });
    await run(["look"]);
    const r = await run(["act", '{"do":"set","id":"ctxtZHDR-CUST","value":"4712"}']);
    expect(r.code).toBe(0);
    expect(r.lines[0]).toBe("did set");
    expect(r.lines[1]).toBe("");
    expect(r.lines[2]).toStartWith("CHANGED 1 of");
    // The changed line itself, not only its count: no look or file read is needed to see it.
    expect(r.lines).toContain('~ ctxtZHDR-CUST  field  Customer = "4712"  (edit)');
    expect(r.lines.at(-1)).toBe("screen: .sap-gui/screens/2-act.txt");
    expect(r.lines.slice(0, -1).join("\n")).toBe(read(pathOf(r.out)));
    expect(screens()).toEqual(["1-look.txt", "2-act.txt"]);
  });
  test("a look right after it, on the same screen, says so and names the act's file", async () => {
    const { surface, run } = setup();
    surface.add({ id: "chrome:1", system: "XYZ", transaction: "ZT01" }, { view: SCREEN });
    await run(["act", "set", "ctxtZHDR-CUST", "4711"]);
    const r = await run(["look"]);
    expect(r.code).toBe(0);
    expect(r.lines).toEqual(["Unchanged since your last sap_act (same screen); the whole view:", "screen: .sap-gui/screens/1-act.txt"]);
    expect((await run(["look"])).lines[0]).toStartWith("TRANSACTION ZT01");
  });
  test("screen lines are cut, notes and reasons never", async () => {
    const { surface, run } = setup();
    const long = "x".repeat(400);
    surface.add({ id: "chrome:1", system: "XYZ" }, { view: `${SCREEN}\nlblLONG  label  ${long}`, failAct: new ActionError(`No control ctxt${long} on this screen.`) });
    await run(["look"]);
    const r = await run(["act", "press", `ctxt${long}`]);
    expect(r.code).toBe(1);
    expect(r.err.split("\n")[0]).toBe(`No control ctxt${long} on this screen.`);
    const ok = setup();
    ok.surface.add({ id: "chrome:1", system: "XYZ" }, { view: `${SCREEN}\nlblLONG  label  ${long}` });
    const a = await ok.run(["act", "set", "ctxtZHDR-CUST", "1"]);
    const shown = a.lines.find((l) => l.startsWith("lblLONG"));
    expect(shown?.length).toBe(240);
    expect(shown).toEndWith("…");
  });
  test("okcode <cmd> and open <intent> are commands too: the act shorthand", async () => {
    const { surface, run } = setup();
    surface.add({ id: "chrome:1", system: "XYZ" }, { view: SCREEN });
    expect((await run(["okcode", "/nZT02"])).code).toBe(0);
    expect(surface.acts()).toEqual([{ do: "okcode", value: "/nZT02" }]);
    // open reaches sap_act, which says where it works (this fake session is a Web GUI tab).
    expect((await run(["open", "#SalesOrder-manage"])).err).toContain("open works in a Fiori launchpad tab only");
    expect((await run(["okcode"])).code).toBe(2);
    expect((await run(["open", "a", "b"])).code).toBe(2);
  });
  test("act '[...]' sends the actions as one batch; the answer starts with the Ran k of n line", async () => {
    const { surface, run } = setup();
    surface.add({ id: "chrome:1", system: "XYZ" }, { view: SCREEN });
    await run(["look"]);
    const r = await run(["act", '[{"do":"set","id":"ctxtZHDR-CUST","value":"4711"},{"do":"key","key":0}]']);
    expect(r.code).toBe(0);
    expect(r.lines[0]).toBe("Ran 2 actions.");
    expect(r.lines.at(-1)).toMatch(/^screen: .*-act\.txt$/);
    expect(surface.acts()).toEqual([
      { do: "set", id: "ctxtZHDR-CUST", value: "4711" },
      { do: "key", key: 0 },
    ]);
    for (const bad of ["[]", "[1]", '[{"do":"key","key":0}', '[{"do":"key","key":0}] extra']) expect((await run(["act", ...bad.split(" ")])).code).toBe(2);
  });
  test("an error in the status bar comes first, as STATUS", async () => {
    const { surface, run } = setup();
    const error = SCREEN.replace("S: Ready", "E: Customer 4799 does not exist").replace("SCREEN 100", "SCREEN 200");
    surface.add({ id: "chrome:1", system: "XYZ" }, { view: SCREEN, onAct: (_a, s) => (s.view = error) });
    await run(["look"]);
    const r = await run(["act", "key", "0"]);
    expect(r.code).toBe(0);
    expect(r.lines.slice(0, 4)).toEqual(["did key", "STATUS E: Customer 4799 does not exist  (error: correct the input it names, then Enter)", "", error.split("\n")[0]!]);
    // A new screen is printed whole, as sap_act answers it.
    expect(r.lines.slice(3, -1).join("\n")).toBe(error);
  });
  test("on the same screen, the changed status bar line is printed", async () => {
    const { surface, run } = setup();
    surface.add({ id: "chrome:1", system: "XYZ" }, { view: SCREEN, onAct: (_a, s) => (s.view = SCREEN.replace("S: Ready", "E: Customer 4799 does not exist")) });
    await run(["look"]);
    const r = await run(["act", "key", "0"]);
    expect(r.lines.slice(0, 4)).toEqual(["did key", "", 'CHANGED 1 of 21 lines on ZT01 · "Synthetic Order: Overview" (same screen; sap_look shows all of it):', "~ sbar  status  E: Customer 4799 does not exist"]);
  });
  test("an action that cannot run prints the message on stderr and exits 1", async () => {
    const { surface, run } = setup();
    surface.add({ id: "chrome:1", system: "XYZ" }, { view: SCREEN, failAct: new ActionError("No control ctxtNOPE on this screen.") });
    const r = await run(["act", "press", "ctxtNOPE"]);
    expect(r.code).toBe(1);
    expect(r.err.split("\n")[0]).toBe("No control ctxtNOPE on this screen.");
    expect(r.out).toBe("");
  });
  test("usage errors exit 2 and change nothing", async () => {
    const { surface, run } = setup();
    surface.add({ id: "chrome:1", system: "XYZ" });
    for (const argv of [["act"], ["act", "{nope"], ["act", "tree", "x"], ["act", "set", "a", "b", "c"], ["look", "--bogus"], ["confirm"]]) {
      expect([argv, (await run(argv)).code]).toEqual([argv, 2]);
    }
    expect(surface.log).toEqual([]);
  });
});

describe("confirm", () => {
  test("the CLI cannot ask the user: under confirm a write is refused (exit 1), and the first look says so", async () => {
    const { surface, run } = setup({ SAP_WRITE: "confirm" });
    surface.add({ id: "chrome:1", system: "XYZ", transaction: "ZT01" }, { view: SCREEN, assess });
    const look = await run(["look"]);
    expect(look.code).toBe(0);
    expect(look.lines[0]).toStartWith("NOTE: writing is set to confirm, and the sap-ui-automation CLI cannot ask the user");
    const r = await run(["act", "key", "11"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("cannot ask the user");
    expect(surface.acts()).toEqual([]);
  });

  test("confirm is the default, and the CLI still refuses a write without SAP_WRITE=on", async () => {
    const { surface, run } = setup({});
    surface.add({ id: "chrome:1", system: "XYZ", transaction: "ZT01" }, { view: SCREEN, assess });
    const r = await run(["act", "key", "11"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("cannot ask the user");
    expect(surface.acts()).toEqual([]);
  });
});

describe("sessions and use", () => {
  test("sessions lists them with the active one marked; use switches", async () => {
    const { surface, run } = setup();
    surface.add({ id: "chrome:1", system: "XYZ", client: "100", transaction: "ZT01", title: "One" });
    surface.add({ id: "chrome:2", system: "ABC", client: "200", transaction: "VA03", title: "Two" }, { view: "TRANSACTION VA03  SCREEN 100  SYSTEM ABC (200)\nsbar  status  S: Hi" });
    const list = await run(["sessions"]);
    expect(list.lines).toHaveLength(2);
    expect(list.lines[0]).toContain("* webgui");
    const use = await run(["use", "2"]);
    expect(use.lines).toEqual(["TRANSACTION VA03  SCREEN 100  SYSTEM ABC (200)", "sbar  status  S: Hi", "screen: .sap-gui/screens/1-use.txt"]);
    expect((await run(["sessions"])).lines[1]).toContain("* webgui");
  });
  test("sessions goes through the daemon only when one runs", async () => {
    const { run, base, dir } = setup();
    expect(await daemonRunning({ env: base, cwd: dir })).toBe(false);
    await run(["daemon", "status"]);
    expect(await daemonRunning({ env: base, cwd: dir })).toBe(false);
    await run(["sessions"]);
    expect(await daemonRunning({ env: base, cwd: dir })).toBe(true);
  });
});

describe("the daemon's settings", () => {
  test("a call whose SAP_* settings differ from the daemon's is refused before anything runs", async () => {
    const { surface, run } = setup();
    surface.add({ id: "chrome:1", system: "XYZ" }, { view: SCREEN, assess });
    expect((await run(["look"])).code).toBe(0);
    // Looser than the daemon: refused.
    const looser = await run(["act", "key", "11"], { SAP_WRITE: "on" });
    expect(looser.code).toBe(1);
    expect(looser.err).toContain('SAP_WRITE: daemon unset, this call "on"');
    expect(looser.err).toContain("sap-ui-automation daemon stop");
    // Stricter, or only different: refused too.
    expect((await run(["look"], { SAP_ALLOW_TCODES: "VA03" })).code).toBe(1);
    expect(surface.acts()).toEqual([]);
    // The CLI's own variables are not settings.
    expect((await run(["look"], { SAP_CLI_DIR: "elsewhere" })).code).toBe(0);
  });
  test("after daemon stop, the next call starts a daemon with its own settings", async () => {
    const { surface, run, daemons } = setup();
    surface.add({ id: "chrome:1", system: "XYZ" }, { view: SCREEN, assess });
    await run(["look"]);
    expect((await run(["daemon", "status"])).lines[1]).toBe("settings: SAP_RECORD_DIR=" + daemons[0]!.status().settings.SAP_RECORD_DIR);
    expect((await run(["daemon", "stop"])).out).toBe("sap-ui-automation daemon stopped.");
    await daemons[0]!.closed;
    expect((await run(["daemon", "status"])).out).toBe("No sap-ui-automation daemon runs for this directory.");
    const r = await run(["act", "key", "11"], { SAP_WRITE: "on" });
    expect(r.code).toBe(0);
    expect(daemons).toHaveLength(2);
    expect(daemons[1]!.status().settings.SAP_WRITE).toBe("on");
    expect(surface.acts()).toEqual([{ do: "key", key: 11 }]);
  });
  test("settingsOf keeps the server's SAP_* settings (upper-cased), not SAP_CLI_* or others; settingsDiff names each difference", () => {
    expect(settingsOf({ SAP_WRITE: "on", sap_view: "full", SAP_CLI_DIR: "x", PATH: "/bin", SAP_PASSWORD: "pw", SAP_USER: "me", SAP_VAR_X: "1" })).toEqual({ SAP_VIEW: "full", SAP_WRITE: "on" });
    expect(settingsDiff({ SAP_WRITE: "confirm" }, { SAP_WRITE: "on", SAP_VIEW: "full" })).toEqual(['SAP_VIEW: daemon unset, this call "full"', 'SAP_WRITE: daemon "confirm", this call "on"']);
    expect(settingsDiff({ SAP_EXTENSION_CODE: "AAAA-BBBB" }, { SAP_EXTENSION_CODE: "CCCC-DDDD" })).toEqual(["SAP_EXTENSION_CODE: daemon set (hidden), this call set (hidden)"]);
    expect(settingsDiff({}, { SAP_EXTENSION_CODE: "CCCC-DDDD" })).toEqual(["SAP_EXTENSION_CODE: daemon unset, this call set (hidden)"]);
  });
  test("the settings list holds every SAP_* variable the server reads", () => {
    const seen = new Set<string>();
    const walk = (d: string) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (p.endsWith(".ts")) for (const m of readFileSync(p, "utf8").matchAll(/\b(?:env|process\.env)\??\.(SAP_[A-Z0-9_]+)/g)) seen.add(m[1]!);
      }
    };
    walk(join(import.meta.dir, "..", "src"));
    // The CLI's own, the exported scripts' and the test runner's are not the server's settings.
    const notSettings = /^SAP_(CLI_|VAR_|USER$|PASSWORD$|TEST_STRIP_TYPES$)/;
    const missing = [...seen].filter((n) => !notSettings.test(n) && !(SETTINGS as readonly string[]).includes(n));
    expect(missing).toEqual([]);
  });
  test("daemon status and the settings error never print a secret", async () => {
    const { surface, run } = setup({ SAP_EXTENSION_CODE: "SECRET-CODE1" });
    surface.add({ id: "chrome:1", system: "XYZ" });
    expect((await run(["look"])).code).toBe(0);
    const status = await run(["daemon", "status"]);
    expect(status.out).toContain("SAP_EXTENSION_CODE=(hidden)");
    expect(status.out).not.toContain("SECRET-CODE1");
    const other = await run(["look"], { SAP_EXTENSION_CODE: "OTHER-CODE2" });
    expect(other.code).toBe(1);
    expect(other.err).toContain("SAP_EXTENSION_CODE");
    expect(other.err).not.toContain("SECRET-CODE1");
    expect(other.err).not.toContain("OTHER-CODE2");
  });
  test("one daemon per directory, or per SAP_CLI_SESSION", () => {
    const s = { SAP_CLI_STATE_DIR: join(tmpdir(), "sapcli-addr") };
    cleanups.push(() => rmSync(s.SAP_CLI_STATE_DIR, { recursive: true, force: true }));
    expect(daemonAddress(s, "/a").key).not.toBe(daemonAddress(s, "/b").key);
    expect(daemonAddress({ ...s, SAP_CLI_SESSION: "x" }, "/a").key).toBe(daemonAddress({ ...s, SAP_CLI_SESSION: "x" }, "/b").key);
    expect(daemonAddress(s, "C:\\Work", "win32").path).toMatch(/^\\\\\.\\pipe\\sap-gui-.+-[0-9a-f]{16}$/);
  });
});

describe("the daemon's life", () => {
  test("it exits after the idle time without a call", async () => {
    const { surface, run, daemons } = setup({}, 150);
    surface.add({ id: "chrome:1", system: "XYZ" });
    await run(["look"]);
    let closed = false;
    void daemons[0]!.closed.then(() => (closed = true));
    await new Promise((r) => setTimeout(r, 60));
    await run(["look"]);
    await new Promise((r) => setTimeout(r, 100));
    // The second call put the idle time back to its start.
    expect(closed).toBe(false);
    await daemons[0]!.closed;
    expect((await run(["daemon", "status"])).out).toBe("No sap-ui-automation daemon runs for this directory.");
  });
  test("a line that is not JSON does not stop the idle exit", async () => {
    const { surface, run, daemons, base, dir } = setup({}, 150);
    surface.add({ id: "chrome:1", system: "XYZ" });
    await run(["look"]);
    const answer = await new Promise<string>((r) => {
      const s = connect(daemonAddress(base, dir).path);
      let buf = "";
      s.setEncoding("utf8");
      s.on("data", (c: string) => (buf += c));
      s.on("close", () => r(buf));
      s.on("connect", () => s.write("not json\n"));
    });
    expect(JSON.parse(answer)).toMatchObject({ ok: false, code: "bad-request" });
    const closed = await Promise.race([daemons[0]!.closed.then(() => true), new Promise((r) => setTimeout(() => r(false), 2000))]);
    expect(closed).toBe(true);
  });
  test("two daemons starting together: the lock lets one in at a time", async () => {
    const dir = mkdtempSync(join(tmpdir(), "saplock-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const lock = join(dir, "x.lock");
    const order: string[] = [];
    const step = (n: string) => underLock(lock, async () => {
      order.push(`${n} in`);
      await new Promise((r) => setTimeout(r, 40));
      order.push(`${n} out`);
    });
    await Promise.all([step("a"), step("b")]);
    expect(order).toEqual(["a in", "a out", "b in", "b out"]);
    expect(existsSync(lock)).toBe(false);
    // A lock left by a process that is gone is taken over.
    writeFileSync(lock, "999999999");
    expect(await underLock(lock, async () => "ran")).toBe("ran");
  });
  test("calls made at the same time run one after the other, even on different sessions", async () => {
    const { surface, run, daemons } = setup();
    surface.add({ id: "chrome:1", system: "XYZ" }, { actMs: 80 });
    surface.add({ id: "chrome:2", system: "ABC" }, { actMs: 80 });
    await run(["sessions"]);
    const [a, b] = await Promise.all([run(["act", "key", "0", "--session", "1"]), run(["act", "key", "0", "--session", "2"])]);
    expect([a.code, b.code]).toEqual([0, 0]);
    expect(surface.log.filter((l) => l.op === "act" || l.op === "act-end").map((l) => l.op)).toEqual(["act", "act-end", "act", "act-end"]);
    expect(daemons).toHaveLength(1);
  });
  test("a call with a wrong token is refused", async () => {
    const { surface, run, base, dir } = setup();
    surface.add({ id: "chrome:1", system: "XYZ" });
    await run(["look"]);
    const { send } = await import("../src/cli/daemon.js");
    const r = await send(daemonAddress(base, dir).path, { token: "nope", op: "call", settings: settingsOf(base), tool: "sap_look", args: {} });
    expect(r).toEqual({ ok: false, code: "token", error: "Wrong daemon token." });
  });
});

describe("screenshot and record", () => {
  test("screenshot writes a PNG and prints its path", async () => {
    const { surface, run, read } = setup();
    surface.add({ id: "chrome:1", system: "XYZ" });
    const r = await run(["screenshot"]);
    expect(r.out).toBe("screenshot: .sap-gui/screens/1-screenshot.png");
    expect(read(pathOf(r.out))).toBe("png");
  });
  test("record start <name> ... stop goes to sap_record", async () => {
    const { surface, run } = setup();
    surface.add({ id: "chrome:1", system: "XYZ", transaction: "ZT01" }, { view: SCREEN });
    const start = await run(["record", "start", "my test"]);
    expect(start.code).toBe(0);
    expect((await run(["record", "status"])).out).toContain("my test");
    expect((await run(["record", "assert", '{"check":"text","contains":"Order"}'])).code).toBe(0);
    const bad = await run(["record", "assert", "status"]);
    expect(bad.code).toBe(2);
  });
});

describe("helpers", () => {
  test("actionOf: JSON, or a shorthand with typed arguments", () => {
    expect(actionOf(['{"do":"key","key":0}'])).toEqual({ do: "key", key: 0 });
    expect(actionOf(["okcode", "/nVA03"])).toEqual({ do: "okcode", value: "/nVA03" });
    expect(actionOf(["check", "chkA", "false"])).toEqual({ do: "check", id: "chkA", value: false });
    expect(actionOf(["scroll", "tblA", "120"])).toEqual({ do: "scroll", id: "tblA", to: 120 });
    expect(actionOf(["scroll", "tblA", "next"])).toEqual({ do: "scroll", id: "tblA", to: "next" });
    // A value typed into a field stays text.
    expect(actionOf(["set", "ctxtA", "0010"])).toEqual({ do: "set", id: "ctxtA", value: "0010" });
  });
  test("screenSummary keeps the notes, the screen's first line, a code line and the status bar", () => {
    const answer = `did set\ncode: await sap.set("ctxtA", "1")\n\n${SCREEN}`;
    expect(screenSummary(answer)).toEqual(["did set", 'code: await sap.set("ctxtA", "1")', SCREEN.split("\n")[0]!, "sbar  status  S: Ready"]);
  });
  test("writeAnswer numbers files past the highest one and keeps the last 200", () => {
    const dir = mkdtempSync(join(tmpdir(), "sapcli-w-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    for (let i = 0; i < 205; i++) writeAnswer(dir, "look", "txt", String(i));
    const files = readdirSync(dir);
    expect(files.length).toBeLessThanOrEqual(201);
    expect(files).toContain("205-look.txt");
    expect(files).not.toContain("1-look.txt");
  });
});
