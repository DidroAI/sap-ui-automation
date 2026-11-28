---
title: "SAP UI MCP FAQ and troubleshooting"
description: "One entry per check doctor can fail, then common questions: Mac and Linux, SAP GUI for Java, SNC, Edge, logon, where data goes, writes."
---

# FAQ and troubleshooting

This page answers the questions people ask most about setting up and using
sap-ui-automation. Start with `doctor`. It checks what the server can reach
on this machine and says what to change:

```sh
npx -y sap-ui-automation doctor
```

The first part of this page has one entry per check `doctor` can fail
(`✗`), in the order it prints them. The second part answers common
questions.

## Troubleshooting: SAP GUI for Windows (scripting)

### PowerShell may run the host: Constrained Language mode

**Symptom.** `✗ PowerShell may run the host: PowerShell runs in Constrained
Language mode: a Windows policy (AppLocker or App Control) restricts
scripts.`

**Cause.** The server talks to SAP GUI through a Windows PowerShell script
that calls SAP GUI's COM objects. That needs PowerShell's Full Language
mode, and a Windows policy restricts it.

**Fix.** Ask your IT team to allow the server's script: an AppLocker or App
Control rule for its folder (or for its publisher, once it is signed). Or
use Web GUI or Fiori in Chrome, which need no PowerShell.

### PowerShell may run the host: Windows blocked powershell.exe

**Symptom.** `✗ PowerShell may run the host: Windows blocked powershell.exe
(...)`.

**Cause.** AppLocker or a software restriction policy stops
`powershell.exe` from starting.

**Fix.** As above: an allow rule from your IT team, or Web GUI and Fiori.

### PowerShell host

**Symptom.** `✗ PowerShell host: <error>. The server talks to SAP GUI
through Windows PowerShell 5.1 (powershell.exe); it must be allowed to
run.`

**Cause.** The PowerShell process did not start or did not answer within
30 seconds.

**Fix.** Check that `powershell.exe` runs for your Windows user (open it
from the Start menu). The server looks for it under `%SystemRoot%\System32\WindowsPowerShell\v1.0`.

### SAP GUI is running

**Symptom.** `✗ SAP GUI is running: not running: start SAP Logon and log on
to a system`.

**Cause.** No SAP GUI process was found.

**Fix.** Start SAP Logon and log on. The server never logs on for you.

### Scripting is on in SAP GUI

**Symptom.** `✗ Scripting is on in SAP GUI: off: tick "Enable scripting"
...`, or `SAP GUI does not offer its scripting object (...)`.

**Cause.** Scripting is switched off in SAP GUI's options, possibly for the
whole machine by an administrator. Or SAP GUI runs as another Windows user,
in another desktop session, or as administrator, so the server cannot reach
its scripting object.

**Fix.** In SAP Logon > Options > Accessibility & Scripting > Scripting,
tick *Enable scripting*, then restart SAP Logon. Run the server as the same
Windows user, in the same desktop session as SAP GUI, not as administrator.
When `doctor` says the setting is "set for the whole machine by an
administrator", ask your IT team.

### Scripting is allowed on the SAP system

**Symptom.** `✗ Scripting is allowed on the SAP system: <connection>: no
session is visible to scripting.` Or `no SAP system is logged on`.

**Cause.** The SAP system does not allow scripting: profile parameter
`sapgui/user_scripting` is not `TRUE`. Test and QA systems often allow it;
production systems often do not. Or no system is logged on yet.

**Fix.** Ask your SAP basis team to set `sapgui/user_scripting = TRUE`
(transaction RZ11, and in the default profile to keep it), then log on
again. If they will not, try the [network reader](guides/network-reader.md)
or Web GUI in Chrome. If no system is logged on, log on in SAP Logon.

### Notice "a script is attaching" is off / "a script opens a connection" is off

**Symptom.** `✗ Notice "a script is attaching" is off: on: SAP GUI then
shows a dialog and waits for a click each time.` (The same for "a script
opens a connection".)

**Cause.** SAP GUI asks you to confirm each time a script attaches or opens
a connection. The server would wait on that dialog.

**Fix.** In SAP Logon > Options > Accessibility & Scripting > Scripting,
untick *Notify when a script attaches to SAP GUI* and *Notify when a script
opens a connection*.

### SAP GUI for Windows: needs Windows

**Symptom.** `✗ SAP GUI for Windows: needs Windows`. Or, without
`SAP_SURFACES=sapgui`, `doctor` lists SAP GUI for Windows as "not checked".

**Cause.** The server runs on macOS or Linux. SAP GUI scripting exists only
on Windows.

**Fix.** Run the server on the Windows machine where SAP GUI is open, or
use Web GUI or Fiori in Chrome, which work everywhere.

## Troubleshooting: the network reader

On Windows the network reader runs next to SAP GUI scripting by default.
`doctor` checks both and is ready when one of them works: a ✗ here does
not matter while scripting sees your session, unless you set
`SAP_GUI_METHOD=diag`.

### DIAG router

**Symptom.** `✗ DIAG router: <error>` with `→ Port 3298 is taken: set
SAP_DIAG_PORT to a free port.`

**Cause.** Another program, or another copy of the server, listens on the
router's port.

**Fix.** Set `SAP_DIAG_PORT` to a free port, and use that port in the SAP
Logon entry. Only one server at a time can own the port: an MCP client and
`doctor` started side by side compete for it.

### SAP GUI connections: none through the router yet

**Symptom.** `✗ SAP GUI connections: none through the router yet`.

**Cause.** No SAP GUI connection goes through the server's router. The
connection entry does not name it, or you logged on before the server was
running.

**Fix.** In SAP Logon, edit the connection entry: put
`/H/127.0.0.1/S/3298` (or your `SAP_DIAG_PORT`) at the start of its
SAProuter string, before your company's router if there is one. Start the
server first, then log on again. Connections encrypted with SNC cannot be
read.

### DIAG decoding: SNC

**Symptom.** `✗ DIAG decoding: ...` with `→ The connection is encrypted
with SNC, which the DIAG method cannot read.`

**Cause.** The connection uses SNC encryption.

**Fix.** Use a connection entry without SNC, or another method (scripting,
Web GUI, Fiori). Bytes lost on the connection and notes on what was not
read are listed on this line too; they do not fail the check.

### DIAG router messages

**Symptom.** `✗ DIAG router messages: ...` (at most the last five).

**Cause.** A route was refused (the connection entry's SAProuter string
does not lead on from this router), or the capture folder
(`SAP_DIAG_CAPTURE`) cannot be written. The same messages go to the
server's log (stderr).

**Fix.** Check the SAProuter string of the connection entry, or the
capture folder. SAP GUI's connection is kept even when the reader fails.

## Troubleshooting: Chrome, Web GUI and Fiori

Which checks `doctor` runs depends on the browser mode (`SAP_BROWSER`):
see [Choose a browser mode](guides/chrome.md#choose-a-browser-mode).

### Chrome: Google Chrome was not found

**Symptom.** `✗ Chrome: Google Chrome was not found on this machine`
(the default mode, `launch`).

**Cause.** The server starts Chrome itself and did not find it in the usual
places.

**Fix.** Install Google Chrome, or set `SAP_CHROME_PATH` to the program
file of a Chrome or Chromium. To use a Chrome that already runs instead,
set `SAP_BROWSER=attach` or `SAP_BROWSER=extension`.

### Chrome ended at once and opened no window

**Symptom.** `Chrome ended at once ... and opened no window` from
`browser`, `sessions` or the agent.

**Cause.** Chrome could not start: most often there is no screen (a server
or a container), or the Chrome binary cannot run there (on Ubuntu 23.10 and
later, a Chromium that is not installed as a package may refuse to start
without a sandbox profile).

**Fix.** Run the command it prints to see Chrome's own error. Use a
machine with a desktop, or a Chrome installed from Google's package.

### Chrome extension: no extension connected

**Symptom.** `✗ Chrome extension: no SAP UI MCP extension
connected to port 47823 within 35 s` (`SAP_BROWSER=extension`).

**Cause.** The extension is not installed or not paired, or Chrome is not
running. On Linux the server does not start Chrome for you.

**Fix.** [Install the extension](guides/chrome.md#install-the-extension),
open Chrome, click the extension's icon and **Pair**, then run `doctor`
again. If the side panel shows another port, set `SAP_EXTENSION_PORT` to
it.

### Chrome: no Chrome with remote debugging allowed

**Symptom.** `✗ Chrome: no Chrome with remote debugging allowed is running
(looked for Chrome, Chrome Beta and Edge)`.

**Cause.** With `SAP_BROWSER=attach`, the server attaches to the Chrome you
use, once you allow it. Remote debugging is not allowed yet, or Chrome is
older than 144.

**Fix.** In Chrome 144 or later, open `chrome://inspect/#remote-debugging`
and tick *Allow remote debugging for this browser instance*. Run `doctor`
again and click Allow when Chrome asks.

### Chrome: something listens on 127.0.0.1:9222

**Symptom.** `✗ Chrome: something listens on 127.0.0.1:9222, but no Chrome
has written its DevToolsActivePort file`.

**Cause.** A browser listens on port 9222, but the server cannot tell it is
your Chrome. It does not attach to port 9222 by itself: a browser there may
belong to another tool.

**Fix.** If it is your Chrome, quit it completely and open it again. If it
is a Chrome you started for testing, name it:
`SAP_CHROME_CDP=http://127.0.0.1:9222`.

### Chrome: macOS does not let this app read DevToolsActivePort

**Symptom.** `✗ Chrome: Chrome allows remote debugging, but macOS does not
let this app read Chrome's DevToolsActivePort file (privacy protection)`.

**Cause.** macOS privacy protection stops the app that runs the server from
reading Chrome's profile folder.

**Fix.** In System Settings > Privacy & Security > Full Disk Access, give
access to the app that runs the server (Terminal or iTerm for `doctor`;
Claude, Codex or your editor for the MCP server). Restart that app, then
run `doctor` again.

### Chrome: no Chrome answers at SAP_CHROME_CDP

**Symptom.** `✗ Chrome: No Chrome answers at SAP_CHROME_CDP=...`, or
`SAP_CHROME_CDP must be an http or ws URL`.

**Cause.** `SAP_CHROME_CDP` names an endpoint where no Chrome listens, or
the value is not a URL.

**Fix.** Check that this Chrome runs with `--remote-debugging-port` and
`--user-data-dir` (since Chrome 136 the port opens only with both), or
unset `SAP_CHROME_CDP` to use the browser mode `SAP_BROWSER` names.

### Fiori tabs

**Symptom.** `✗ Fiori tabs: <error>`.

**Cause.** Reading the tabs failed after Chrome was reached.

**Fix.** Read the error; reload the launchpad tab and run `doctor` again.

### No Web GUI or Fiori tab found

**Symptom.** `✓ Web GUI: no Web GUI tab open` or `✓ Fiori tabs: no Fiori
tab now`. Not a failure, but `sap_sessions` finds nothing.

**Cause.** A tab counts as Web GUI when its address contains
`/sap/bc/gui/sap/its/webgui` or the page holds Web GUI's controls; as Fiori
when SAPUI5 runs in it and it is a launchpad. With `SAP_ALLOW_ORIGINS`, only
those origins are looked at.

**Fix.** Open the tab and log on. Check `SAP_ALLOW_ORIGINS`.

### The agent does not list the sap-ui-automation tools

**Symptom.** `doctor` says `Ready.`, but the agent has no `sap_` tools.

**Fix.** Run `sap-ui-automation setup`, then restart the agent. See
[Install in your client](getting-started/installation.md).

## Common questions

### Does it work on a Mac or on Linux?

Web GUI and Fiori, yes: they run in Chrome on Windows, macOS and Linux, in
all three browser modes. SAP GUI for Windows needs Windows. SAP GUI for Java (macOS, Linux) has no
scripting and is not supported: on a Mac, use Web GUI or Fiori.

### Does it work with SAP GUI for Java?

No. SAP GUI for Java has no scripting interface the server can use.

### Does it work with SNC-encrypted connections?

With SAP GUI scripting, yes: scripting works inside SAP GUI, after
decryption. With the network reader, no: it reads
the traffic, and cannot read SNC-encrypted connections.

### Does it work with Microsoft Edge?

Probably, with `SAP_BROWSER=attach`. Edge is Chromium, and the server
finds it the same way as Chrome (Chrome stable, then Chrome Beta, then
Edge). The default mode starts Google Chrome; `SAP_CHROME_PATH` can name
Edge's program file instead. Both are less tested than Chrome. Firefox
and Safari are not supported.

### Does it log on?

The server does not. It never logs on, never stores a password, never
types into a password field, and refuses every action on a logon screen.
It works in sessions you have opened, as you, under your SAP
authorisations. With the Chrome extension (`SAP_BROWSER=extension`), the
extension can log on to a system you registered in it, with the password
it keeps in your keychain; the server and the agent never see that
password ([Chrome](guides/chrome.md#use-your-everyday-chrome-with-the-extension)). The exported Playwright
spec is the one thing that logs on, from `SAP_USER` and `SAP_PASSWORD`: it
is a file you run yourself, not the server.

### Where is my data sent?

The server sends nothing to its authors or to any third party, and has no
telemetry. It answers the MCP client that started it, over stdio; the
client sends the answers (screen text, screenshots) to the model provider
you configured. Details: [Security and data handling](security.md).

### Can the agent save or post documents?

Under the default `SAP_WRITE=confirm`, the server requests approval from your MCP client for flagged writes. Codex Full Access can accept automatically. A client without elicitation gets
it refused. With `SAP_WRITE=off` every such action is refused (read-only);
`SAP_WRITE=on` lets it run. The rule fails closed, so some harmless
buttons are asked about or refused too (for example "Continue" on a popup
the server does not know as safe). See
[Safety model](concepts/safety.md).

### Web GUI is slow in a background tab

Chrome draws a tab that is not in front about once a second, and hands it
clicks and keys just as slowly. The server notices and waits longer: two to
three seconds per action instead of one. It works, but a tab in front, or a
window of its own, is faster.

### An action timed out, or SAP is still working

An action waits for SAP's answer, not a fixed time: up to 180 seconds on
SAP GUI scripting and Web GUI, 60 seconds with the network reader. Then it
says that SAP is still working; look again with `sap_look` before the next
action. A long step can be given more time with `"timeout"` in seconds, up
to 600:

```json
{"do": "key", "key": 8, "timeout": 300}
```

If the connection to SAP drops, the action says the request failed; a Web
GUI page then needs a reload. A session that timed out shows as a `WINDOW
browser` with a note.

### Why was an id refused?

An id that names several controls is refused with the list of them; the
server does not pick one. An id that is not on the screen is refused, and
if the screen is not the one the agent saw last, the answer holds the
screen it is on. See [Ids and handles](concepts/ids.md).

### Can I see SE80's object tree or other HTML panels in SAP GUI?

Not as text: scripting cannot reach HTML panels inside SAP GUI. Use
`sap_screenshot` to see them.

### Which logon languages does the guard know?

Words that may write (Save, Post, Delete...) are known in English, German,
French, Spanish, Portuguese, Italian and Dutch. Words known to be safe are
known in English, German, French and Spanish. In another logon language
only ids, keys and function codes count as safe, so more actions are held.

### A replay fails on a step that writes

A replay cannot ask for each step: a step that may write needs
`SAP_WRITE=on`. See [Recording and replay](guides/record-replay.md).
