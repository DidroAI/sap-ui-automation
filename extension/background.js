// SAP UI MCP (sap-ui-automation's Chrome extension): MV3 service worker.
//
// Keeps the user's SAP systems (name, address, client, language, user) and
// their saved passwords, and logs on to them by filling SAP's logon page
// itself, like a password manager. Registered systems are the sites it shares.
//
// Connects to the sap-ui-automation relay on 127.0.0.1 (see PROTOCOL.md),
// proves both sides hold the pairing code, then runs the relay's requests with
// chrome.debugger on shared tabs only. Every frame after the handshake is
// encrypted and authenticated with keys derived from the code. Nothing here
// loads or evaluates remote code: the relay can only ask for the request
// types below. A password never goes to the relay: while the extension logs on
// in a tab, that tab is withdrawn from the server, and it comes back only once
// SAP's logon page is gone or its password field is empty.

import { normalizeCode, CODE_LENGTH } from "./code.js";
import {
  BODY_READS,
  createNetworkLog,
  isAllowedChildUrl as childAllowed,
  isAllowedResourceUrl as resourceAllowed,
  isAllowedUrl as urlAllowed,
  isBareWildcard,
  methodDenied,
  siteUrls,
  webPattern,
} from "./policy.js";

const NATIVE_HOST = "ai.didro.sap_ui_automation";
const PORT_FIRST = 47823;
const PORT_LAST = 47830;
const EXT_VERSION = chrome.runtime.getManifest().version;

const OPEN_TIMEOUT_MS = 3000; // TCP + WebSocket upgrade
const HELLO_TIMEOUT_MS = 4000; // relay speaks first
const WELCOME_TIMEOUT_MS = 6000;
const PING_MS = 20000;
const SILENCE_LIMIT_MS = 65000; // three pings without any frame back: drop
// Looking for a server is cheap (refused connects to 127.0.0.1): every 3 s while the worker is awake, so a server
// that just started is found within seconds. A refusal (wrong code, busy) waits up to 30 s between tries.
const MAX_BACKOFF_MS = 3000;
const MAX_REFUSED_BACKOFF_MS = 30000;
const ALARM = "bridge-wake";
const TARGETS_CACHE_MS = 150; // how stale the tab URL checked before each cdp command may be

// ---------------------------------------------------------------- state

let ws = null; // the authenticated relay socket, or null
let chan = null; // its encrypted channel
let wsPort = null;
let connecting = null; // promise of a scan in progress
let failures = 0;
let retryTimer = null;
let nextScanAt = 0;
let pingTimer = null;
let lastHeard = 0;
let status = { state: "starting", port: null };

const attached = new Set(); // tabIds this extension attached
const attachedTargets = new Map(); // tabId -> CDP target id (= main frame id)
const attaching = new Map(); // tabId -> pending attach promise
let known = new Map(); // tabId -> Tab: allowed tabs the relay has been told about
let allowedCache = new Map(); // tabId -> Tab, refreshed by computeAllowed()
let scope = { patterns: [], granted: [], managed: [], wildcard: false, paused: false }; // last scope read
const recentlyClosed = new Set();
// Tabs the extension is logging on in: never shared until the logon page is gone.
const privateTabs = new Set();
// The shared tab the server sent its last command to, for the popup.
let agentTab = null; // { tabId, at }

// Per attached tab:
const children = new Map(); // tabId -> Map<childSessionId, {targetId, type, url, parent?, clientPage}>
const rootClientPage = new Set(); // tabIds whose root session the client enabled Page on
// Network requests per tab, and the ExtraInfo events held until their request is known (policy.js).
const network = createNetworkLog((u) => isAllowedResourceUrl(u));
const requests = network.requests;
const pendingExtra = network.pendingExtra;
const frameNav = new Map(); // tabId -> Map<frameId, url the frame last started navigating to or committed>
const MAX_FRAMES_PER_TAB = 1000;

// ---------------------------------------------------------------- helpers

function b64(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

async function hmacB64(code, message) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(code), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64(new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(message))));
}

function constantTimeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const n = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < n; i++) diff |= (a.charCodeAt(i) | 0) ^ (b.charCodeAt(i) | 0);
  return diff === 0;
}

function setStatus(state, port = null) {
  status = { state, port, at: Date.now() };
  chrome.storage.session.set({ status }).catch(() => {});
}

function send(msg) {
  if (!ws || !chan || ws.readyState !== WebSocket.OPEN) return false;
  return chan.send(msg);
}

function rpcError(message, code = -32000) {
  const e = new Error(message);
  e.code = code;
  return e;
}

async function getManaged() {
  try {
    return (await chrome.storage.managed.get(null)) || {};
  } catch {
    return {};
  }
}

// A pairing code counts only with exactly CODE_LENGTH characters after
// normalizing: a short code could be brute-forced from the MACs a fake relay
// collects (PROTOCOL.md, Pairing).
function validCode(raw) {
  const n = normalizeCode(raw);
  return n.length === CODE_LENGTH ? n : null;
}

async function getConfig() {
  const [local, managed] = await Promise.all([chrome.storage.local.get(null), getManaged()]);
  const managedSet = typeof managed.pairingCode === "string" && managed.pairingCode.trim() !== "";
  const managedCode = validCode(managed.pairingCode);
  const managedPort = Number.isInteger(managed.port) ? managed.port : null;
  const localPort = Number.isInteger(local.port) ? local.port : null;
  return {
    // An invalid managed code does not fall back to the user's: the policy means to replace it.
    code: managedSet ? managedCode : validCode(local.pairingCode),
    codeManaged: managedSet,
    codeManagedInvalid: managedSet && !managedCode,
    port: managedPort ?? localPort,
    portManaged: managedPort !== null,
    lastPort: local.lastPort,
    paused: !!local.paused,
    sites: [...(Array.isArray(local.sites) ? local.sites.filter((x) => typeof x === "string") : []), ...validSystems(local.systems).map((x) => systemPattern(x.url)).filter(Boolean)],
    systems: validSystems(local.systems),
    managedOrigins: Array.isArray(managed.allowedOrigins) ? managed.allowedOrigins.filter((x) => typeof x === "string") : [],
  };
}

// ---------------------------------------------------------------- encrypted channel (PROTOCOL.md)

async function deriveKeys(code, nS, nE) {
  const enc = new TextEncoder();
  const hk = await crypto.subtle.importKey("raw", enc.encode(code), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const raw = async (label) => new Uint8Array(await crypto.subtle.sign("HMAC", hk, enc.encode(`${label}|${nS}|${nE}`)));
  const [s2e, e2s] = await Promise.all([raw("sap-gui-key-s2e"), raw("sap-gui-key-e2s")]);
  const [recv, sendKey] = await Promise.all([
    crypto.subtle.importKey("raw", s2e, { name: "AES-GCM" }, false, ["decrypt"]),
    crypto.subtle.importKey("raw", e2s, { name: "AES-GCM" }, false, ["encrypt"]),
  ]);
  return { recv, send: sendKey };
}

// IV = 4 zero bytes + 8-byte big-endian counter.
function ivFor(n) {
  const iv = new Uint8Array(12);
  new DataView(iv.buffer).setBigUint64(4, BigInt(n));
  return iv;
}

// Frames are decrypted strictly in arrival order and sent strictly in call
// order, each direction with its own counter. A text frame or a frame that
// fails to decrypt closes the socket (4003) and nothing after it is obeyed.
function makeChannel(sock, keysP) {
  let recvCount = 0;
  let sendCount = 0;
  let recvChain = Promise.resolve();
  let sendChain = Promise.resolve();
  let dead = false;
  let onPlain = null;
  let onFail = null;
  const buffered = [];
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const fail = (why) => {
    if (dead) return;
    dead = true;
    try {
      sock.close(4003, why);
    } catch {}
    if (onFail) onFail(why);
  };
  const deliver = (text) => {
    if (onPlain) onPlain(text);
    else buffered.push(text);
  };
  return {
    get dead() {
      return dead;
    },
    attach(plainHandler, failHandler) {
      onPlain = plainHandler;
      onFail = failHandler;
      if (dead) failHandler("closed");
      for (const t of buffered.splice(0)) plainHandler(t);
    },
    recv(data) {
      if (dead) return;
      if (typeof data === "string" || !(data instanceof ArrayBuffer)) {
        fail("text frame after welcome");
        return;
      }
      const n = recvCount++;
      recvChain = recvChain.then(async () => {
        if (dead) return;
        let text;
        try {
          const keys = await keysP;
          text = dec.decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: ivFor(n) }, keys.recv, data));
        } catch {
          fail("decrypt");
          return;
        }
        if (!dead) deliver(text);
      });
    },
    send(msg) {
      if (dead) return false;
      const n = sendCount++;
      const bytes = enc.encode(JSON.stringify(msg));
      sendChain = sendChain
        .then(async () => {
          if (dead) return;
          const keys = await keysP;
          const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv: ivFor(n) }, keys.send, bytes);
          if (!dead && sock.readyState === WebSocket.OPEN) sock.send(ct);
        })
        .catch(() => fail("encrypt"));
      return true;
    },
  };
}

// ---------------------------------------------------------------- scope

// The checks of policy.js, against the scope last read.
function isAllowedUrl(urlString, s = scope) {
  return urlAllowed(urlString, s);
}
function isAllowedResourceUrl(u) {
  return resourceAllowed(u, scope);
}
function isAllowedChildUrl(u) {
  return childAllowed(u, scope);
}

async function readScope() {
  const [perms, cfg] = await Promise.all([chrome.permissions.getAll(), getConfig()]);
  const grantedAll = (perms.origins || []).filter(webPattern);
  const managedAll = cfg.managedOrigins.filter(webPattern);
  const specific = grantedAll.filter((p) => !isBareWildcard(p));
  // Sites added with "Allow this site" while Chrome already allows every
  // site (the permission request then adds no pattern of its own); they
  // still need Chrome's grant, so removing site access in Chrome revokes them.
  const added = [];
  for (const p of cfg.sites) {
    if (!webPattern(p) || isBareWildcard(p) || specific.includes(p)) continue;
    try {
      if (await chrome.permissions.contains({ origins: [p] })) added.push(p);
    } catch {}
  }
  const granted = [...new Set([...specific, ...added])];
  const managed = managedAll.filter((p) => !isBareWildcard(p));
  const wildcard = grantedAll.some(isBareWildcard) || managedAll.some(isBareWildcard);
  scope = { patterns: [...new Set([...granted, ...managed])], granted, managed, wildcard, paused: cfg.paused };
  return scope;
}

// chrome.debugger.getTargets(), cached briefly: checked before every cdp command.
let targetsCache = null;
let targetsAt = 0;
let targetsInFlight = null;
function noteTargets(t) {
  targetsCache = t;
  targetsAt = Date.now();
}
function invalidateTargets() {
  targetsCache = null;
}
async function currentTargets() {
  if (targetsCache && Date.now() - targetsAt <= TARGETS_CACHE_MS) return targetsCache;
  if (!targetsInFlight) {
    targetsInFlight = chrome.debugger
      .getTargets()
      .then((t) => (noteTargets(t), t))
      .finally(() => (targetsInFlight = null));
  }
  return targetsInFlight;
}

// All page targets with a tab, plus the allowed subset as Tab objects.
// chrome.debugger.getTargets() shows url and title of every tab without the
// "tabs" permission (tab.url from chrome.tabs is hidden for non-granted sites).
async function computeAllowed() {
  const s = await readScope();
  const targets = await chrome.debugger.getTargets();
  noteTargets(targets);
  const all = new Map();
  const allowed = new Map();
  for (const t of targets) {
    if (t.type !== "page" || typeof t.tabId !== "number" || all.has(t.tabId)) continue;
    all.set(t.tabId, t);
    if (isAllowedUrl(t.url, s) && !privateTabs.has(t.tabId)) allowed.set(t.tabId, { tabId: t.tabId, targetId: t.id, url: t.url, title: t.title });
  }
  await Promise.all(
    [...allowed.values()].map(async (tab) => {
      try {
        const ct = await chrome.tabs.get(tab.tabId);
        if (typeof ct.openerTabId === "number") tab.openerTabId = ct.openerTabId;
      } catch {}
    }),
  );
  allowedCache = allowed;
  return { allowed, all };
}

function originOf(u) {
  try {
    return new URL(u).origin;
  } catch {
    return "";
  }
}

// Recompute the allowed set, detach what left it, tell the relay the diff.
// Serialized; bursts of tab events are coalesced.
let recomputeChain = Promise.resolve();
let recomputeQueued = false;
function scheduleRecompute() {
  if (recomputeQueued) return recomputeChain;
  recomputeQueued = true;
  recomputeChain = recomputeChain
    .then(() => {
      recomputeQueued = false;
      return recompute();
    })
    .catch((e) => console.warn("recompute", e));
  return recomputeChain;
}

async function recompute() {
  const { allowed, all } = await computeAllowed();
  const reasons = new Map();
  const reasonFor = (tabId, old) => {
    if (scope.paused) return "paused";
    if (privateTabs.has(tabId)) return "logon";
    if (recentlyClosed.has(tabId) || !all.has(tabId)) return "closed";
    const t = all.get(tabId);
    if (old && originOf(old.url) !== originOf(t.url)) return "left_origin";
    if (old && !isAllowedUrl(old.url)) return "origin_revoked";
    return "left_origin";
  };
  for (const tabId of [...attached]) {
    if (!allowed.has(tabId)) {
      reasons.set(tabId, reasonFor(tabId, known.get(tabId)));
      await detachTab(tabId);
    }
  }
  if (ws) {
    for (const [tabId, old] of known) {
      if (!allowed.has(tabId)) send({ type: "tabRemoved", tabId, reason: reasons.get(tabId) || reasonFor(tabId, old) });
    }
    for (const [tabId, tab] of allowed) if (!known.has(tabId)) send({ type: "tabAdded", tab });
  }
  known = new Map(allowed);
  recentlyClosed.clear();
}

// ---------------------------------------------------------------- debugger

function persistAttached() {
  chrome.storage.session.set({ attached: [...attached] }).catch(() => {});
}

function forgetTabState(tabId) {
  children.delete(tabId);
  rootClientPage.delete(tabId);
  requests.delete(tabId);
  pendingExtra.delete(tabId);
  frameNav.delete(tabId);
}

async function attachTab(tabId) {
  if (attached.has(tabId)) return;
  if (attaching.has(tabId)) return attaching.get(tabId);
  const p = chrome.debugger
    .attach({ tabId }, "1.3")
    .then(async () => {
      // Held back while this attach was on its way (a logon page, a logon): not the server's.
      if (privateTabs.has(tabId)) {
        await chrome.debugger.detach({ tabId }).catch(() => {});
        throw new Error("the tab is held back");
      }
      forgetTabState(tabId);
      attached.add(tabId);
      persistAttached();
      // Page events let the extension see every navigation start, whatever
      // the client enabled; the client gets them only after its own Page.enable.
      await chrome.debugger.sendCommand({ tabId }, "Page.enable").catch(() => {});
    })
    .finally(() => attaching.delete(tabId));
  attaching.set(tabId, p);
  return p;
}

async function detachTab(tabId) {
  const had = attached.delete(tabId);
  attachedTargets.delete(tabId);
  forgetTabState(tabId);
  if (had) persistAttached();
  try {
    await chrome.debugger.detach({ tabId });
  } catch {}
  return had;
}

async function detachAll() {
  await Promise.all([...attached].map(detachTab));
}

// After a worker restart the old socket is gone, so the relay already dropped
// its CDP client: release anything a previous worker instance attached.
async function releaseLeftovers() {
  const { attached: stored = [] } = await chrome.storage.session.get("attached");
  const ids = new Set(stored);
  try {
    for (const t of await chrome.debugger.getTargets()) if (t.attached && typeof t.tabId === "number") ids.add(t.tabId);
  } catch {}
  const released = [];
  await Promise.all(
    [...ids].map((tabId) =>
      chrome.debugger.detach({ tabId }).then(
        () => released.push(tabId),
        () => {}, // not ours (DevTools, another extension): Chrome refuses, fine
      ),
    ),
  );
  attached.clear();
  persistAttached();
  return released;
}

function cdpError(e) {
  const text = (e && e.message) || String(e);
  try {
    const j = JSON.parse(text);
    if (j && typeof j.message === "string") return rpcError(j.message, typeof j.code === "number" ? j.code : -32000);
  } catch {}
  return rpcError(text);
}

function requireTabId(m) {
  if (!Number.isInteger(m.tabId)) throw rpcError("tabId missing");
  return m.tabId;
}

// ---------------------------------------------------------------- child sessions (OOPIF, workers)

function kidsOf(tabId) {
  let k = children.get(tabId);
  if (!k) children.set(tabId, (k = new Map()));
  return k;
}

function sessionTarget(tabId, sessionId) {
  return sessionId ? { tabId, sessionId } : { tabId };
}

// Detach a child the client must not use. A child paused by
// waitForDebuggerOnStart is resumed first (Chrome keeps it paused when the
// session that paused it just detaches); if the detach fails, resume, retry.
async function releaseChild(tabId, parentSessionId, childSessionId, waiting) {
  const parent = sessionTarget(tabId, parentSessionId);
  if (waiting) await chrome.debugger.sendCommand({ tabId, sessionId: childSessionId }, "Runtime.runIfWaitingForDebugger").catch(() => {});
  try {
    await chrome.debugger.sendCommand(parent, "Target.detachFromTarget", { sessionId: childSessionId });
  } catch {
    try {
      await chrome.debugger.sendCommand({ tabId, sessionId: childSessionId }, "Runtime.runIfWaitingForDebugger");
    } catch {}
    try {
      await chrome.debugger.sendCommand(parent, "Target.detachFromTarget", { sessionId: childSessionId });
    } catch {}
  }
}

// Untrack a child and its descendants. synthetic: tell the relay they are
// gone (Chrome's own detachedFromTarget events for them are dropped, since
// they are no longer tracked).
function dropChild(tabId, sessionId, synthetic) {
  const kids = children.get(tabId);
  if (!kids || !kids.has(sessionId)) return;
  for (const [sid, c] of [...kids]) if (c.parent === sessionId) dropChild(tabId, sid, true);
  const c = kids.get(sessionId);
  kids.delete(sessionId);
  const reqs = requests.get(tabId);
  if (reqs) for (const k of [...reqs.keys()]) if (k.startsWith(sessionId + "|")) reqs.delete(k);
  if (synthetic) {
    const msg = { type: "event", tabId, method: "Target.detachedFromTarget", params: { sessionId, targetId: c.targetId } };
    if (c.parent) msg.sessionId = c.parent;
    send(msg);
  }
}

// A tracked child moved to a site that is not shared.
function kickChild(tabId, sessionId) {
  const c = children.get(tabId)?.get(sessionId);
  if (!c) return;
  dropChild(tabId, sessionId, true);
  releaseChild(tabId, c.parent, sessionId);
}

function noteFrameNav(tabId, method, p) {
  let frameId;
  let url;
  if (method === "Page.frameStartedNavigating" || method === "Page.frameRequestedNavigation") {
    frameId = p.frameId;
    url = p.url;
  } else if (method === "Page.frameNavigated" && p.frame) {
    frameId = p.frame.id;
    url = p.frame.url;
  } else return;
  if (typeof frameId !== "string" || typeof url !== "string") return;
  let m = frameNav.get(tabId);
  if (!m) frameNav.set(tabId, (m = new Map()));
  m.delete(frameId);
  m.set(frameId, url);
  while (m.size > MAX_FRAMES_PER_TAB) m.delete(m.keys().next().value);
}

function onChildAttached(tabId, parentSessionId, params) {
  const sid = params.sessionId;
  const info = params.targetInfo || {};
  if (typeof sid !== "string") return false;
  let url = info.url;
  if (info.type === "iframe" && (!url || url === "about:blank")) {
    // An OOPIF exists because of a cross-site navigation. Attached while
    // waiting for the debugger, it has no URL yet: judge it by the navigation
    // its frame started (seen in the parent's Page events), refuse if unknown.
    url = frameNav.get(tabId)?.get(info.targetId);
    if (!url) {
      releaseChild(tabId, parentSessionId, sid, params.waitingForDebugger);
      return false;
    }
  }
  if (!isAllowedChildUrl(url)) {
    releaseChild(tabId, parentSessionId, sid, params.waitingForDebugger);
    return false;
  }
  kidsOf(tabId).set(sid, { targetId: info.targetId, type: info.type, url, parent: parentSessionId, clientPage: false });
  if (info.type === "iframe" || info.type === "page") {
    // As for the tab itself: see the child's navigations whatever the client enables.
    chrome.debugger.sendCommand({ tabId, sessionId: sid }, "Page.enable").catch(() => {});
  }
  return true;
}

// ---------------------------------------------------------------- requests from the relay

async function checkCdp(m, tabId) {
  const method = m.method;
  const params = m.params || {};
  const sid = typeof m.sessionId === "string" ? m.sessionId : undefined;
  if (m.sessionId !== undefined && typeof m.sessionId !== "string") throw rpcError("bad sessionId");
  const denied = methodDenied(method);
  if (denied) throw rpcError(denied);
  if (sid !== undefined && !children.get(tabId)?.has(sid)) throw rpcError(`session ${sid} is not a shared child of tab ${tabId}`);
  switch (method) {
    case "Network.enable":
      // Bodies come inline, so that the extension can see a password in them (a client asking for none
      // would get "hasPostData" without the body, and could then fetch it with getRequestPostData).
      m.params = { ...params, maxPostDataSize: 65536 };
      break;
    case "Page.disable":
    case "Network.disable":
      // The extension relies on these events to see a tab leave the shared sites.
      throw rpcError(`${method} is not available through the extension`);
    case "Target.setAutoAttach":
      if (params.flatten !== true) throw rpcError("Target.setAutoAttach needs flatten: true through the extension");
      break;
    case "Target.detachFromTarget":
      if (typeof params.sessionId !== "string" || !children.get(tabId)?.has(params.sessionId)) throw rpcError("Target.detachFromTarget: not a shared child session");
      break;
    case "Target.getTargetInfo": {
      const own = attachedTargets.get(tabId);
      const kids = [...(children.get(tabId)?.values() || [])].map((c) => c.targetId);
      if (params.targetId !== undefined && params.targetId !== own && !kids.includes(params.targetId)) throw rpcError("Target.getTargetInfo: not a shared target");
      break;
    }
    case "Page.navigateToHistoryEntry": {
      let entry;
      try {
        const h = await chrome.debugger.sendCommand(sessionTarget(tabId, sid), "Page.getNavigationHistory");
        entry = (h.entries || []).find((e) => e.id === params.entryId);
      } catch {}
      if (!entry || !isAllowedUrl(entry.url)) throw rpcError(`Page.navigateToHistoryEntry: ${entry ? entry.url : "that entry"} is not a shared site`);
      break;
    }
    default:
      if (BODY_READS.has(method)) {
        const r = typeof params.requestId === "string" ? requests.get(tabId)?.get((sid || "") + "|" + params.requestId) : null;
        if (!r || !r.ok) throw rpcError(`${method}: request ${params.requestId} is not a request to a shared site`);
        if (r.secret && method === "Network.getRequestPostData") throw rpcError(`${method}: request ${params.requestId} sends a password; its body stays in the browser`);
      }
  }
  for (const u of siteUrls(method, params)) {
    if (u === null || !isAllowedUrl(u)) throw rpcError(`${method}: ${u === null ? "a site must be named and" : u} is not a shared site`);
  }
}

async function handleRequest(m) {
  switch (m.type) {
    case "tabs": {
      const { allowed } = await computeAllowed();
      return { tabs: [...allowed.values()] };
    }
    case "attach": {
      const tabId = requireTabId(m);
      const { allowed } = await computeAllowed();
      const tab = allowed.get(tabId);
      if (!tab) throw rpcError(`tab ${tabId} is not shared with sap-ui-automation`);
      attachedTargets.set(tabId, tab.targetId);
      try {
        await attachTab(tabId);
      } catch (e) {
        if (!attached.has(tabId)) attachedTargets.delete(tabId);
        throw rpcError(`cannot attach to tab ${tabId}: ${e.message || e}`);
      }
      // A tab that already shows a password field when the server first takes it (the user opened SAP's
      // logon page themselves): held back like one that loads such a page later.
      const st = await probe(tabId);
      if (PASSWORD_KINDS.includes(st.kind)) {
        replaceForUser(tabId);
        throw rpcError(`tab ${tabId} shows a logon page: the user logs on in a new tab first (it is shared once SAP shows the system)`);
      }
      return { tab };
    }
    case "detach": {
      await detachTab(requireTabId(m));
      return {};
    }
    case "systems":
      return { systems: await systemsForServer() };
    case "logon":
      // The answer says who is logged on where, or why not: never the password.
      return await logonSystem(m.system, { by: "server", otherLogons: m.otherLogons === "keep" ? "keep" : null, newSession: m.newSession === true });
    case "cdp": {
      const tabId = requireTabId(m);
      if (!allowedCache.has(tabId) || scope.paused) throw rpcError(`tab ${tabId} is not shared with sap-ui-automation`);
      if (!attached.has(tabId)) throw rpcError(`tab ${tabId} is not attached`);
      if (typeof m.method !== "string") throw rpcError("method missing");
      await checkCdp(m, tabId);
      // The tab may have left the shared sites without an event the
      // extension saw (page JS, history): check its URL now.
      const t = (await currentTargets()).find((x) => x.tabId === tabId && x.type === "page");
      if (!t || !isAllowedUrl(t.url)) {
        if (attached.has(tabId)) leaveOrigin(tabId);
        throw rpcError(`tab ${tabId} is not shared with sap-ui-automation (it left the shared sites)`);
      }
      if (!attached.has(tabId) || privateTabs.has(tabId)) throw rpcError(`tab ${tabId} is not attached`);
      const target = sessionTarget(tabId, m.sessionId);
      noteAgentTab(tabId, m.method);
      try {
        const result = await chrome.debugger.sendCommand(target, m.method, m.params || {});
        if (m.method === "Page.enable") {
          if (m.sessionId) {
            const c = children.get(tabId)?.get(m.sessionId);
            if (c) c.clientPage = true;
          } else rootClientPage.add(tabId);
        }
        return { result: result || {} };
      } catch (e) {
        throw cdpError(e);
      }
    }
    default:
      throw rpcError(`unknown request type ${m.type}`, -32601);
  }
}

// ---------------------------------------------------------------- events

// The URL a main-frame event says the frame is going to, or null. The main
// frame's id is the target id (the tab's, or the child's for an OOPIF).
// Caught at the start of the navigation (before the request goes out) so
// nothing of a non-allowed page reaches the relay: not its URL, request
// headers or cookies, nor its content.
function mainFrameDestination(main, method, params, isChild) {
  if (!params) return null;
  switch (method) {
    case "Page.frameStartedNavigating":
    case "Page.frameRequestedNavigation":
      return params.frameId === main && (method !== "Page.frameRequestedNavigation" || params.disposition === "currentTab") ? params.url : null;
    case "Page.frameNavigated":
      // An OOPIF's root frame keeps its parentId in the child session: match it by id.
      if (!params.frame) return null;
      return (isChild ? params.frame.id === main : !params.frame.parentId) ? params.frame.url : null;
    case "Network.requestWillBeSent":
      return params.type === "Document" && params.frameId === main && params.request ? params.request.url : null;
    default:
      return null;
  }
}

// Detach now (events stop at once: `attached` is updated synchronously), tell
// the relay in order with the other tab messages, then recompute: if the
// navigation did not happen after all (a download, a 204), the tab comes back
// with tabAdded.
function leaveOrigin(tabId) {
  detachTab(tabId);
  recomputeChain = recomputeChain
    .then(() => {
      if (known.delete(tabId)) send({ type: "tabRemoved", tabId, reason: "left_origin" });
    })
    .catch(() => {});
  scheduleRecompute();
}

function leaves(dest, method, allowedFn) {
  // At the start of a navigation only http(s) destinations count (a
  // javascript: URL is not a navigation); once committed, anything that is
  // not allowed (about:blank, chrome-error://) is outside the scope.
  return dest !== null && dest !== undefined && !allowedFn(dest) && (method === "Page.frameNavigated" || /^https?:/i.test(dest));
}

function forward(tabId, sid, method, params) {
  const msg = { type: "event", tabId, method, params };
  if (sid) msg.sessionId = sid;
  send(msg);
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  const tabId = source.tabId;
  if (!attached.has(tabId) || privateTabs.has(tabId)) return;
  params = params || {};
  const sid = source.sessionId;
  const kids = kidsOf(tabId);
  const child = sid ? kids.get(sid) : null;
  if (sid && !child) return; // a child the client may not use, or already gone
  if (method.startsWith("Fetch.") || method === "Target.receivedMessageFromTarget") return;
  if (method.startsWith("Page.frame")) noteFrameNav(tabId, method, params);

  if (!sid) {
    const dest = mainFrameDestination(attachedTargets.get(tabId), method, params, false);
    if (leaves(dest, method, isAllowedUrl)) {
      leaveOrigin(tabId);
      return;
    }
  } else if (child.type === "iframe" || child.type === "page") {
    const dest = mainFrameDestination(child.targetId, method, params, true);
    if (leaves(dest, method, isAllowedChildUrl)) {
      kickChild(tabId, sid);
      return;
    }
    if (method === "Page.frameNavigated" && dest) child.url = dest;
  }

  // A shared tab that loads a page with a password field (SAP's logon page after a timeout, a sign-in
  // page): held back before the user can type there.
  if (!sid && method === "Page.loadEventFired") setTimeout(() => checkPasswordPage(tabId), 800);

  switch (method) {
    case "Target.attachedToTarget":
      if (onChildAttached(tabId, sid, params)) forward(tabId, sid, method, params);
      return;
    case "Target.detachedFromTarget":
      if (!kids.has(params.sessionId)) return;
      dropChild(tabId, params.sessionId, false);
      forward(tabId, sid, method, params);
      return;
    case "Target.targetInfoChanged": {
      const info = params.targetInfo || {};
      const own = info.targetId === attachedTargets.get(tabId);
      const entry = [...kids].find(([, c]) => c.targetId === info.targetId);
      if (entry) {
        if (!isAllowedChildUrl(info.url)) {
          kickChild(tabId, entry[0]);
          return;
        }
        entry[1].url = info.url;
      } else if (!own) return;
      else if (!isAllowedUrl(info.url)) {
        leaveOrigin(tabId);
        return;
      }
      forward(tabId, sid, method, params);
      return;
    }
  }

  // Page events the extension enabled for itself reach the client only after its own Page.enable.
  if (method.startsWith("Page.") && !(sid ? child.clientPage : rootClientPage.has(tabId))) return;

  if (method.startsWith("Network.")) {
    for (const [mth, p] of network.filterNetworkEvent(tabId, sid, method, params)) forward(tabId, sid, mth, p);
    return;
  }
  forward(tabId, sid, method, params);
});

chrome.debugger.onDetach.addListener(async (source, reason) => {
  const tabId = source.tabId;
  if (!attached.delete(tabId)) return;
  forgetTabState(tabId);
  persistAttached();
  send({ type: "detached", tabId, reason });
  if (reason === "canceled_by_user") {
    // Cancel on Chrome's "started debugging this browser" bar: stop sharing
    // everywhere until the user clicks Share again in the side panel.
    await chrome.storage.local.set({ paused: true });
  }
  if (reason === "target_closed") recentlyClosed.add(tabId);
  scheduleRecompute();
});

// ---------------------------------------------------------------- relay connection

// One port: open, hello, auth, verify welcome, import the frame keys.
// Resolves {ok:true, socket, chan} only after the relay proved it holds the code.
function tryPort(port, code) {
  return new Promise((resolve) => {
    let sock;
    let stage = "open";
    let nS;
    let nE;
    let done = false;
    const pending = []; // frames that arrive while the welcome mac is checked and the keys imported
    let timer = setTimeout(() => finish({ ok: false, reason: "not_found" }), OPEN_TIMEOUT_MS);
    const finish = (r) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (r.ok) {
        sock.onclose = sock.onerror = null;
        resolve({ ...r, socket: sock });
      } else {
        try {
          sock && sock.close();
        } catch {}
        resolve(r);
      }
    };
    const rearm = (ms) => {
      clearTimeout(timer);
      timer = setTimeout(() => finish({ ok: false, reason: "not_relay" }), ms);
    };
    try {
      sock = new WebSocket(`ws://127.0.0.1:${port}/extension`);
      sock.binaryType = "arraybuffer";
    } catch {
      finish({ ok: false, reason: "not_found" });
      return;
    }
    sock.onopen = () => {
      stage = "hello";
      rearm(HELLO_TIMEOUT_MS);
    };
    sock.onerror = () => {};
    sock.onclose = (ev) => {
      if (ev.code === 4001) return finish({ ok: false, reason: "wrong_code" });
      if (ev.code === 4002) return finish({ ok: false, reason: "busy" });
      finish({ ok: false, reason: stage === "open" ? "not_found" : "not_relay" });
    };
    sock.onmessage = async (ev) => {
      if (stage === "verifying") {
        pending.push(ev.data);
        return;
      }
      if (typeof ev.data !== "string") return finish({ ok: false, reason: stage === "auth" ? "untrusted" : "not_relay" });
      let m;
      try {
        m = JSON.parse(ev.data);
      } catch {
        return finish({ ok: false, reason: "not_relay" });
      }
      if (stage === "hello") {
        if (!m || m.type !== "hello" || m.v !== 1 || typeof m.nonce !== "string" || m.nonce.length < 16 || m.nonce.length > 64) {
          return finish({ ok: false, reason: "not_relay" });
        }
        stage = "auth";
        nS = m.nonce;
        nE = b64(crypto.getRandomValues(new Uint8Array(16)));
        const mac = await hmacB64(code, `sap-gui-ext|${nS}|${nE}`);
        if (done) return;
        sock.send(JSON.stringify({ type: "auth", nonce: nE, mac, extensionVersion: EXT_VERSION, userAgent: navigator.userAgent }));
        rearm(WELCOME_TIMEOUT_MS);
        return;
      }
      if (stage === "auth") {
        if (m && m.type === "refused") return finish({ ok: false, reason: m.reason === "busy" ? "busy" : "wrong_code" });
        // Anything but a welcome before the welcome (a request, say) means
        // this is not a relay we will obey.
        if (!m || m.type !== "welcome" || typeof m.mac !== "string") return finish({ ok: false, reason: "untrusted" });
        stage = "verifying";
        const want = await hmacB64(code, `sap-gui-srv|${nS}|${nE}`);
        if (!constantTimeEqual(want, m.mac)) return finish({ ok: false, reason: "untrusted" });
        let keys;
        try {
          keys = await deriveKeys(code, nS, nE);
        } catch {
          return finish({ ok: false, reason: "untrusted" });
        }
        if (done) return;
        // From here on every frame goes through the channel, in order.
        const c = makeChannel(sock, Promise.resolve(keys));
        sock.onmessage = (e) => c.recv(e.data);
        for (const d of pending.splice(0)) c.recv(d);
        finish({ ok: true, chan: c });
      }
    };
  });
}

const STATUS_RANK = { not_found: 0, not_relay: 0, busy: 1, untrusted: 2, wrong_code: 3, tampered: 4 };

async function scan(helperTried = false) {
  let cfg = await getConfig();
  if (!cfg.code && !cfg.codeManaged && !helperTried) {
    // Paired by the helper, if it is installed: the user copies nothing.
    helperTried = true;
    if ((await pairWithHelper()).ok) cfg = await getConfig();
  }
  if (!cfg.code) {
    setStatus(cfg.codeManagedInvalid ? "bad_managed_code" : "no_code");
    return false;
  }
  setStatus("searching");
  let ports;
  if (cfg.port) ports = [cfg.port];
  else {
    ports = [];
    for (let p = PORT_FIRST; p <= PORT_LAST; p++) ports.push(p);
    if (ports.includes(cfg.lastPort)) ports = [cfg.lastPort, ...ports.filter((p) => p !== cfg.lastPort)];
  }
  let worst = { reason: "not_found", port: null };
  for (const port of ports) {
    const r = await tryPort(port, cfg.code);
    if (r.ok) {
      if (await adopt(r, port)) return true;
      // A frame right after the welcome failed to decrypt (or the socket died): not obeyed.
      if (r.chan.dead) worst = { reason: "tampered", port };
      continue;
    }
    if ((STATUS_RANK[r.reason] ?? 0) > (STATUS_RANK[worst.reason] ?? 0)) worst = { reason: r.reason, port };
  }
  if (worst.reason === "wrong_code" && !cfg.codeManaged && !helperTried) {
    // The machine's code changed (a new pairing file): the helper knows the new one.
    const before = cfg.code;
    if ((await pairWithHelper()).ok && (await getConfig()).code !== before) return scan(true);
  }
  setStatus(worst.reason === "not_relay" ? "not_found" : worst.reason, worst.port);
  return false;
}

async function adopt(r, port) {
  const sock = r.socket;
  if (sock.readyState !== WebSocket.OPEN || r.chan.dead) return false;
  ws = sock;
  chan = r.chan;
  wsPort = port;
  lastHeard = Date.now();
  ws.onclose = (ev) => {
    // The channel closes the socket itself when a frame fails to decrypt.
    if (r.chan.dead) return teardown(sock, "tampered", false);
    teardown(sock, ev.code === 4001 ? "wrong_code" : ev.code === 4002 ? "busy" : "disconnected", ev.code === 4001 || ev.code === 4002);
  };
  ws.onerror = () => {};
  setStatus("connected", port);
  chrome.storage.local.set({ lastPort: port }).catch(() => {});
  clearInterval(pingTimer);
  pingTimer = setInterval(() => {
    if (!ws) return;
    if (Date.now() - lastHeard > SILENCE_LIMIT_MS) {
      ws.close(4004, "no pong");
      return;
    }
    send({ type: "ping" });
  }, PING_MS);
  // The relay asks for "tabs" itself; start the diff from the current set.
  try {
    known = new Map((await computeAllowed()).allowed);
  } catch {
    known = new Map();
  }
  // Frames decrypted so far (and from now on) are handled in order. A frame
  // that fails to decrypt: nothing after it is obeyed, everything is released.
  r.chan.attach(onRelayMessage, () => teardown(sock, "tampered", false));
  return true;
}

function onRelayMessage(data) {
  lastHeard = Date.now();
  let m;
  try {
    m = JSON.parse(data);
  } catch {
    return;
  }
  if (!m || m.type === "pong") return;
  if (!Number.isInteger(m.id)) return onServerNote(m);
  privateRestored.then(() => handleRequest(m)).then(
    (result) => send({ id: m.id, result }),
    (e) => send({ id: m.id, error: { message: (e && e.message) || String(e), code: typeof e?.code === "number" ? e.code : -32000, ...(typeof e?.reason === "string" ? { reason: e.reason } : {}) } }),
  );
}

// ---------------------------------------------------------------- the side panel's view of the agent

// Who the agent is and what it may do (the server's "panel" note), and its last steps ("activity").
// Kept in session storage: the worker may restart, Chrome's restart forgets them.
const ACTIVITY_MAX = 80;
let panelInfo = null;
let activity = [];
const panelRestored = chrome.storage.session
  .get(["panelInfo", "activity"])
  .then((r) => {
    panelInfo = r.panelInfo || null;
    activity = Array.isArray(r.activity) ? r.activity : [];
  })
  .catch(() => {});

const str = (v, n) => (typeof v === "string" ? v.slice(0, n) : "");

function onServerNote(m) {
  if (m.type === "panel") {
    const p = m.policy && typeof m.policy === "object" ? m.policy : {};
    const list = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === "string").slice(0, 50).map((x) => x.slice(0, 40)) : []);
    panelInfo = {
      agent: str(m.agent, 40),
      policy: { write: ["off", "confirm", "on"].includes(p.write) ? p.write : "", systems: list(p.systems), transactions: list(p.transactions), blocked: list(p.blocked), logoff: !!p.logoff },
      at: Date.now(),
    };
    chrome.storage.session.set({ panelInfo }).catch(() => {});
    return;
  }
  if (m.type === "activity") {
    const e = {
      state: ["ran", "waiting", "refused", "declined"].includes(m.state) ? m.state : "ran",
      do: str(m.do, 20),
      label: str(m.label, 80),
      value: str(m.value, 80),
      transaction: str(m.transaction, 40),
      title: str(m.title, 120),
      system: str(m.system, 20),
      client: str(m.client, 3),
      agent: str(m.agent, 40),
      at: Date.now(),
    };
    // The yes the agent waited for came: the waiting line gives way to what happened.
    const last = activity[activity.length - 1];
    if (last && last.state === "waiting" && e.state !== "waiting" && last.do === e.do && last.label === e.label) activity.pop();
    activity.push(e);
    if (activity.length > ACTIVITY_MAX) activity = activity.slice(-ACTIVITY_MAX);
    if (e.agent && panelInfo) panelInfo.agent = e.agent;
    chrome.storage.session.set({ activity }).catch(() => {});
  }
}

async function teardown(sock, state, refused) {
  if (ws !== sock) return;
  ws = null;
  chan = null;
  wsPort = null;
  clearInterval(pingTimer);
  pingTimer = null;
  known = new Map();
  // The relay's CDP client went with the socket: release every tab.
  await detachAll();
  setStatus(state, state === "tampered" ? status.port : null);
  failures = 0;
  scheduleRetry(refused);
}

function scheduleRetry(refused = false) {
  failures++;
  const delay = refused ? MAX_REFUSED_BACKOFF_MS : Math.min(MAX_BACKOFF_MS, 1000 * 2 ** Math.min(failures - 1, 5));
  nextScanAt = Date.now() + delay;
  clearTimeout(retryTimer);
  retryTimer = setTimeout(() => ensureConnected(), delay);
}

// force: user action or settings change, skips the backoff.
function ensureConnected({ force = false } = {}) {
  if (ws) return Promise.resolve(true);
  if (connecting) return connecting;
  if (!force && Date.now() < nextScanAt) return Promise.resolve(false);
  clearTimeout(retryTimer);
  connecting = scan()
    .catch((e) => {
      console.warn("scan", e);
      return false;
    })
    .then((ok) => {
      connecting = null;
      if (ok) failures = 0;
      else scheduleRetry();
      return ok;
    });
  return connecting;
}

async function reconnect() {
  if (ws) {
    const s = ws;
    ws = null;
    chan = null;
    clearInterval(pingTimer);
    known = new Map();
    await detachAll();
    try {
      s.close(1000, "reconnect");
    } catch {}
  }
  failures = 0;
  nextScanAt = 0;
  if (connecting) await connecting;
  return ensureConnected({ force: true });
}

// ---------------------------------------------------------------- SAP systems

// A system: { id, name, url, kind, client, language, user, sso, passwordIn }
// url: the address to open (Web GUI or launchpad). sso: SAP logs the user on by
// itself (single sign-on, certificates), so no password is kept. passwordIn:
// "keychain" (the helper's OS keychain), "profile" (chrome.storage.local) or
// null. The password itself is never part of a system object.

const KINDS = ["webgui", "fiori", "other"];

function validSystems(list) {
  if (!Array.isArray(list)) return [];
  return list.filter((x) => x && typeof x.id === "string" && typeof x.name === "string" && typeof x.url === "string" && systemPattern(x.url));
}

// The shared-site pattern of a system: its host, any port (SAP systems often answer on several).
function systemPattern(u) {
  try {
    const url = new URL(u);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return `${url.protocol}//${url.hostname}/*`;
  } catch {
    return null;
  }
}

function kindOf(u) {
  try {
    const p = new URL(u).pathname.toLowerCase();
    if (p.includes("/sap/bc/gui/sap/its/webgui")) return "webgui";
    if (p.includes("/sap/bc/ui2/flp") || p.includes("/ui2/ushell") || p.includes("fiorilaunchpad")) return "fiori";
  } catch {}
  return "other";
}

// The address a SAP page was opened at, cleaned up to register: no hash, only SAP's own start parameters.
function cleanSapUrl(u) {
  const url = new URL(u);
  const keep = new URLSearchParams();
  for (const k of ["sap-client", "sap-language", "~transaction", "sap-theme"]) if (url.searchParams.has(k)) keep.set(k, url.searchParams.get(k));
  url.search = keep.toString();
  url.hash = "";
  // Web GUI adds a session part after the service ("/webgui/~4E…" or ";~sysid=…"): drop it.
  url.pathname = url.pathname.replace(/(\/sap\/bc\/gui\/sap\/its\/webgui).*$/i, "$1");
  return url.toString();
}

// What the popup proposes for the tab the user is on.
function suggestionFor(tab) {
  let url;
  try {
    url = new URL(tab.url);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const kind = kindOf(tab.url);
  const sapLike = kind !== "other" || /\/sap\//i.test(url.pathname);
  const client = url.searchParams.get("sap-client") || "";
  const language = (url.searchParams.get("sap-language") || "").toUpperCase();
  const label = kind === "webgui" ? "Web GUI" : kind === "fiori" ? "Fiori" : "SAP";
  return {
    sapLike,
    url: cleanSapUrl(tab.url),
    kind,
    client,
    language,
    // A host name says which system it is (s4d.example.com -> S4D); on this computer, what kind of page it is.
    name: `${/^(localhost|127\.|\[::1\])/.test(url.hostname) ? label : url.hostname.split(".")[0].toUpperCase()}${client ? ` ${client}` : ""}`,
  };
}

// The address to open: the system's, with its client and language as SAP's URL parameters.
function startUrl(sys) {
  const url = new URL(sys.url);
  if (sys.client && !url.searchParams.has("sap-client")) url.searchParams.set("sap-client", sys.client);
  if (sys.language && !url.searchParams.has("sap-language")) url.searchParams.set("sap-language", sys.language);
  return url.toString();
}

async function getSystems() {
  return validSystems((await chrome.storage.local.get("systems")).systems);
}

async function putSystems(list) {
  await chrome.storage.local.set({ systems: list });
}

function findSystem(list, ref) {
  if (typeof ref !== "string" || !ref.trim()) return null;
  const r = ref.trim().toLowerCase();
  return list.find((x) => x.id === ref) || list.find((x) => x.name.toLowerCase() === r) || (list.filter((x) => x.name.toLowerCase().startsWith(r)).length === 1 ? list.find((x) => x.name.toLowerCase().startsWith(r)) : null);
}

// Does a tab show this system (same origin, under the system's path)?
function tabOfSystem(sys, tabUrl) {
  try {
    const a = new URL(sys.url);
    const b = new URL(tabUrl);
    if (a.origin !== b.origin) return false;
    const base = a.pathname.replace(/\/[^/]*\.[a-z]+$/i, "/").replace(/\/+$/, "").toLowerCase();
    return b.pathname.toLowerCase().startsWith(base);
  } catch {
    return false;
  }
}

// What the server sees of the systems: never a password, only whether one is saved.
async function systemsForServer() {
  const list = await getSystems();
  const targets = await currentTargets().catch(() => []);
  return list.map((x) => ({
    id: x.id,
    name: x.name,
    url: x.url,
    kind: x.kind || kindOf(x.url),
    client: x.client || "",
    language: x.language || "",
    user: x.user || "",
    logon: x.sso ? "sso" : x.passwordIn ? "password" : "manual",
    // What SAP answered to the last logon, while it stands (a refused password, a lock): never its password.
    ...(x.logonIssue ? { issue: { reason: x.logonIssue.reason, at: new Date(x.logonIssue.at).toISOString() } } : {}),
    open: targets.some((t) => t.type === "page" && tabOfSystem(x, t.url) && !privateTabs.has(t.tabId)),
  }));
}

// Sites added with "Allow this site" before systems existed become systems.
async function migrateSites() {
  const { sites } = await chrome.storage.local.get("sites");
  if (!Array.isArray(sites) || !sites.length) return;
  const list = await getSystems();
  for (const p of sites) {
    const m = /^(https?):\/\/([^/*]+)\/\*$/.exec(p);
    if (!m || list.some((x) => systemPattern(x.url) === p)) continue;
    list.push({ id: newId(), name: m[2], url: `${m[1]}://${m[2]}/`, kind: "other", client: "", language: "", user: "", sso: true, passwordIn: null });
  }
  await putSystems(list);
  await chrome.storage.local.remove("sites");
}

function newId() {
  return "s" + [...crypto.getRandomValues(new Uint8Array(8))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ---------------------------------------------------------------- the helper (native messaging host)

let helper = null; // { ok, keychain } once asked

async function native(msg) {
  try {
    return await chrome.runtime.sendNativeMessage(NATIVE_HOST, msg);
  } catch {
    return null; // not installed, or it failed to start
  }
}

// Asked once per worker; when it was missing, again after a while (the user may have installed it since).
async function helperInfo(force = false) {
  if (helper && !force && (helper.ok || Date.now() - helper.at < 15000)) return helper;
  const r = await native({ cmd: "hello" });
  helper = r && r.ok ? { ok: true, keychain: r.keychain || null, at: Date.now() } : { ok: false, keychain: null, at: Date.now() };
  return helper;
}

// Pairing in one click (or none): the helper reads the machine's pairing code.
async function pairWithHelper() {
  const cfg = await getConfig();
  if (cfg.codeManaged) return { ok: false, error: "The pairing code is set by your organization." };
  const r = await native({ cmd: "pair" });
  if (!r || !r.ok) {
    await helperInfo(true);
    return { ok: false, error: r ? r.error || "the helper failed" : "helper_missing" };
  }
  const code = validCode(r.code);
  if (!code) return { ok: false, error: "the helper gave an invalid code" };
  if (code !== cfg.code) await chrome.storage.local.set({ pairingCode: code });
  // The helper answered: a "missing" kept from before setup ran must not hold the password field off.
  await helperInfo(true);
  return { ok: true };
}

// ---------------------------------------------------------------- passwords

// Passwords live only in the computer's keychain, through the helper: never in the Chrome profile, where
// they would sit unencrypted on disk. Without a keychain no password is saved (the user logs on in the tab).
async function savePassword(sys, password) {
  const h = await helperInfo(true);
  if (!h.ok) throw new Error("To save a password, install the helper first: in a terminal, run npx -y sap-ui-automation setup --extension, then restart Chrome. Or leave the password empty and log on in the tab.");
  if (!h.keychain) throw new Error("This computer has no keychain the helper can use, so the password is not saved. Leave it empty and log on in the tab.");
  const r = await native({ cmd: "secret.set", id: sys.id, value: password, label: sys.name });
  if (!r || !r.ok) throw new Error(`The keychain did not take the password${r && r.error ? `: ${r.error}` : ""}.`);
  await forgetProfilePassword(sys.id);
  return "keychain";
}

// Version 0.2 kept passwords in the profile when there was no helper: they move to the keychain once there is.
async function migrateProfilePasswords() {
  const { secrets } = await chrome.storage.local.get("secrets");
  if (!secrets || !Object.keys(secrets).length) return;
  const h = await helperInfo(true);
  if (!h.ok || !h.keychain) return;
  const list = await getSystems();
  for (const sys of list) {
    if (sys.passwordIn !== "profile" || typeof secrets[sys.id] !== "string") continue;
    const r = await native({ cmd: "secret.set", id: sys.id, value: secrets[sys.id], label: sys.name });
    if (r && r.ok) sys.passwordIn = "keychain";
  }
  await putSystems(list);
  for (const sys of list) if (sys.passwordIn === "keychain") await forgetProfilePassword(sys.id);
}

async function readPassword(sys) {
  if (sys.passwordIn === "keychain") {
    const r = await native({ cmd: "secret.get", id: sys.id });
    return r && r.ok && typeof r.value === "string" ? r.value : null;
  }
  if (sys.passwordIn === "profile") {
    const { secrets = {} } = await chrome.storage.local.get("secrets");
    return typeof secrets[sys.id] === "string" ? secrets[sys.id] : null;
  }
  return null;
}

async function forgetProfilePassword(id) {
  const { secrets } = await chrome.storage.local.get("secrets");
  if (secrets && id in secrets) {
    delete secrets[id];
    await chrome.storage.local.set({ secrets });
  }
}

async function forgetPassword(sys) {
  await forgetProfilePassword(sys.id);
  if (sys.passwordIn === "keychain") await native({ cmd: "secret.delete", id: sys.id });
}

// ---------------------------------------------------------------- pages with a password field

// A tab that shows a password field (SAP's logon page, its new-password form, an identity provider's
// sign-in page) is never shared with the server: the user may type a password there, and a script the
// server ran in the page could read it. Such a tab is held back (private), watched with the extension's
// own debugger, and shared again once the field is gone. Held tabs survive a worker restart.
const PASSWORD_KINDS = ["logon", "password_form", "password_change"];
const guards = new Set();

function persistPrivate() {
  chrome.storage.session.set({ privateTabs: [...privateTabs] }).catch(() => {});
}

async function guardTab(tabId, { attachedOwn = false, fresh = false } = {}) {
  if (guards.has(tabId)) return;
  guards.add(tabId);
  privateTabs.add(tabId);
  persistPrivate();
  // Detaches the server first (tabRemoved "logon"): the extension's own attachment follows.
  if (!attachedOwn) await scheduleRecompute();
  try {
    if (!attachedOwn) {
      if (attached.has(tabId)) await detachTab(tabId);
      await chrome.debugger.attach({ tabId }, "1.3").catch(() => {});
    }
    // A service worker of the origin never sees what the user sends from here.
    await chrome.debugger.sendCommand({ tabId }, "Network.enable").catch(() => {});
    await chrome.debugger.sendCommand({ tabId }, "Network.setBypassServiceWorker", { bypass: true }).catch(() => {});
    if (fresh) {
      // The page was shared: a script the server left in it would outlive the detach. A fresh load has none.
      const t = await chrome.tabs.get(tabId).catch(() => null);
      if (t && t.url) await chrome.debugger.sendCommand({ tabId }, "Page.navigate", { url: t.url }).catch(() => {});
    }
    for (;;) {
      await sleep(1500);
      if (!(await chrome.tabs.get(tabId).catch(() => null))) return; // closed
      if (logonTabs.has(tabId)) continue; // a logon runs in it
      await chrome.debugger.attach({ tabId }, "1.3").catch(() => {}); // after a worker restart, or a detach
      const st = await probe(tabId);
      if (st.unreadable || st.kind === "loading" || PASSWORD_KINDS.includes(st.kind)) continue;
      break;
    }
    await evalIn(tabId, CLEAR_PASSWORDS).catch(() => {});
    await chrome.debugger.detach({ tabId }).catch(() => {});
  } finally {
    guards.delete(tabId);
    if (!logonTabs.has(tabId)) {
      privateTabs.delete(tabId);
      persistPrivate();
      invalidateTargets();
      await scheduleRecompute();
    }
  }
}

// After a shared tab loaded a page: does it show a password field? Then the user logs on elsewhere.
async function checkPasswordPage(tabId) {
  if (!attached.has(tabId) || privateTabs.has(tabId)) return;
  const st = await probe(tabId);
  if (PASSWORD_KINDS.includes(st.kind)) await replaceForUser(tabId);
}

// A tab the server had (or could reach) that shows a password field: a script the server left in it, or
// a window of the same origin holding it, could read what the user types. So the user does not type there:
// the tab is emptied, and the same address opens in a new tab the server never had, held back until the
// user is through (guardTab).
async function replaceForUser(tabId) {
  const t = await chrome.tabs.get(tabId).catch(() => null);
  if (!t || !t.url || privateTabs.has(tabId)) return;
  privateTabs.add(tabId);
  persistPrivate();
  await scheduleRecompute();
  if (attached.has(tabId)) await detachTab(tabId);
  await chrome.debugger.attach({ tabId }, "1.3").catch(() => {});
  await chrome.debugger.sendCommand({ tabId }, "Page.navigate", { url: "about:blank" }).catch(() => {});
  await chrome.debugger.detach({ tabId }).catch(() => {});
  privateTabs.delete(tabId);
  persistPrivate();
  const tab = await chrome.tabs.create({ url: "about:blank", active: true, windowId: t.windowId, index: t.index + 1 }).catch(() => null);
  if (!tab) return;
  privateTabs.add(tab.id);
  persistPrivate();
  try {
    await chrome.debugger.attach({ tabId: tab.id }, "1.3");
    await chrome.debugger.sendCommand({ tabId: tab.id }, "Network.enable").catch(() => {});
    await chrome.debugger.sendCommand({ tabId: tab.id }, "Network.setBypassServiceWorker", { bypass: true }).catch(() => {});
    await chrome.debugger.sendCommand({ tabId: tab.id }, "Page.navigate", { url: t.url });
  } catch {}
  guardTab(tab.id, { attachedOwn: true });
  await chrome.tabs.remove(tabId).catch(() => {});
}

// Tabs held back by an earlier worker: held again before anything is shared.
async function restorePrivate() {
  const { privateTabs: stored = [] } = await chrome.storage.session.get("privateTabs");
  for (const tabId of stored) if (Number.isInteger(tabId)) guardTab(tabId, { attachedOwn: false });
}

// ---------------------------------------------------------------- logging on

const LOGON_TIMEOUT_MS = 60000;
// On a single sign-on system, or one that sends the browser to an identity provider: how long the
// provider's page may stay before the user is asked to sign in there.
const IDP_WAIT_MS = 20000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Why a logon stopped. The relay's error carries it as `reason`; the popup shows it in the system's row.
//   not_registered, paused, password_unreadable: before anything is opened;
//   wrong_password, user_locked, refused: SAP's logon page answered with this message;
//   password_change: SAP asks for a new password; multiple_logon: SAP asks about the user's other logons;
//   identity_provider: an identity provider waits for the user; sap_error: SAP answered with its error page; page_changed: SAP's logon page has no field
//   the extension knows; timeout: SAP did not answer in time.
// An error with `held` repeats an earlier answer of SAP that stands (heldIssue): nothing was opened or typed.
function logonError(reason, message, extra = {}) {
  const e = rpcError(message);
  e.reason = reason;
  Object.assign(e, extra);
  return e;
}

// What SAP's message on its logon page means. English and German, the two languages of SAP's own texts.
function refusalOf(message) {
  const m = String(message || "");
  if (/\block|gesperrt|too many failed|zu viele/i.test(m)) return "user_locked";
  if (/(password|kennwort).{0,40}(expired|abgelaufen|no longer valid|nicht mehr gültig)|(change|ändern).{0,20}(password|kennwort)/i.test(m)) return "password_change";
  if (/(password|kennwort|name|user|benutzer).{0,60}(incorrect|not correct|wrong|invalid|falsch|nicht korrekt|ungültig)/i.test(m)) return "wrong_password";
  return "refused";
}

// The agent's next step, per reason: it says what to tell the user; never "give me the password".
function agentText(reason, sys, sapMessage = "", extra = {}) {
  const who = sys ? `${sys.user || "the user"} on ${sys.name}` : "";
  const said = sapMessage ? ` SAP says: "${sapMessage}".` : "";
  switch (reason) {
    case "paused":
      return "The user stopped sharing with Cancel on Chrome's debugging bar. Ask them to click Share again in the extension's side panel (the SAP UI MCP icon in Chrome's toolbar), then call sap_logon again.";
    case "password_unreadable":
      return `The saved password of ${sys.name} could not be read${sys.passwordIn === "keychain" ? " from the keychain" : ""}. Ask the user to open the extension's side panel, edit ${sys.name} and save its password again.`;
    case "wrong_password":
      return `SAP refused the user name or password for ${who}.${said} The extension will not try this password again, so that the user is not locked. Ask the user to update the password of ${sys.name} in the extension's side panel (Edit), or to log on in the tab themselves. Do not ask for the password.`;
    case "user_locked":
      return `SAP says ${sys.user || "the user"} is locked on ${sys.name}.${said} Ask the user to have it unlocked (their SAP administrator, transaction SU01), then to click Log on in the extension's side panel. Do not retry.`;
    case "password_change":
      return `SAP asks ${who} for a new password. Ask the user to change it in the tab that is now in front, then to save the new password in the extension's side panel (Edit ${sys.name}). Do not retry before that.`;
    case "multiple_logon":
      return `${sys.user || "The user"} is already logged on to ${sys.name} elsewhere, and SAP asks whether to end those other logons. Ask the user what they want: they can answer in the tab that is now in front, or tell you to keep the other logons; then call sap_logon again with otherLogons: "keep". Never end the user's other logons yourself.`;
    case "identity_provider":
      return `${sys.name} sends the browser to ${extra.host || "an identity provider"} to sign in, which the extension does not do. Ask the user to sign in in the tab that is now in front, then call sap_sessions.`;
    case "page_changed":
      return `The logon page of ${sys.name} has no ${extra.field || "field"} the extension knows, so it did not log on. Ask the user to log on in the tab that is now in front, then call sap_sessions.`;
    case "sap_error":
      return /dialog user/i.test(sapMessage)
        ? `SAP answered with an error page for ${who}: "${sapMessage}". The saved user is not a dialog user (it may be meant for RFC or background work), so it cannot log on in a browser. Ask the user to save a dialog user for ${sys.name} in the extension's side panel (Edit).`
        : `SAP answered with an error page for ${who}.${said} Tell the user what SAP said; the tab stays open.`;
    case "timeout":
      return `${sys.name} did not show SAP within ${Math.round(LOGON_TIMEOUT_MS / 1000)} s (the tab stays open). Check with the user that the system is reachable from this computer (VPN, address), then call sap_logon again.`;
    case "refused":
      return `SAP did not log ${sys.user || "the user"} on to ${sys.name}.${said} Tell the user what SAP said; do not retry with the same settings.`;
    default:
      return sapMessage || "The logon stopped.";
  }
}

// An earlier answer of SAP that stands until the user acts: a refused password until a new one is saved,
// a locked user until the user clicks Log On again. The server never gets past it; the popup only past a lock.
function heldIssue(sys, by) {
  const i = sys.logonIssue;
  if (!i) return null;
  if (i.reason === "wrong_password") return i;
  if (i.reason === "user_locked" && by === "server") return i;
  return null;
}

async function setIssue(id, issue) {
  const list = await getSystems();
  const sys = list.find((x) => x.id === id);
  if (!sys) return;
  if (issue) sys.logonIssue = { reason: issue.reason, message: String(issue.message || "").slice(0, 300), at: Date.now() };
  else if (sys.logonIssue) delete sys.logonIssue;
  else return;
  await putSystems(list);
}

// Runs in the page: what it shows. Never returns a field's value.
const PROBE = `(() => {
  const vis = (e) => !!e && !!(e.offsetWidth || e.offsetHeight || e.getClientRects().length);
  const q = (s) => [...document.querySelectorAll(s)].filter(vis);
  const text = (e) => (e.innerText || e.textContent || "").replace(/\\s+/g, " ").trim();
  const loaded = document.readyState === "complete";
  const host = location.hostname;
  const mark = document.documentElement.hasAttribute("data-sap-ui-automation-submitted");
  const user = q('input[name="sap-user"], input#sap-user, input[name="j_username"], #USERNAME_FIELD-inner')[0];
  const pw = q('input[name="sap-password"], input#sap-password, input[type="password"]');
  const newPw = q('input[name*="passwordnew" i], input[name*="password-new" i], input[name*="newpassword" i], input[id*="passwordnew" i], input[id*="NEW_PASSWORD" i]');
  // SAP's error, never its warnings: Web GUI warns about plain HTTP on every logon page.
  let message = "";
  for (const e of q('.lsMessageBar--typeError, #LOGIN_ERROR_BLOCK, [id^="LOGIN_MESSAGE"], .urMsgBarErr, .sapMMsgStripError, [role="alert"]')) {
    const t = text(e.querySelector('[id$="-txt"]') || e);
    if (t && t.length < 400) { message = t; break; }
  }
  const body = text(document.body || document.documentElement).slice(0, 4000);
  if (newPw.length || (pw.length > 1 && /new password|neues kennwort|change.*password|kennwort.*ändern/i.test(body))) return { kind: "password_change", host, mark, message };
  const radios = q('input[type="radio"]');
  if (document.querySelector("#SESSION_QUERY_CONTINUE_BUTTON") || (radios.length && /already logged on|bereits angemeldet|multiple logon|mehrfachanmeldung/i.test(body))) return { kind: "multi", host, mark };
  if (user && pw.length) return { kind: "logon", host, mark, loaded, message, client: !!q('input[name="sap-client"]:not([readonly])')[0] };
  if (pw.length) return { kind: "password_form", host, mark, loaded };
  if (!loaded) return { kind: "loading", host, mark };
  // SAP's error page ("500 Internal Server Error", then why: "Log on with a dialog user").
  const h1 = document.querySelector("h1");
  const head = h1 ? text(h1) : "";
  if (/^[45]\d\d\b/.test(head) || /application server error/i.test(document.title)) {
    const why = body.replace(head, "").replace(/Server time:.*$/i, "").replace(/©.*$/, "").trim().slice(0, 200);
    return { kind: "sap_error", host, mark, message: why || head };
  }
  // This runs in an isolated world: the page's own scripts are not visible, only its document.
  const app = !!document.querySelector("#ToolbarOkCode, #shell-header, #shell-hdr, [id^='shell-header'], .sapUshellShellHead, .sapUshellShellHeader, .sapUshellShell, #shellLayout, [id^=M0], #webguiPage0");
  return { kind: app ? "app" : "page", host, mark, title: document.title };
})()`;

// Who is logged on, where the launchpad says it; else the address's client. Runs in the page's own world
// (the launchpad's API lives there), so only ever used to pick an open tab, never to decide where to type.
const SESSION = `(() => {
  let session = { user: "", client: new URLSearchParams(location.search).get("sap-client") || "" };
  try {
    const c = window.sap && window.sap.ushell && window.sap.ushell.Container;
    if (c) {
      const u = c.getUser && c.getUser();
      const s = c.getLogonSystem && c.getLogonSystem();
      session = { user: u && u.getId ? String(u.getId()).toUpperCase() : "", client: (s && s.getClient && String(s.getClient())) || session.client };
    }
  } catch {}
  return session;
})()`;

// SAP asks whether to end the user's other logons, and the user said to keep them.
const KEEP_OTHER_LOGONS = `(() => {
  const vis = (e) => !!e && !!(e.offsetWidth || e.offsetHeight || e.getClientRects().length);
  const label = (r) => ((r.labels && r.labels[0] && r.labels[0].innerText) || (r.closest("label,tr,div") || {}).innerText || "").replace(/\\s+/g, " ");
  const keep = [...document.querySelectorAll('input[type="radio"]')].filter(vis).find((r) => /without ending|ohne .*beenden/i.test(label(r)));
  if (!keep) return false;
  keep.click();
  const go = document.querySelector("#SESSION_QUERY_CONTINUE_BUTTON") || [...document.querySelectorAll('button, [role="button"], input[type="submit"]')].filter(vis).find((b) => /continue|weiter/i.test(b.innerText || b.value || ""));
  if (!go) return false;
  go.click();
  return true;
})()`;

// Empties every password field: run before a logon tab goes back to the server, and when the page is left
// (a page kept in the back/forward cache keeps no password either).
const CLEAR_PASSWORDS = `(() => {
  const clear = () => { for (const e of document.querySelectorAll('input[type="password"], input[name="sap-password"]')) e.value = ""; };
  clear();
  addEventListener("pagehide", clear, { capture: true });
  return true;
})()`;

// Focuses a field of the system's own page, in the top frame, and says whether the keys will go there.
// The logon page's fields are emptied if it is left (the back/forward cache keeps no password).
const CLEAR_PASSWORDS_ON_LEAVE = `(addEventListener("pagehide", () => { for (const e of document.querySelectorAll('input[type="password"]')) e.value = ""; }, { capture: true }), true)`;

const FOCUS = (selector, host, https) => `(() => {
  if (location.hostname !== ${JSON.stringify(host)} || window.top !== window) return false;
  if (${https ? "true" : "false"} && location.protocol !== "https:") return false;
  const e = [...document.querySelectorAll(${JSON.stringify(selector)})].find((x) => x.offsetWidth || x.offsetHeight);
  if (!e) return false;
  e.removeAttribute("readonly");
  e.focus();
  e.select && e.select();
  return document.activeElement === e && document.hasFocus();
})()`;

// The logon language: the launchpad's list, or Web GUI's hidden field (its list only shows it).
const SET_LANGUAGE = (lang) => `(() => {
  const want = ${JSON.stringify(lang)}.toUpperCase();
  const sel = document.querySelector('#LANGUAGE_SELECT, select[name="sap-language"]');
  if (sel) {
    const o = [...sel.options].find((x) => x.value.toUpperCase() === want || x.text.toUpperCase().startsWith(want + " "));
    if (!o) return false;
    sel.value = o.value;
    sel.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }
  const hidden = document.querySelector('input[name="sap-language"]');
  if (hidden) { hidden.value = want; return true; }
  return false;
})()`;

const SUBMIT = `(() => {
  document.documentElement.setAttribute("data-sap-ui-automation-submitted", "");
  const vis = (e) => !!e && !!(e.offsetWidth || e.offsetHeight || e.getClientRects().length);
  const b = document.querySelector("#LOGON_BUTTON, #LOGIN_LINK") || [...document.querySelectorAll('button[type="submit"], input[type="submit"], [role="button"]')].filter(vis).find((x) => /log ?on|log ?in|anmelden|sign in/i.test(x.innerText || x.value || x.title || ""));
  if (b) { b.click(); return "button"; }
  const f = (document.querySelector('input[name="sap-password"]') || {}).form;
  if (f) { f.requestSubmit ? f.requestSubmit() : f.submit(); return "form"; }
  return "";
})()`;

// Runs a script of the extension in the tab's top frame, in an isolated world: it sees the page's document
// but not the page's scripts, which therefore cannot change what it does (patch focus(), querySelector...).
async function evalIn(tabId, expression) {
  const tree = await chrome.debugger.sendCommand({ tabId }, "Page.getFrameTree");
  const frameId = tree && tree.frameTree && tree.frameTree.frame && tree.frameTree.frame.id;
  const world = await chrome.debugger.sendCommand({ tabId }, "Page.createIsolatedWorld", { frameId, worldName: "sap-ui-automation", grantUniveralAccess: false });
  const r = await chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", { expression, contextId: world.executionContextId, returnByValue: true, awaitPromise: false });
  if (r && r.exceptionDetails) throw new Error("script failed");
  return r && r.result ? r.result.value : undefined;
}

// The same in the page's own world: only for reading what the page's scripts know (SESSION).
async function evalInPage(tabId, expression) {
  const r = await chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", { expression, returnByValue: true, awaitPromise: false });
  if (r && r.exceptionDetails) throw new Error("script failed");
  return r && r.result ? r.result.value : undefined;
}

async function probe(tabId) {
  try {
    return (await evalIn(tabId, PROBE)) || { kind: "loading" };
  } catch {
    return { kind: "loading", unreadable: true }; // between two documents, or not attached
  }
}

// Types into a field of the system's page: only after the extension's own script focused it there.
async function typeInto(tabId, selector, value, host, https = false) {
  if (!(await evalIn(tabId, FOCUS(selector, host, https)))) return false;
  await chrome.debugger.sendCommand({ tabId }, "Input.insertText", { text: value });
  return true;
}

// Probes the tab every half second until `pick` returns a state, or the time is up ({ kind: "timeout" }).
async function watch(tabId, ms, pick) {
  const end = Date.now() + ms;
  let last = { kind: "loading" };
  while (Date.now() < end) {
    last = await probe(tabId);
    const r = pick(last);
    if (r) return r;
    await sleep(500);
  }
  return { ...last, kind: "timeout", was: last.kind };
}

// Does a logged-on page fit the system: its client and user, where SAP shows them?
function sameSession(sys, s) {
  if (!s) return true;
  if (sys.client && s.client && s.client !== sys.client) return false;
  if (sys.user && s.user && s.user !== sys.user.toUpperCase()) return false;
  return true;
}

const LOGON_SELECTORS = {
  user: 'input[name="sap-user"], input#sap-user, input[name="j_username"], #USERNAME_FIELD-inner',
  password: 'input[name="sap-password"], input#sap-password, input[type="password"]',
  client: 'input[name="sap-client"], #CLIENT_FIELD-inner',
};

const logons = new Map(); // system id -> running logon promise

// Opens a system and logs on to it. by: "server" (the relay asked) or "user" (the popup).
// otherLogons: "keep" when the user said to keep their other logons (SAP's multiple logon question).
// newSession: another session of the system in a new window, even when a tab is logged on already
// (an agent working in several sessions at once).
let newSessions = 0;
async function logonSystem(ref, { by, otherLogons = null, newSession = false }) {
  const list = await getSystems();
  const sys = findSystem(list, ref);
  if (!sys) {
    const names = list.map((x) => x.name);
    throw logonError(
      "not_registered",
      names.length
        ? `No system named "${ref}" is registered in the extension. Registered: ${names.join(", ")}. If the user means another system, ask them to open it in Chrome and click Add this SAP page in the extension's side panel. Never ask the user for a password.`
        : "No SAP system is registered in the extension yet. Ask the user to open their SAP system in Chrome and click Add this SAP page in the extension's side panel. Never ask the user for a password.",
    );
  }
  if (by === "server" && (await getConfig()).paused) throw logonError("paused", agentText("paused", sys));
  // One logon a system at a time, but each new session is its own.
  const key = newSession ? `${sys.id}#${++newSessions}` : sys.id;
  if (logons.has(key)) return logons.get(key);
  const p = doLogon(sys, by, otherLogons, newSession).finally(() => logons.delete(key));
  logons.set(key, p);
  return p;
}

async function doLogon(sys, by, otherLogons, newSession = false) {
  let r;
  try {
    r = await doLogonSteps(sys, by, otherLogons, newSession);
  } catch (e) {
    // What SAP answered stays on the system's row until the user acts on it.
    if (e && !e.held && ["wrong_password", "user_locked", "password_change", "multiple_logon", "identity_provider", "page_changed", "sap_error", "timeout", "refused"].includes(e.reason)) await setIssue(sys.id, { reason: e.reason, message: e.sapMessage || "" });
    if (Number.isInteger(e && e.tabId)) await focusTab(e.tabId);
    throw e;
  }
  // A refused password or a lock stays until that password works again; anything else is over.
  const kept = sys.logonIssue && ["wrong_password", "user_locked"].includes(sys.logonIssue.reason) && r.state !== "logged_on";
  if (!kept) await setIssue(sys.id, null);
  // The agent asked for this system: the popup names it as where the agent works.
  if (by === "server" && Number.isInteger(r.tabId)) noteAgentTab(r.tabId);
  if (Number.isInteger(r.tabId)) await focusTab(r.tabId);
  // The server names Chrome tabs by their target id ("chrome:<targetId>" sessions).
  try {
    const t = (await chrome.debugger.getTargets()).find((x) => x.tabId === r.tabId && x.type === "page");
    if (t) r.targetId = t.id;
  } catch {}
  return r;
}

// Tabs a logon runs in right now (the guard leaves them to it).
const logonTabs = new Set();

async function doLogonSteps(sys, by, otherLogons, newSession = false) {
  const base = { system: sys.name, client: sys.client || "", user: sys.user || "" };
  const host = new URL(sys.url).hostname;
  // A page of the system that SAP shows logged on: the launchpad or Easy Access; any page for an "other" system.
  const isApp = (s) => s.host === host && (s.kind === "app" || (s.kind === "page" && (sys.kind || kindOf(sys.url)) === "other"));
  let password = null;
  // Nothing SAP says goes to the agent, the popup or storage with the password in it.
  const scrub = (m) => {
    let t = String(m || "");
    if (password) {
      for (const form of new Set([password, encodeURIComponent(password), password.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)])) {
        t = t.replace(new RegExp(form.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), "***");
      }
    }
    return t.slice(0, 200);
  };
  const fail = (reason, extra = {}) => {
    if (extra.sapMessage) extra.sapMessage = scrub(extra.sapMessage);
    return logonError(reason, agentText(reason, sys, extra.sapMessage, extra), extra);
  };

  // 1. A tab of this system that SAP shows logged on (same client and user) is the answer. A tab at SAP's
  //    question about other logons is answered there when the user said so. Nothing is ever typed into a
  //    tab the server had: a page it ran scripts in could read the field.
  const targets = newSession ? [] : await chrome.debugger.getTargets();
  const candidates = targets.filter((t) => t.type === "page" && typeof t.tabId === "number" && tabOfSystem(sys, t.url) && !privateTabs.has(t.tabId));
  let multiTab = null;
  for (const t of candidates) {
    const seen = await withOwnDebugger(t.tabId, async () => {
      const st = await probe(t.tabId);
      return isApp(st) ? { ...st, session: await evalInPage(t.tabId, SESSION).catch(() => null) } : st;
    }).catch(() => ({ kind: "loading" }));
    if (isApp(seen) && sameSession(sys, seen.session)) return { ...base, state: "already", tabId: t.tabId, title: t.title };
    if (!multiTab && seen.kind === "multi" && seen.host === host) multiTab = t.tabId;
  }

  // 2. Nothing is typed again after SAP refused it.
  const held = heldIssue(sys, by);
  if (held) throw logonError(held.reason, agentText(held.reason, sys, held.message), { held: true, sapMessage: held.message });

  password = sys.sso ? null : await readPassword(sys);
  if (!password && !sys.sso && sys.passwordIn) throw fail("password_unreadable");

  // 3. A new tab, private from its first moment (no opener, no page the server saw), or the question's tab.
  let tabId = multiTab;
  if (tabId !== null) {
    if (otherLogons !== "keep") throw fail("multiple_logon", { tabId });
    privateTabs.add(tabId);
    await scheduleRecompute();
  } else if (newSession) {
    // A window of its own: sessions in tabs of one window take the front from each other, and Chrome slows the hidden ones.
    const win = await chrome.windows.create({ url: "about:blank", focused: true });
    tabId = win.tabs[0].id;
    privateTabs.add(tabId);
  } else {
    const tab = await chrome.tabs.create({ url: "about:blank", active: true });
    tabId = tab.id;
    privateTabs.add(tabId);
  }
  logonTabs.add(tabId);
  persistPrivate();
  let ownAttach = false;
  try {
    await chrome.debugger.attach({ tabId }, "1.3");
    ownAttach = true;
    await chrome.debugger.sendCommand({ tabId }, "Page.enable").catch(() => {});
    // The user clicked Log on in the side panel, which keeps the window's focus: without this the logon
    // page never has focus (document.hasFocus() is false), and FOCUS refuses to type into it.
    await chrome.debugger.sendCommand({ tabId }, "Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => {});
    let state;
    if (multiTab !== null) state = { kind: "multi", host };
    else {
      // A service worker of the origin (one a shared page could have registered) never serves the logon page.
      await chrome.debugger.sendCommand({ tabId }, "Network.enable").catch(() => {});
      await chrome.debugger.sendCommand({ tabId }, "Network.setBypassServiceWorker", { bypass: true }).catch(() => {});
      await chrome.debugger.sendCommand({ tabId }, "Page.navigate", { url: startUrl(sys) });
      await sleep(300);
      state = await arrive(tabId, host, isApp);
    }
    if (state.kind === "timeout") throw fail("timeout", { tabId });
    if (state.kind === "sap_error") throw fail("sap_error", { tabId, sapMessage: state.message });
    if (state.kind === "identity_provider") {
      if (sys.sso || !password) return { ...base, state: "needs_user", reason: "identity_provider", tabId, message: agentText("identity_provider", sys, "", state) };
      throw fail("identity_provider", { tabId, host: state.host });
    }
    if (isApp(state)) return { ...base, state: sys.sso ? "sso" : newSession ? "logged_on" : "already", tabId };

    if (state.kind === "logon") {
      if (!password) {
        // No password saved, or single sign-on that still shows the logon page: the user types it in the tab.
        return { ...base, state: "needs_user", reason: sys.sso ? "sso_logon_page" : "no_password", tabId, message: "SAP shows its logon page and no password is saved: ask the user to log on in the tab that is now in front, then call sap_sessions." };
      }
      // SAP's own logon page, on the system's own host, fully loaded: nowhere else is anything typed.
      if (!state.loaded) state = await watch(tabId, 5000, (s) => (s.kind === "logon" && s.loaded && s.host === host ? s : null));
      if (state.kind !== "logon" || state.host !== host) throw fail("page_changed", { tabId, field: "logon form" });
      // Web GUI swaps its logon fields once its scripts run: let it settle.
      await sleep(800);
      // A system registered with https is never typed into over http (a downgrade on the way).
      const https = new URL(sys.url).protocol === "https:";
      if (sys.client && state.client) await typeInto(tabId, LOGON_SELECTORS.client, sys.client, host, https);
      if (sys.language) await evalIn(tabId, SET_LANGUAGE(sys.language)).catch(() => false);
      if (sys.user && !(await typeInto(tabId, LOGON_SELECTORS.user, sys.user, host, https))) throw fail("page_changed", { tabId, field: "user field" });
      if (!(await typeInto(tabId, LOGON_SELECTORS.password, password, host, https))) throw fail("page_changed", { tabId, field: "password field" });
      await evalIn(tabId, CLEAR_PASSWORDS_ON_LEAVE);
      const before = state.message || "";
      // Once, and only once: a refusal is reported, never tried again.
      if (!(await evalIn(tabId, SUBMIT))) await chrome.debugger.sendCommand({ tabId }, "Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
      // SAP answers with a new page, or with a new message on this one.
      state = await watch(tabId, LOGON_TIMEOUT_MS, (s) => {
        if (isApp(s) || s.kind === "multi" || s.kind === "password_change" || s.kind === "sap_error") return s;
        if (s.kind === "logon" && s.loaded && (!s.mark || (s.message && s.message !== before))) return s;
        if (s.host && s.host !== host && s.kind !== "loading") return { ...s, kind: "identity_provider" };
        return null;
      });
    }
    if (state.kind === "multi") {
      if (otherLogons !== "keep") throw fail("multiple_logon", { tabId });
      if (!(await evalIn(tabId, KEEP_OTHER_LOGONS))) throw fail("multiple_logon", { tabId });
      await sleep(1000);
      state = await watch(tabId, LOGON_TIMEOUT_MS, (s) => (isApp(s) || s.kind === "password_change" || s.kind === "sap_error" || (s.kind === "logon" && s.loaded) ? s : null));
    }
    if (state.kind === "sap_error") throw fail("sap_error", { tabId, sapMessage: state.message });
    if (state.kind === "password_change") throw fail("password_change", { tabId, sapMessage: state.message });
    if (state.kind === "identity_provider") throw fail("identity_provider", { tabId, host: state.host });
    if (state.kind === "logon") throw fail(refusalOf(state.message), { tabId, sapMessage: state.message || "" });
    if (isApp(state)) return { ...base, state: "logged_on", tabId };
    throw fail("timeout", { tabId });
  } finally {
    logonTabs.delete(tabId);
    // Before the tab is shared again: no password left in any field. A tab that still shows a password
    // field (SAP's logon page after a refusal, a new-password form, a sign-in page) is not shared at all:
    // the user may type there. It stays private until the field is gone.
    let keep = false;
    if (ownAttach) {
      await evalIn(tabId, CLEAR_PASSWORDS).catch(() => {});
      const st = await probe(tabId);
      keep = st.unreadable || PASSWORD_KINDS.includes(st.kind);
      if (!keep) await chrome.debugger.detach({ tabId }).catch(() => {});
    }
    if (keep) guardTab(tabId, { attachedOwn: true });
    else {
      privateTabs.delete(tabId);
      persistPrivate();
      invalidateTargets();
      await scheduleRecompute();
    }
  }
}

// After opening the system's address: SAP's logon page, a logged-on page, one of SAP's questions, or an
// identity provider (another host) that keeps its page up.
async function arrive(tabId, host, isApp) {
  let away = 0;
  return watch(tabId, LOGON_TIMEOUT_MS, (s) => {
    if (isApp(s)) return s;
    if (s.host === host && ["logon", "multi", "password_change", "sap_error"].includes(s.kind)) return s;
    if (s.host && s.host !== host && s.kind !== "loading") {
      // A sign-in form there, or the same page for a while: the provider waits for the user.
      away = away || Date.now();
      if (s.kind === "logon" || s.kind === "password_form" || Date.now() - away > IDP_WAIT_MS) return { ...s, kind: "identity_provider" };
    } else away = 0;
    return null;
  });
}

// Runs f with the extension's debugger on the tab: the server's attachment when the tab is shared, else a short one of its own.
async function withOwnDebugger(tabId, f) {
  if (attached.has(tabId)) return f();
  await chrome.debugger.attach({ tabId }, "1.3");
  try {
    return await f();
  } finally {
    await chrome.debugger.detach({ tabId }).catch(() => {});
  }
}

async function focusTab(tabId) {
  const tab = await chrome.tabs.update(tabId, { active: true }).catch(() => null);
  if (tab && typeof tab.windowId === "number") await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
}

function noteAgentTab(tabId) {
  agentTab = { tabId, at: Date.now() };
}

// ---------------------------------------------------------------- popup

const AGENT_TAB_FRESH_MS = 10 * 60 * 1000;

async function popupState(tabId) {
  const cfg = await getConfig();
  const { allowed, all } = await computeAllowed();
  const h = await helperInfo();
  let currentTab = null;
  if (Number.isInteger(tabId) && all.has(tabId)) {
    const t = all.get(tabId);
    const system = cfg.systems.find((x) => tabOfSystem(x, t.url)) || null;
    currentTab = { tabId, title: t.title, shared: allowed.has(tabId), system: system ? system.id : null, suggestion: system ? null : suggestionFor(t) };
  }
  const shared = [...attached].map((id) => allowed.get(id)).filter(Boolean);
  let agent = null;
  if (ws && agentTab && Date.now() - agentTab.at < AGENT_TAB_FRESH_MS && allowed.has(agentTab.tabId)) {
    const t = allowed.get(agentTab.tabId);
    const system = cfg.systems.find((x) => tabOfSystem(x, t.url));
    agent = { tabId: agentTab.tabId, title: t.title, system: system ? system.name : null };
  }
  const targets = [...all.values()];
  await panelRestored;
  return {
    status: status.state,
    port: status.port,
    code: { set: !!cfg.code, managed: cfg.codeManaged, managedInvalid: cfg.codeManagedInvalid },
    helper: h,
    portSetting: { value: cfg.port, managed: cfg.portManaged },
    paused: cfg.paused,
    managedOrigins: scope.managed,
    // Open: a tab the user can switch to; a tab held back at a logon page counts as not open.
    systems: cfg.systems.map((x) => ({ ...x, kind: x.kind || kindOf(x.url), open: targets.some((t) => tabOfSystem(x, t.url) && !privateTabs.has(t.tabId)), loggingOn: logons.has(x.id) })),
    shared,
    agent,
    agentInfo: panelInfo,
    activity,
    currentTab,
    version: EXT_VERSION,
  };
}

function cleanSystemInput(input) {
  const name = String(input.name || "").trim().slice(0, 60);
  if (!name) throw new Error("Give the system a name.");
  let url;
  try {
    url = new URL(String(input.url || "").trim());
  } catch {
    throw new Error("The address must be a full URL, such as https://sap.example.com/sap/bc/ui2/flp.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("The address must start with https:// or http://.");
  const client = String(input.client || "").trim();
  if (client && !/^\d{3}$/.test(client)) throw new Error("The client has three digits, such as 100.");
  const language = String(input.language || "").trim().toUpperCase();
  if (language && !/^[A-Z0-9]{1,2}$/.test(language)) throw new Error("The language is SAP's one- or two-letter key, such as EN or DE.");
  const user = String(input.user || "").trim().toUpperCase().slice(0, 40);
  return { name, url: url.toString(), kind: kindOf(url.toString()), client, language, user, sso: !!input.sso };
}

async function handlePopup(msg) {
  switch (msg && msg.cmd) {
    case "wake":
      ensureConnected({ force: true }); // the popup opened: look for a server now, not at the next retry
      return { ok: true };
    case "state":
      return popupState(msg.tabId);
    case "pair": {
      const r = await pairWithHelper();
      if (r.ok) reconnect();
      return r;
    }
    case "setCode": {
      const code = normalizeCode(msg.code);
      if (!code) {
        await chrome.storage.local.remove("pairingCode");
        return { ok: true, code };
      }
      if (code.length !== CODE_LENGTH) throw new Error(`A pairing code has ${CODE_LENGTH} letters and digits; this one has ${code.length}.`);
      await chrome.storage.local.set({ pairingCode: code });
      return { ok: true, code };
    }
    case "saveSystem": {
      // The popup asked Chrome for the site (chrome.permissions.request) in the click itself.
      const fields = cleanSystemInput(msg.system || {});
      const pattern = systemPattern(fields.url);
      if (!(await chrome.permissions.contains({ origins: [pattern] }))) throw new Error("Chrome did not allow the extension on this site.");
      const list = await getSystems();
      const old = msg.system.id ? list.find((x) => x.id === msg.system.id) : null;
      if (list.some((x) => x !== old && x.name.toLowerCase() === fields.name.toLowerCase())) throw new Error(`There is a system named ${fields.name} already.`);
      const sys = { ...(old || { id: newId(), passwordIn: null }), ...fields };
      // A password never follows a system to another address (host, scheme or port): it was saved for the old one.
      const moved = old && old.passwordIn && new URL(old.url).origin !== new URL(fields.url).origin;
      if (moved && !(typeof msg.password === "string" && msg.password !== "")) {
        await forgetPassword(old);
        sys.passwordIn = null;
      }
      // The user acted on what SAP said last (a new password, another user or client): the next logon may try.
      delete sys.logonIssue;
      if (fields.sso) {
        if (old && old.passwordIn) await forgetPassword(old);
        sys.passwordIn = null;
      } else if (typeof msg.password === "string" && msg.password !== "") {
        sys.passwordIn = await savePassword(sys, msg.password);
      } else if (msg.clearPassword && old && old.passwordIn) {
        await forgetPassword(old);
        sys.passwordIn = null;
      }
      await putSystems(old ? list.map((x) => (x.id === old.id ? sys : x)) : [...list, sys]);
      scheduleRecompute();
      return { ok: true, id: sys.id, passwordIn: sys.passwordIn };
    }
    case "deleteSystem": {
      const list = await getSystems();
      const sys = list.find((x) => x.id === msg.id);
      if (!sys) return { ok: true };
      await forgetPassword(sys);
      const rest = list.filter((x) => x.id !== sys.id);
      await putSystems(rest);
      const pattern = systemPattern(sys.url);
      // The site stays allowed while another system is on it, or while the organization allows it.
      if (!rest.some((x) => systemPattern(x.url) === pattern) && !scope.managed.includes(pattern)) await chrome.permissions.remove({ origins: [pattern] }).catch(() => {});
      scheduleRecompute();
      return { ok: true };
    }
    case "openSystem": {
      try {
        const r = await logonSystem(msg.id, { by: "user" });
        if (r.tabId) await focusTab(r.tabId);
        return { ok: true, state: r.state, message: r.message || "" };
      } catch (e) {
        return { ok: false, error: e.message || String(e), reason: e.reason || "" };
      }
    }
    case "setPort": {
      const p = msg.port === null || msg.port === "" ? null : Number(msg.port);
      if (p === null) await chrome.storage.local.remove("port");
      else if (Number.isInteger(p) && p > 0 && p < 65536) await chrome.storage.local.set({ port: p });
      else throw new Error("invalid port");
      return { ok: true };
    }
    // Sharing stops only from Chrome's own bar (Cancel on "started debugging this browser"); the panel shares again.
    case "resume":
      await chrome.storage.local.set({ paused: false });
      return { ok: true };
    case "clearActivity":
      activity = [];
      await chrome.storage.session.set({ activity }).catch(() => {});
      return { ok: true };
    case "unpair":
      await chrome.storage.local.remove("pairingCode");
      reconnect();
      return { ok: true };
    case "reconnect":
      reconnect();
      return { ok: true };
    default:
      throw new Error("unknown command");
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return false;
  handlePopup(msg).then(sendResponse, (e) => sendResponse({ error: e.message || String(e) }));
  return true;
});

// ---------------------------------------------------------------- wake-ups and scope changes

function onTabEvent() {
  invalidateTargets();
  scheduleRecompute();
  ensureConnected();
}

chrome.tabs.onCreated.addListener(onTabEvent);
chrome.tabs.onUpdated.addListener(onTabEvent);
chrome.tabs.onReplaced.addListener(onTabEvent);
chrome.tabs.onRemoved.addListener((tabId) => {
  recentlyClosed.add(tabId);
  onTabEvent();
});

chrome.permissions.onAdded.addListener(() => scheduleRecompute());
chrome.permissions.onRemoved.addListener(() => scheduleRecompute());

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" || area === "managed") {
    if ("pairingCode" in changes || "port" in changes) reconnect();
    if ("paused" in changes || "allowedOrigins" in changes || "sites" in changes || "systems" in changes) scheduleRecompute();
  }
});

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === ALARM) ensureConnected();
});

async function ensureAlarm() {
  if (!(await chrome.alarms.get(ALARM))) await chrome.alarms.create(ALARM, { periodInMinutes: 0.5 });
}

chrome.runtime.onStartup.addListener(() => {
  ensureAlarm();
  ensureConnected({ force: true });
});
// The toolbar icon opens the side panel: a column beside the page, open while the user works.
function panelOnClick() {
  if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
}
panelOnClick();

chrome.runtime.onInstalled.addListener(() => {
  panelOnClick();
  ensureAlarm();
  ensureConnected({ force: true });
});

// Worker (re)start: no socket survives a restart, so release old attachments
// first, then connect.
const bootInfo = { at: Date.now(), released: [] };
// Held tabs come back before the relay may ask anything (an alarm can connect before the boot is through).
const privateRestored = restorePrivate().catch(() => {});
const booted = (async () => {
  await ensureAlarm().catch(() => {});
  bootInfo.released = await releaseLeftovers().catch((e) => (console.warn("releaseLeftovers", e), []));
  await privateRestored;
  await migrateSites().catch((e) => console.warn("migrateSites", e));
  await migrateProfilePasswords().catch(() => {});
  await readScope().catch(() => {});
  await ensureConnected({ force: true });
})();

// For tests and for inspecting the worker from chrome://extensions.
globalThis.bridge = {
  booted,
  bootInfo,
  status: () => ({ ...status, attached: [...attached], known: [...known.keys()], children: Object.fromEntries([...children].map(([t, k]) => [t, [...k.keys()]])) }),
  reconnect,
  command: handlePopup,
  normalizeCode,
};
