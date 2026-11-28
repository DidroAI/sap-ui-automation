#!/usr/bin/env node
// The Chrome Web Store screenshots (1280×800) and the small promo tile (440×280) of the
// extension, written to store-assets/. The panel is the real panel.html, fed made-up
// systems on sap.example.com through a stand-in for chrome.runtime: never a real SAP
// system, never SAP's logo (extension/STORE.md, "Assets").
//
//   SAP_TEST_CHROME=/path/to/chrome node scripts/extension-screenshots.mjs
import { mkdirSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ext = join(root, "extension");
const out = join(root, "store-assets");
mkdirSync(out, { recursive: true });
const version = JSON.parse(readFileSync(join(ext, "manifest.json"), "utf8")).version;

const sys = (id, name, kind, more = {}) => ({
  id,
  name,
  url: kind === "fiori" ? "https://s4.sap.example.com/sap/bc/ui2/flp" : "https://ecc.sap.example.com/sap/bc/gui/sap/its/webgui",
  client: kind === "fiori" ? "100" : "800",
  language: "EN",
  user: "JDOE",
  passwordIn: "keychain",
  sso: false,
  kind,
  open: false,
  loggingOn: false,
  ...more,
});
const base = {
  status: "connected",
  port: 47823,
  code: { set: true, managed: false, managedInvalid: false },
  helper: { ok: true, keychain: "macOS Keychain" },
  portSetting: { value: null, managed: false },
  paused: false,
  managedOrigins: [],
  shared: [],
  agent: null,
  agentInfo: { agent: "Codex", policy: { write: "confirm", systems: [], transactions: [], blocked: ["SE38", "SM30", "SU01"], logoff: false } },
  activity: [],
  currentTab: null,
  version,
};
// Steps of the agent, `ago` seconds back (the stand-in turns them into times).
const step = (ago, d, label, value, more = {}) => ({ state: "ran", do: d, label, value, transaction: "VA02", title: "Change Sales Order", system: "ECC", client: "800", agent: "Codex", ago, ...more });
const VA02 = [
  step(900, "okcode", "", "/nVA03", { transaction: "VA03", title: "Display Sales Order" }),
  step(880, "set", "Order", "4710", { transaction: "VA03", title: "Display Sales Order" }),
  step(870, "key", "", "0", { transaction: "VA03", title: "Display Sales Order" }),
  step(40, "okcode", "", "/nVA02", { transaction: "", title: "SAP Easy Access" }),
  step(30, "set", "Order", "4711"),
  step(24, "key", "", "0"),
  step(12, "set", "Req. delivery date", "12.12.2026"),
];
const ecc = (more = {}) => sys("ecc", "ECC Sales", "webgui", more);
const SCENES = [
  {
    file: "0-first",
    title: "Add your SAP system",
    text: "Open it in a tab: the panel fills in its address. Add your user and password, and the agent can log on.",
    state: { ...base, status: "ready", agentInfo: null, systems: [], currentTab: { tabId: 3, title: "SAP", shared: false, system: null, suggestion: { sapLike: true, kind: "webgui", name: "ECC 800", url: "http://localhost:8010/sap/bc/gui/sap/its/webgui", client: "800", language: "EN" } } },
  },
  {
    file: "1-working",
    title: "See what your agent does in SAP",
    text: "A column beside your SAP tabs: each step, in SAP's own words, as the agent takes it.",
    state: { ...base, systems: [ecc({ open: true }), sys("s4", "S/4HANA Sandbox", "fiori"), sys("qas", "QAS Finance", "webgui", { passwordIn: null, client: "200" })], agent: { tabId: 7, title: "Change Sales Order", system: "ECC Sales" }, activity: VA02 },
  },
  {
    file: "2-asking",
    title: "Saves wait for your yes",
    text: "Before the agent saves, your agent app asks you. The panel shows what waits.",
    state: { ...base, systems: [ecc({ open: true }), sys("s4", "S/4HANA Sandbox", "fiori")], agent: { tabId: 7, title: "Change Sales Order", system: "ECC Sales" }, activity: [...VA02, step(2, "key", "Save", "11", { state: "waiting" })] },
  },
  {
    file: "3-logon",
    title: "The agent never sees your password",
    text: "The extension types it into SAP's logon page itself, from your computer's keychain.",
    state: { ...base, status: "ready", agentInfo: null, systems: [ecc({ logonIssue: { reason: "wrong_password" } }), sys("s4", "S/4HANA Sandbox", "fiori", { loggingOn: true }), sys("qas", "QAS Finance", "webgui", { passwordIn: null, client: "200" })] },
  },
  {
    file: "4-pair",
    title: "Set up in a minute",
    text: "It talks only to your agent on this computer and to the SAP systems you add.",
    state: { ...base, status: "no_code", agentInfo: null, code: { set: false, managed: false, managedInvalid: false }, systems: [] },
  },
  {
    file: "6-edit",
    title: "Edit in place",
    text: "A system's fields open under its row.",
    view: "edit",
    state: { ...base, systems: [ecc(), sys("s4", "S/4HANA Sandbox", "fiori")] },
  },
  {
    file: "5-settings",
    title: "You decide what the agent may do",
    text: "Saves, systems and blocked transactions are set in your agent; the panel shows them.",
    view: "settings",
    state: { ...base, systems: [ecc()], agent: null },
  },
  // Design checks, not store screenshots: drawn only with EXTRA=1.
  { extra: true, file: "x-menu", title: "The menu of a system", text: "", view: "menu", state: { ...base, systems: [ecc({ open: true }), sys("s4", "S/4HANA Sandbox", "fiori")], agent: { tabId: 7, title: "Change Sales Order", system: "ECC Sales" }, activity: VA02 } },
  { extra: true, file: "x-remove", title: "Removing asks first", text: "", view: "remove", state: { ...base, status: "ready", agentInfo: null, systems: [ecc(), sys("s4", "S/4HANA Sandbox", "fiori")] } },
  {
    extra: true,
    file: "x-ready",
    title: "No agent yet",
    text: "",
    view: "help",
    state: { ...base, status: "ready", agentInfo: null, systems: [ecc()], currentTab: { tabId: 3, title: "SAP", shared: false, system: null, suggestion: { sapLike: true, kind: "fiori", name: "S/4HANA 100", url: "https://s4.sap.example.com/sap/bc/ui2/flp", client: "100", language: "EN" } } },
  },
  { extra: true, file: "x-paused", title: "Sharing stopped", text: "", view: "step", state: { ...base, paused: true, systems: [ecc({ open: true })], activity: [...VA02, step(5, "key", "Save", "11", { state: "refused" })] } },
];

// The stand-in for the extension APIs the panel calls; the scene's state comes from the page address.
const STUB = `(() => {
  const scene = new URLSearchParams(location.search).get("s");
  if (!scene) return;
  const state = JSON.parse(decodeURIComponent(scene));
  for (const e of state.activity || []) e.at = Date.now() - e.ago * 1000;
  const ok = (v) => Promise.resolve(v);
  // The panel's notice about "controlled by automated test software" is for the screenshot browser, not for users.
  Object.defineProperty(navigator, "webdriver", { get: () => false });
  const ev = { addListener() {} };
  window.chrome = {
    runtime: { sendMessage: (m) => ok(m && m.cmd === "state" ? state : { ok: true }), getManifest: () => ({ version: state.version }), id: "store" },
    storage: { local: { get: () => ok({ "notice-seen": true }), set: () => ok() }, onChanged: ev },
    tabs: { query: () => ok([]), create: () => ok({}), onActivated: ev, onUpdated: ev },
    permissions: { contains: () => ok(true), request: () => ok(true) },
  };
})();`;

const TYPES = { ".woff2": "font/woff2", ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".svg": "image/svg+xml", ".json": "application/json" };
const server = createServer((req, res) => {
  const path = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (path === "/frame.html") {
    const q = new URL(req.url, "http://x").searchParams;
    res.setHeader("content-type", "text/html");
    res.end(frame(q.get("title"), q.get("text"), q.get("s")));
    return;
  }
  try {
    const body = readFileSync(join(ext, path.replace(/^\/+/, "")));
    res.setHeader("content-type", TYPES[extname(path)] ?? "application/octet-stream");
    res.end(body);
  } catch {
    res.statusCode = 404;
    res.end();
  }
});

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
function frame(title, text, scene) {
  // A browser window: the SAP page on the left (a plain stand-in, never SAP's look or logo), the side panel on the right.
  return `<!doctype html><meta charset="utf-8"><style>
  @font-face { font-family: "DM Sans"; src: url("/fonts/DMSans-Variable.woff2") format("woff2"); font-weight: 100 1000; }
  body { margin: 0; width: 1280px; height: 800px; display: grid; grid-template-columns: 1fr 380px; background: #f6f3ec; font-family: "DM Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; color: #1d1b17; -webkit-font-smoothing: antialiased; }
  .page { display: flex; flex-direction: column; justify-content: center; padding: 0 88px; border-right: 1px solid #e6e0d3; background: #fdfbf6; }
  h1 { font-size: 46px; line-height: 1.08; margin: 0 0 20px; letter-spacing: -0.035em; font-weight: 600; }
  p { font-size: 21px; line-height: 1.45; margin: 0; color: #857f72; max-width: 30ch; letter-spacing: -0.01em; }
  iframe { width: 380px; height: 800px; border: 0; display: block; }
  </style><div class="page"><h1>${esc(title)}</h1><p>${esc(text)}</p></div><iframe src="/panel.html?s=${encodeURIComponent(scene)}"></iframe>`;
}

await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
const browser = await chromium.launch(process.env.SAP_TEST_CHROME ? { executablePath: process.env.SAP_TEST_CHROME } : {});
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: Number(process.env.SCALE) || 1, colorScheme: process.env.DARK ? "dark" : "light" });
  await page.addInitScript(STUB);
  for (const s of SCENES.filter((x) => !x.extra || process.env.EXTRA)) {
    const q = new URLSearchParams({ title: s.title, text: s.text, s: encodeURIComponent(JSON.stringify(s.state)) });
    await page.goto(`http://127.0.0.1:${port}/frame.html?${q}`);
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(800);
    if (s.view === "settings") await page.frameLocator("iframe").locator("#settings-open").click();
    if (s.view === "edit") {
      await page.frameLocator("iframe").locator(".item .more").first().click();
      await page.frameLocator("iframe").locator(".menu-item", { hasText: "Edit" }).click();
    }
    const panel = page.frameLocator("iframe");
    if (s.view === "menu" || s.view === "remove") await panel.locator(".item .more").first().click();
    if (s.view === "remove") await panel.locator(".menu-item", { hasText: "Remove" }).click();
    if (s.view === "help") await panel.locator("#help summary").click();
    if (s.view === "step") await panel.locator(".act-line").nth(1).click();
    await page.waitForTimeout(300);
    const file = join(out, `${s.file}${process.env.DARK ? "-dark" : ""}.png`);
    await page.screenshot({ path: file });
    console.log(file);
  }
  // The small promo tile: the extension's own icon and the name, on a flat background.
  const tile = await browser.newPage({ viewport: { width: 440, height: 280 } });
  await tile.goto(`http://127.0.0.1:${port}/frame.html?tile=1`);
  await tile.setContent(`<!doctype html><meta charset="utf-8"><style>
    @font-face{font-family:"DM Sans";src:url("http://127.0.0.1:${port}/fonts/DMSans-Variable.woff2") format("woff2");font-weight:100 900}
    body{margin:0;width:440px;height:280px;display:grid;place-items:center;background:#f6f3ec;font-family:"DM Sans",-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;color:#1d1b17;-webkit-font-smoothing:antialiased}
    div{display:flex;align-items:center;gap:18px}img{display:block;width:72px;height:72px}
    h1{font-size:30px;line-height:1.1;margin:0;font-weight:600;letter-spacing:-0.035em}p{margin:4px 0 0;color:#857f72;font-size:18px;letter-spacing:-0.01em}</style>
    <div><img src="http://127.0.0.1:${port}/icons/128.png" alt=""><span><h1>SAP UI MCP</h1><p>by Didro</p></span></div>`);
  await tile.waitForTimeout(300);
  await tile.screenshot({ path: join(out, "promo-440x280.png") });
  console.log(join(out, "promo-440x280.png"));
} finally {
  await browser.close();
  server.close();
}
