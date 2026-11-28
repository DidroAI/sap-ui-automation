# SAP UI MCP

The Chrome extension of [sap-ui-automation](../README.md). It keeps your
SAP systems in one list, in the Chrome you use every day, and lets your
local AI agent (Claude Desktop, Claude Code, Codex…) open them and log on.

- **You** register each system once: a name, its address (Web GUI or the
  Fiori launchpad), client, language and, if you like, user and password.
  Then one click opens it, logged on.
- **Your agent** can list them and say "log on to ECC Dev" without knowing
  the address, and works in their tabs as you, with your SAP authorizations.

The agent never sees a password. The extension types it into SAP's logon
page itself, like a password manager, in a tab the agent cannot see. The
agent is only told "logged on as JDOE", or what SAP answered.

You keep your normal Chrome profile and its single sign-on, and you don't
turn on Chrome's remote debugging. Only the tabs of your registered systems
are shared with the agent, and nothing leaves your computer (see
[PRIVACY.md](PRIVACY.md)).

It works in Google Chrome 132 or later, and in Microsoft Edge and other
Chromium browsers. Not affiliated with or endorsed by SAP SE. SAP, SAP
Fiori and SAP S/4HANA are trademarks of SAP SE.

## Install (Mac, Windows, Linux)

Add it from the [Chrome Web Store](https://chromewebstore.google.com/detail/ui-automation-for-sap/geglpbkaklfpmnbidfcpflegmdkjodkn)
(search for "SAP UI MCP"), then run
`npx -y sap-ui-automation setup --extension`: it sets up your agent apps
and the skills, and installs the extension's helper. You need Node.js 22
or later (`node --version` in a terminal; if it is missing, install it from
nodejs.org).

To load it unpacked instead (a company policy that blocks the store, or to
work on the extension):

1. In a terminal, run:

   ```sh
   npx -y sap-ui-automation extension install
   ```

   It copies the extension to `~/sap-ui-automation-extension` (or to the folder
   you name after `install`), and installs its **helper**: a small program
   Chrome starts for this extension only. The helper pairs the extension
   with your agent in one click and keeps saved passwords in your keychain.
2. In Chrome, open `chrome://extensions` and switch on **Developer mode**
   (top right).
3. Click **Load unpacked** and pick that folder. On a Mac, press
   Cmd+Shift+G in the dialog and type `~/sap-ui-automation-extension`.
4. Click the puzzle-piece icon in Chrome's toolbar, then the pin next to
   **SAP UI MCP**, so it is one click away. If Chrome
   was open while you ran step 1, restart it once (Chrome finds the helper
   at start).

## Pair

Click the SAP UI MCP icon: the extension opens as a side panel,
a column beside the page that stays open while you work. Click **Pair**.
That's all: the helper gives the extension the code your agent's server uses.

Without the helper, pair by hand: run `npx -y sap-ui-automation extension
pair`, open **Pair with a code instead** in the panel and paste the code.

The panel then says **Ready. No agent connected.** Once an agent connects it
names it ("Codex is connected"), says whether saves wait for your yes, and
lists each step the agent takes in SAP (**Activity**): the transaction, the
field and the value, in SAP's own words. When the agent waits for your yes to
save, the panel turns blue and says where to answer (in the agent app). The
system the agent works in is tinted blue; **Settings** shows what
the agent may do (saves, systems, blocked transactions), as set in the agent.

## Add your systems

Open your SAP system in a tab and click **Add this SAP page** in the panel: the address,
client and language come from the page. Give it a name, add your user and
password if the extension should log on for you, and click **Save**. Chrome
asks once to allow the extension on that site. Or click **Add System** (or
**Enter Address Instead**) and type the address.

- **Use Single Sign-On**: tick it and leave user and password out. The
  extension opens the address and SAP logs you on by itself.
- **No password saved**: the extension opens the logon page and you type it.
- **Log On** (with a saved password) or **Open** opens the system in a new
  tab; **Show Tab** brings its open tab to the front.
- The **More** button (three dots) edits the system, opens it without
  logging on, forgets its password or removes it.
- An address that starts with `http://` is not encrypted: the form warns
  you before you save a password for it.

## Tell your agent to use it

Set `SAP_BROWSER` to `extension` in your agent's settings for
sap-ui-automation. For Claude Desktop (Settings → Developer → Edit Config):

```json
{
  "mcpServers": {
    "sap-ui-automation": {
      "command": "npx",
      "args": ["-y", "sap-ui-automation"],
      "env": { "SAP_BROWSER": "extension", "SAP_WRITE": "off" }
    }
  }
}
```

Quit and reopen Claude Desktop. The agent then has two more tools:
`sap_systems` lists your systems, and `sap_logon` opens one and logs on.
`SAP_WRITE=off` keeps it to reading: saving and posting in SAP are refused
(the default, `confirm`, would ask you first; see the main README).

To check the setup, run:

```sh
SAP_BROWSER=extension npx -y sap-ui-automation doctor
```

(Close the agent app first: one server at a time can hold the extension.)

## When SAP says no

The extension submits SAP's logon form once per request, and never guesses.

| SAP says | The panel shows | What to do |
| --- | --- | --- |
| Wrong user name or password | "SAP refused the saved password." | Click **Update Password** and save the right one. Until you do, the extension does not try that password again, so your user is not locked. |
| User is locked | "SAP says the user is locked." | Have it unlocked (your SAP administrator, SU01), then click **Log On**. |
| Password expired, choose a new one | "SAP asks for a new password." | Change it in the tab, then save the new one here. |
| You are already logged on elsewhere | "SAP asks whether to end your other logons." | Answer in the tab, or tell your agent to keep the other logons. The extension never ends them on its own. |
| A company sign-in page (Azure AD, Okta…) | "Sign in on your organization's sign-in page in the tab." | Sign in there; the extension types nothing on another site. |
| SAP's error page, e.g. "Log on with a dialog user" | "SAP answered with an error page." | The saved user cannot log on in a browser (an RFC or background user): save a dialog user. |

While a tab shows a password field (SAP's logon page, a new-password form,
a sign-in page), the agent cannot see it. When one of the agent's tabs comes
to SAP's logon page (a session timeout), the extension closes it and opens
the page again in a new tab the agent never had: log on there. The agent
gets the tab once you are logged on. Type your SAP password only in such a
tab, or in one you opened with **Log On** or **Open**: a page the agent works
in could show a password field of its own.

## Where your passwords are

- In your computer's keychain, through the helper: the macOS Keychain
  (entries named "sap-ui-automation: <system>"), the Secret Service on
  Linux, or a file protected with Windows DPAPI that only your Windows
  account can read.
- Without the helper (or with no keychain on the computer) the extension
  saves no password: you log on in the tab. Passwords saved by version 0.2
  in the Chrome profile move to the keychain once the helper is there.
- Never in Chrome sync, a log, the server or the agent. Remove a system, or
  move it to another address, and its password is deleted.
- **What the keychain does not protect against:** any program that runs as
  you can ask the keychain for these entries, as it can read your files. An
  agent that may run any command in a terminal (Claude Code's shell, for
  example) could too. Give such an agent no shell, or use single sign-on.

## What it can see and do

- **Permissions.** `debugger` (to drive the shared tabs and to type into the
  logon page), `storage`, `alarms` (to reconnect) and `nativeMessaging` (the
  helper). It asks for sites one at a time, when you save a system. You can
  see and remove them under *Site access* in `chrome://extensions`.
- **Which tabs.** Only http and https tabs of your registered systems are
  shared. A tab that navigates to another site is detached when the
  navigation starts, so nothing of that page reaches the agent. Frames and
  workers of other sites inside a shared tab are not shared either.
- **What the extension refuses.** Even on a shared tab, it refuses commands
  that reach beyond that tab: opening or closing tabs, the browser's cookie
  jar, other sites' cookies, storage and responses, request interception,
  reading a form that sends a password, and navigating the tab to a site you
  did not register.
- **How it reaches the agent.** The extension connects only to `127.0.0.1`,
  ports 47823 to 47830, or the one port set under **Settings**. Before it
  acts, the server must prove that it holds the pairing code; after that,
  every message is encrypted and authenticated. Web pages cannot connect.
- **The yellow bar.** While the agent works in your tabs, and while the
  extension logs on, Chrome shows "SAP UI MCP started
  debugging this browser". Clicking **Cancel** there stops sharing until
  you click **Share again** in the side panel.
- **"Chrome is being controlled by automated test software"** is not this
  extension. Chrome shows that bar when a program started it with
  `--enable-automation` (Playwright, Puppeteer and tools built on them do).
  The panel tells you once when that is the case.

## Update

```sh
npx -y sap-ui-automation@latest extension install
```

Then click the reload arrow on the extension's card in `chrome://extensions`,
and restart your agent app.

## Uninstall

```sh
npx -y sap-ui-automation extension uninstall
```

It removes the helper from every browser, the SAP passwords the extension
saved in your keychain, and the folder it installed the extension to. The
pairing code stays (in the server's settings folder), for the server. Then, in
`chrome://extensions`, click **Remove** on SAP UI MCP.
(Removing the extension in Chrome alone leaves the keychain entries.)

## When it doesn't connect

- **"Ready. No agent connected." but the agent says no extension connected:** is
  `SAP_BROWSER` set to `extension` in the agent's settings? Restart the agent
  app. A Chrome that was asleep connects within 30 seconds; opening the
  panel wakes it at once.
- **"Pair again":** this extension and your agent hold different codes; click **Pair**.
- **"Another agent app is connected":** another agent app holds the extension. Close it, then click
  **Reconnect** under **Settings**.
- **The helper stopped working after switching Node.js** (Homebrew, nvm,
  Volta): run the install command again.
- **Chrome is closed:** on a Mac or Windows the agent starts Google Chrome
  when it needs a system (turn that off with `SAP_EXTENSION_START_CHROME=off`).
  If you use the extension in Edge or another Chromium browser, open that
  browser yourself.

## For IT: deploy to a fleet

Managed storage (Chrome policy `3rdparty` → `extensions` → `<id>`) takes:

| Key | Effect |
| --- | --- |
| `allowedOrigins` | match patterns of SAP sites to share, e.g. `https://*.s4hana.example.com/*`. Users cannot remove them |
| `pairingCode` | the code the servers are started with (`SAP_EXTENSION_CODE`), so users don't pair by hand |
| `port` | the one port to use (the servers' `SAP_EXTENSION_PORT`) |

The schema is in `managed_schema.json`. The extension's id is
`geglpbkaklfpmnbidfcpflegmdkjodkn` from the Chrome Web Store, and
`ojokfbbfoignpfeamomeappgfhapehma` when loaded unpacked (fixed by the `key`
in its manifest).

- **Installing it for everyone** (`ExtensionInstallForcelist`) needs an
  update URL: the Chrome Web Store's (`geglpbkaklfpmnbidfcpflegmdkjodkn`), or a packed
  `.crx` with an `update.xml` you host. An unpacked extension cannot be
  force-installed; until then each user loads it as above.
- **The helper** is installed per user. Where `NativeMessagingAllowlist` is
  set, add `ai.didro.sap_ui_automation`. Where `NativeMessagingUserLevelHosts` is
  off, Chrome ignores per-user helpers: the helper's manifest must then go
  to the system folder (`/Library/Google/Chrome/NativeMessagingHosts` on a
  Mac, `HKLM\Software\Google\Chrome\NativeMessagingHosts` on Windows),
  which `extension install` does not write yet.

A pairing code has 26 characters; the extension refuses a shorter one. Every
user who can read the policy holds a `pairingCode` you push. On multi-user
hosts (Remote Desktop Services, Citrix), any user of the host could then act
as the server for the other users' browsers: don't push a shared code there,
let each user pair with their own. Patterns that match every host
(`https://*/*`, `<all_urls>`) in `allowedOrigins` are ignored.

## Limits

- **One server at a time.** A second agent app takes the next port and finds
  no extension; close the first one, or click **Reconnect** under
  **Settings**.
- **The agent opens tabs only through `sap_logon`**, for your registered
  systems. `/o` sessions and popup windows of a registered system are shared
  once they open.
- **Two systems on one address** (the same system with two users): the
  extension tells them apart by the user and client the page shows (the
  launchpad shows both; Web GUI only the client in its address).
- **Unpacked copies:** Developer mode shows a warning at each Chrome start,
  and some companies block unpacked extensions by policy. The store's copy
  has neither problem.

## How it works

The extension attaches `chrome.debugger` to the shared tabs and relays the
Chrome DevTools Protocol over one WebSocket to the server's relay, which
gives Playwright a browser endpoint. The logon flow, its answers and the
security rules are in [PROTOCOL.md](PROTOCOL.md); the review that shaped
this version is in [REVIEW.md](REVIEW.md).

The side panel's look is "Ledger": warm paper, dark ink for text and the main
action, one deep blue for the agent's presence, and a warm dark theme that
follows the system's. The typeface is DM Sans, with Geist Mono for SAP's codes
(both bundled in `fonts/` under the SIL Open Font License, see
`fonts/DMSans-OFL.txt` and `fonts/GeistMono-OFL.txt`; nothing is fetched). Its
icons and mark (a soft lit pointer on a navy tile) are drawn for this extension; no SAP
artwork.
