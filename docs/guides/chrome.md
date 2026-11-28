---
title: "SAP Web GUI and Fiori in Chrome for AI agents"
description: "How the server reads and drives SAP GUI for HTML and SAP Fiori in Chrome: the SAP window, your own Chrome, or the SAP UI MCP extension."
---

# Chrome: Web GUI and Fiori

The server reads and drives SAP GUI for HTML (Web GUI) and SAP Fiori in
Google Chrome, in one of three browser modes. This works on Windows, macOS
and Linux, and needs nothing on the SAP system. You log on to SAP yourself;
the server never does (with the Chrome extension, the extension can log on
for you).

## Choose a browser mode

`SAP_BROWSER` says which Chrome the server works in. Set it in the `env` of
the server in your MCP client, or in the shell before a CLI command.

| Mode | Which Chrome | What you do once | What the server can see |
| --- | --- | --- | --- |
| `launch` (default) | a Chrome window the server starts, with a profile of its own (the SAP window) | log on to SAP in that window | only that window |
| `attach` | your running Chrome or Edge | allow remote debugging in `chrome://inspect` | every tab of that browser; it reads only SAP tabs |
| `extension` | your everyday Chrome, through the SAP UI MCP extension | install and pair the extension, register your SAP systems | only the tabs of the systems you registered |

- Start with `launch`: nothing to switch on in Chrome.
- Use `extension` when you want your normal profile and its single sign-on,
  or want the extension to log on for you with a saved password.
- Use `attach` for a Chrome you already work in, when you cannot install
  the extension.

`SAP_CHROME_CDP`, when set, wins over all three ([below](#a-chrome-started-with-a-debugging-port)).
Each mode is checked by `npx -y sap-ui-automation doctor`.

## The SAP window (`launch`, the default)

1. Install Google Chrome if it is not there. The server looks for Chrome in
   the usual places (on Linux also Chromium); `SAP_CHROME_PATH` names
   another one.
2. Run `npx -y sap-ui-automation browser`. A Chrome window opens.
3. Open your Web GUI or Fiori launchpad address there and log on.

The agent opens the same window by itself the first time it needs SAP, so
step 2 is optional. The window keeps its own profile (cookies, logons) in
`~/.local/share/sap-ui-automation/chrome` on Linux,
`~/Library/Application Support/sap-ui-automation/chrome` on macOS and
`%LOCALAPPDATA%\sap-ui-automation\chrome` on Windows, so you log on once and
the next session starts logged on where SAP allows it. It opens on the last
SAP address it saw, or on `SAP_START_URL`.

The server never closes this window: closing it is up to you. Only its tabs
are looked at; your everyday Chrome is left alone.

| Variable | Effect |
| --- | --- |
| `SAP_CHROME_PATH` | the Chrome or Chromium program file, when the server does not find it |
| `SAP_START_URL` | the address a new SAP window opens on |
| `SAP_CHROME_PROFILE` | another profile folder for the SAP window |
| `SAP_CHROME_ARGS` | extra Chrome switches, separated by spaces |

## Your Chrome with remote debugging (`attach`)

Set `SAP_BROWSER=attach`. Then, in Chrome 144 or later:

1. Open `chrome://inspect/#remote-debugging`.
2. Tick **Allow remote debugging for this browser instance**.
3. Run `SAP_BROWSER=attach npx -y sap-ui-automation doctor`. Chrome asks you
   to allow the connection: click **Allow**. You have 45 seconds.

Chrome asks for each new connection. The server keeps one connection open
while it runs, so Chrome asks again only when the server connects anew (it
was restarted, or the connection dropped).

The server tries Chrome stable first, then Chrome Beta, then Microsoft
Edge. Chrome writes its port to a file named `DevToolsActivePort` in its
profile folder, and the server reads it there.

The server does not attach to port 9222 by itself: a browser listening
there may belong to another tool (a test runner, another agent). One
exception: on macOS, privacy protection may stop the app that runs the
server from reading Chrome's `DevToolsActivePort` file. The server then
uses port 9222 only when Chrome's or Edge's own process listens there.
Otherwise `doctor` asks you to give that app (Terminal or iTerm for
`doctor`; Claude, Codex or your editor for the MCP server) Full Disk Access
in System Settings → Privacy & Security, and to restart it.

### A Chrome started with a debugging port

To use a Chrome started with `--remote-debugging-port`, name it with
`SAP_CHROME_CDP`. Since Chrome 136 that switch only opens the port together
with `--user-data-dir`, pointing to a directory other than Chrome's default
one:

```sh
chrome --remote-debugging-port=9333 --user-data-dir="$HOME/chrome-sap"
SAP_CHROME_CDP=http://127.0.0.1:9333 npx -y sap-ui-automation sessions
```

This is also the way for a Chrome older than 144, which has no switch in
`chrome://inspect`. Nothing else is tried when `SAP_CHROME_CDP` is set.

### Microsoft Edge

Edge (also Chromium) is found the same way, after Chrome stable and beta,
and is likely to work. Firefox and Safari are not supported.

## Use your everyday Chrome with the extension

With `SAP_BROWSER=extension` the server reaches your Chrome through the
**SAP UI MCP** extension: no `chrome://inspect` switch, your
normal profile with its single sign-on, and only the tabs of the SAP systems
you register are shared. The extension can also keep your systems' logons:
the agent can say "log on to ECC Dev", and the extension types the password
into SAP's logon page itself. The agent and the server never see it.

### Install the extension

1. Add **SAP UI MCP** to Chrome from the
   [Chrome Web Store](https://chromewebstore.google.com/detail/ui-automation-for-sap/geglpbkaklfpmnbidfcpflegmdkjodkn).
2. Run `npx -y sap-ui-automation setup --extension`. In one go it adds the
   server with `SAP_BROWSER=extension` to the coding agents it finds
   ([setup](../reference/cli.md#setup); `setup vscode --extension` for VS
   Code and GitHub Copilot), installs the skills, and installs the
   extension's helper, which pairs the extension in one click and keeps
   saved passwords in your system's keychain.
3. Restart Chrome once (Chrome finds the helper at start) and your agent
   apps. Pin the extension's icon (puzzle piece, then the pin).

`npx -y sap-ui-automation extension helper` installs the helper alone.

Chrome updates the store's copy by itself.

**Without the store** (a company policy that blocks it, or to try changes
to the extension): run `npx -y sap-ui-automation extension install`, which
copies the extension to `~/sap-ui-automation-extension` (or the folder you
name after `install`) and installs the helper. Then in `chrome://extensions`
turn on **Developer mode**, click **Load unpacked** and pick that folder.
To update that copy, run `npx -y sap-ui-automation@latest extension
install` again and click the reload arrow on the extension's card.

### Pair and register your systems

1. Click the SAP UI MCP icon: it opens a side panel beside the
   page. Click **Pair**. (Without the helper: run
   `npx -y sap-ui-automation extension pair`, open **Pair with a code
   instead** in the panel and paste the code.)
2. Open your SAP system in a tab and click **Add this SAP page** in the
   panel. Add user and password if the extension should log on for you.
3. If you have not run `setup --extension` yet, do it now. It adds
   `SAP_BROWSER=extension` to an existing `sap-ui-automation` entry too,
   and names the ones it cannot change (Claude Code's, Goose's) with what
   to do ([details](../reference/cli.md#extension-and-an-entry-that-is-already-there)).
   Then restart the agent app.
4. Check: `SAP_BROWSER=extension npx -y sap-ui-automation doctor`. It waits
   up to 35 seconds for the extension to connect.

The agent then also has `sap_systems` (your registered systems) and
`sap_logon` (open one and log on). For parallel work, `sap_logon` with
`newSession: true` opens another session in a window of its own, on the
same system or another.

The side panel shows what the agent does in SAP, step by step, and when it
waits for your yes to save. While the server works in a tab, Chrome shows
"SAP UI MCP started debugging this browser". Clicking **Cancel**
there stops the sharing until you click **Share again** in the side panel.
`npx -y sap-ui-automation extension uninstall` removes the helper, the
saved passwords and the copied folder. See
[extension/README.md](https://github.com/DidroAI/sap-ui-mcp/blob/main/extension/README.md)
for what happens on a wrong password or a locked user, where passwords are
kept, permissions, IT deployment and limits. The extension is not
affiliated with SAP SE.

## Which tabs are SAP's

Each tab has one owner, decided in one place:

- **Web GUI:** the address path contains `/sap/bc/gui/sap/its/webgui`, or
  the page holds Web GUI's own controls;
- **Fiori:** SAPUI5 runs in the page, and it is a launchpad: an address
  under `/sap/` (`/sap/bc/ui2/flp`), or the launchpad shell (`sap.ushell`)
  in the page, as on SAP BTP where the address says nothing;
- any other tab is left alone. Only `http` and `https` pages are looked
  at, never `chrome://` pages or extensions.

A page that merely runs SAPUI5 is not taken for Fiori. A Web GUI tab that
moves to the launchpad belongs to Fiori from then on, and the reverse.

The server reads system, client and user from the page, and `sap_sessions`
shows each tab's origin. Chrome does not tell a tab's position, so tabs are
named by their title.

## What remote debugging gives away

In `attach` mode, and with `SAP_CHROME_CDP`, remote debugging gives the
server (and so the agent using it) access to every tab of that browser, not
only SAP tabs. The SAP window (`launch`) holds only what you open in it, and
the extension shares only your registered systems' tabs. The server only
reads tabs it recognises as SAP, but in `attach` mode:

- consider a separate Chrome profile for SAP work;
- set `SAP_ALLOW_ORIGINS` to look only at your SAP hosts, for example
  `SAP_ALLOW_ORIGINS=https://myhost:44300`. Tabs of other origins are then
  not read at all.

Closing the server never closes your browser: it only disconnects. Dialogs
the page opens itself (such as "Leave site?") stay for you to answer. See
also [Security and data handling](../security.md).

## Web GUI

Web GUI shows SAP GUI screens in the browser, and the server reads them as
it reads SAP GUI for Windows: the same view, ids and actions. Open a Web GUI
tab and log on; its address contains `/sap/bc/gui/sap/its/webgui`.

- **Background tabs.** Chrome draws a tab that is not in front about once a
  second, and hands it clicks and keys just as slowly. The server notices
  and waits longer (two to three seconds per action instead of one). It
  works, but a tab in front, or a window of its own, is faster.
- **Files.** Web GUI keeps a file that SAP writes "to a local file" (List →
  Export → Local File) inside the browser. The server copies it to
  `SAP_DOWNLOAD_DIR` (default: `downloads` in `SAP_RECORD_DIR` when that is
  set, else `./sap-downloads`), and the answer of the action names the
  copy.
- **Menus.** `sap_look` with `id: "mbar"` lists every menu entry with its
  id.
- **When SAP does not answer.** An action waits up to 180 seconds (or its
  `timeout`, up to 600), then says that SAP is still working. If the
  connection to SAP drops, the action says that the request failed; the
  page then needs a reload. A session that timed out shows as a `WINDOW
  browser` with a note.

## Fiori

Open the Fiori launchpad (for example `/sap/bc/ui2/flp`) and log on.

### Opening a Fiori app

`{"do": "open", "app": "#SalesOrder-manage"}` opens a launchpad app by its
intent: the part of the app's address after `#`, with parameters if you
need them (`"#SalesOrder-display?SalesOrder=4711"`). The server sets the
launchpad's hash, as a bookmark of the app does, so the tab stays on the
launchpad it is on and on its logon; a URL is refused.

Opening an app is navigation for the guard, and `SAP_ALLOW_TCODES` and
`SAP_BLOCK_TCODES` are checked against the intent before it is opened. An
intent that carries a function code for a transaction (`DYNP_OKCODE`)
counts as a write. When the user may not open the app, the launchpad says
so in a popup, and the answer holds it.

### Working in an app

- `press` and `click` both press a control; `set`, `select`, `check`,
  `combo`, `key`, `f4` and `scroll` work as on the other surfaces.
- `key` `Back` presses the launchpad's back button and never leaves the
  launchpad.
- `sap_look` with an `id` reads that one control whole, also the part of a
  table below the fold; `rows` is not used on Fiori.
- `scroll` scrolls a table or the page when the view ends with `SCROLL`.
- SAP's messages appear as toasts and popovers, not in a status bar.
- A Web GUI app opened inside the launchpad is read and driven like Web
  GUI, inside the Fiori tab; `okcode`, `tree`, `grid` and `toolbar` work
  there. The transaction lists do not check it by its transaction code.
- In a draft-enabled app, typing into a field saves the draft on the
  server at once. The guard does not count that as a write; activating the
  draft (Save, Create) is one.

### Logon and password pages

A tab at a launchpad address that shows no launchpad (SAP's logon page, its
page to change the password, a tab that does not answer) is listed by
`sap_sessions` with a title that says so; a look names the page, and every
action there is refused: you have to finish it yourself.

### Waits

The server waits for Fiori to be idle after each action: busy indicators
and UI5's own test support (RecordReplay). `SAP_FIORI_WAIT=busy` waits for
busy indicators only, which is faster.

## What `doctor` checks

- Chrome: in `launch` mode, where Chrome is and whether the SAP window
  runs; in `attach` mode and with `SAP_CHROME_CDP`, which browser it
  attached to, its version, and how; in `extension` mode, whether the
  extension is installed, paired and connected;
- the origins `SAP_ALLOW_ORIGINS` allows, when set;
- how many web page tabs are open;
- the Web GUI tabs, with system, client and transaction;
- the Fiori tabs, with SAPUI5 version, system, client and user.

When no Chrome is found, it says the one step to take. Each failure and
its fix: [FAQ and troubleshooting](../faq.md#troubleshooting-chrome-web-gui-and-fiori).

## Limits

- Chrome is supported; Microsoft Edge is found the same way and is likely
  to work; Firefox and Safari are not.
- Web GUI in a background tab is slower (see above).
- Lists scroll down and up, not sideways: a grid wider than the screen
  shows the columns SAP has drawn.
- Web GUI draws only the tree nodes in view; a node further down is reached
  by scrolling the tree first.
- Record and replay have been run on Web GUI; not yet on Fiori
  ([Recording and replay](record-replay.md)).
- Safe and commit words are known in a handful of languages; in others
  more actions are held ([Safety model](../concepts/safety.md)).
