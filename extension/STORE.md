# Chrome Web Store: listing and release notes

What to paste into the developer dashboard, and what to do once per release.
The extension is distributed unpacked until the first store release.

## Listing

- **Name:** SAP UI MCP
- **Summary (132 characters max):** Let AI agents see and interact with SAP screens from Chrome. Passwords stay in your keychain. Not affiliated with SAP SE.
- **Category:** Developer Tools (alternative: Workflow & Planning)
- **Description:**

  > SAP UI MCP lets your AI agent work in SAP the way your team does: in Chrome, in Web GUI and Fiori, with your own logon and authorizations.
  >
  > Hand it the repetitive work (looking up orders, checking documents, entering and updating data) and follow every step in a side panel next to your SAP tabs. Saves wait for your approval.
  >
  > Built for SAP screens, not a generic browser driver. In our benchmark of over 1,600 runs of SAP Web GUI and Fiori tasks, with a similar success rate:
  > • about 3.5x cheaper per task than Playwright MCP
  > • nearly 3x faster than computer use
  >
  > • Register each SAP system once: your agent opens it and logs on by itself.
  > • Your password stays in your operating system's keychain. The agent never sees it.
  > • Works with Claude Code, Codex, Cursor and any MCP client, through the open-source sap-ui-automation package (npx -y sap-ui-automation setup --extension).
  >
  > Not affiliated with or endorsed by SAP SE. SAP, SAP Fiori and SAP S/4HANA are trademarks of SAP SE.

  Figures: bench/docs/pilot-haiku-2026-11-23-compare.md (claude-haiku-5-5,
  procedure mode, 1,673 runs): cost per run $0.0063 against $0.0217 for
  Playwright MCP (3.4x); 31 s against 85 s for computer use (2.7x); success
  86% against 90% and 89%. Update the figures when the benchmark is
  published.

- **Privacy policy URL:** https://github.com/DidroAI/sap-ui-mcp/blob/main/extension/PRIVACY.md
- **Homepage / support:** https://github.com/DidroAI/sap-ui-mcp (issues for support)

## Single purpose

"Let a local AI agent open, log on to and operate the SAP systems the user
registered, in the user's own Chrome." Saving logons is part of that purpose:
it is how the agent opens a system without ever holding the password.

## Permission justifications

| Permission | Justification |
| --- | --- |
| `debugger` | Attaches only to tabs of the SAP systems the user registered (and granted site access to), to let the user's local automation server (127.0.0.1, paired with a one-time code) read and operate SAP's screens through the DevTools Protocol, and to type the user's saved SAP password into SAP's logon page. It never attaches to other tabs, and refuses commands that reach other sites, cookies or the browser. |
| `nativeMessaging` | Talks to the extension's own helper (installed by the user with npm) to read the local pairing code and to keep SAP passwords in the operating system's keychain instead of the browser. |
| `storage` | Keeps the user's list of SAP systems and settings in `chrome.storage.local` (never sync). |
| `sidePanel` | Shows the extension's interface in Chrome's side panel, next to the user's SAP tabs: the SAP systems the user registered (to add, open or log on to them), each step the user's agent takes in SAP, and its requests to save, so the user can follow and stop the agent while it works. |
| `alarms` | Wakes the service worker every 30 seconds to reconnect to the local server when the user's agent starts. |
| Optional host permissions `http://*/*`, `https://*/*` | Requested one site at a time, at the moment the user saves an SAP system, for that system's host only. Never requested for all sites; patterns matching every host are ignored. |

Remote code: none. Every script is in the package; the scripts the extension
runs in SAP pages through `chrome.debugger` are part of it (`background.js`).
It also relays DevTools Protocol commands from the user's own local
automation server (127.0.0.1, paired with a one-time code), which is the
`debugger` API's documented purpose. Those commands are limited by the
extension, not trusted: only to tabs of the systems the user registered,
never to other targets or the browser, with a deny-list for cookies,
storage and responses of other sites, request interception and
navigation elsewhere, and never to a tab that shows a password field. The
rules and their tests are listed in `PROTOCOL.md` ("Scope", "Pages with a
password field are never shared"). Other DevTools-bridge extensions for
local automation (such as Playwright's MCP bridge) follow the same model.

## Data use form

- Collects: **Authentication information** (SAP passwords, kept in the OS
  keychain on the device), **Website content** (pages of registered SAP
  systems, passed to the local server only).
- Certify: not sold; not used or transferred for purposes unrelated to the
  single purpose; not used for creditworthiness or lending.

## Assets

- Icon: `icons/128.png` (the SAP UI MCP icon: a navy tile with the SAP
  logo and a pointer). Every size (16, 32, 48, 128) is scaled from
  `assets/readme-icon.png`.
- Screenshots (1280×800): the side panel beside a page (working, asking to
  save, logging on and a rejected password, first run, settings), made against made-up SAP
  pages for each release and placed on a plain background; never SAP's logo
  or a real customer system.
- Small promo tile (440×280): the mark and the name, no SAP blue gradient or
  SAP logo.
- Both are made by `SAP_TEST_CHROME=<chrome> node scripts/extension-screenshots.mjs`
  into `store-assets/` (not committed): the real side panel, fed made-up systems on
  `sap.example.com`.

## The extension id

- The unpacked id is `ojokfbbfoignpfeamomeappgfhapehma`, fixed by `key` in
  `manifest.json`. The native helper allows only the ids in `EXTENSION_IDS`
  (`src/browser/extension/native.ts`).
- The store's id is `geglpbkaklfpmnbidfcpflegmdkjodkn`, given at the first
  upload (2026-11-25; the private key behind the unpacked id is not kept, so
  the store could not keep that one). It is in `EXTENSION_IDS` too.
- A new store id (Edge Add-ons always gives its own) goes into
  `EXTENSION_IDS`, and the npm package with it is released before the
  store version is published.

## Building the upload

```sh
npm run pack:extension                      # ui-automation-for-sap-<version>.zip
```

The zip holds what the extension runs, `LICENSE` and `PRIVACY.md`; the
manifest goes without `"key"`. Store users install only the helper:
`npx -y sap-ui-automation extension helper`.

## Versions

The extension has its own version (`manifest.json`), raised with every
upload; the npm package has its own. `minimum_chrome_version` is 132 because
the extension relies on the `Page.frameStartedNavigating` event (Chrome 132)
to detach a tab before it leaves the registered sites.
