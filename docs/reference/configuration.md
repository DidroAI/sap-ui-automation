---
title: "Configuration: SAP_WRITE, SAP_BROWSER and other settings"
description: "Every environment variable of the sap-ui-automation server: writes, allowed systems and transactions, browser mode, recordings."
---

# Configuration

Every setting is an environment variable of the server process. Set it in
your MCP client's `env` block, or in the shell before a CLI command:

```sh
claude mcp add sap-ui-automation --scope user -e SAP_WRITE=off -- npx -y sap-ui-automation
SAP_ALLOW_SYSTEMS=ABA/800 npx -y sap-ui-automation sessions
```

A value the server cannot read (`SAP_WRITE=yes`, an unknown surface, an
origin that is not `http` or `https`) is an error with a message that
names the variable. `SAP_WRITE`, `SAP_ALLOW_LOGOFF`, `SAP_SURFACES`,
`SAP_VIEW` and `SAP_RECORD` are read when the server starts: a wrong value
there stops it.

Lists are separated by commas or spaces and are not case-sensitive.

## Safety

| Variable | Default | Values | Effect |
| --- | --- | --- | --- |
| `SAP_WRITE` | `confirm` | `confirm`, `off`, `on` | what happens to actions that may write to SAP: asked about in your MCP client (refused when it cannot ask), refused (`off`: read-only), or run. See [Safety model](../concepts/safety.md) and [Confirm mode](../concepts/confirm-mode.md) |
| `SAP_ALLOW_SYSTEMS` | all | `ABA/800,S4H` | only these systems, optionally with a client, are visible and usable. Checked on every tool call: a session that moves to another system is refused from then on |
| `SAP_ALLOW_TCODES` | all | `VA03,MM03` | the only transactions the agent may open or work in. On Fiori, app intents (`SalesOrder-display`) |
| `SAP_BLOCK_TCODES` | none | `SE38,SM30` | transactions the agent may not open or work in |
| `SAP_ALLOW_ORIGINS` | all | `https://myhost:44300` | only browser tabs of these origins are looked at |
| `SAP_ALLOW_LOGOFF` | `off` | `off`, `on` | `on`: the agent may end sessions or the logon (`/nex`, `/nend`, `/i`, Log Off, Yes on the Log Off popup). Off also with `SAP_WRITE=on` |

## Where the server looks

| Variable | Default | Values | Effect |
| --- | --- | --- | --- |
| `SAP_SURFACES` | `sapgui,webgui,fiori` on Windows, `webgui,fiori` elsewhere | any of `sapgui`, `webgui`, `fiori` | which kinds of session to look for, in any case |
| `SAP_GUI_METHOD` | `auto` | `auto`, `scripting`, `diag` | how SAP GUI for Windows is read. `auto`: both SAP GUI scripting and the network reader (experimental) run, and the agent works in whichever session it needs. `scripting` or `diag`: only that one, for setups where nobody watches the agent. Any other value is an error at start. See [Network reader](../guides/network-reader.md) |
| `SAP_CHROME_CDP` | none | `http://127.0.0.1:9333` | a Chrome DevTools endpoint (`http`, `https`, `ws` or `wss`). When set, it wins over `SAP_BROWSER` and nothing else is tried. See [Chrome](../guides/chrome.md#a-chrome-started-with-a-debugging-port) |
| `SAP_BROWSER` | `launch` | `launch`, `attach`, `extension` | `launch`: the server starts Google Chrome with a profile of its own (the SAP window) and looks only at its tabs. `attach`: your running Chrome or Edge, with remote debugging allowed in `chrome://inspect`. `extension`: your everyday Chrome through the SAP UI MCP extension. `SAP_CHROME_CDP` wins over it. See [Choose a browser mode](../guides/chrome.md#choose-a-browser-mode) |
| `SAP_CHROME_PATH` | found: Google Chrome in the usual places (on Linux also Chromium) | a program file | `launch`: the Chrome to start |
| `SAP_START_URL` | the last SAP address the window showed, else an empty tab | an `http` or `https` address | `launch`: the address a new SAP window opens on |
| `SAP_CHROME_PROFILE` | `sap-ui-automation/chrome` in the user's data folder | a folder | `launch`: the SAP window's profile folder |
| `SAP_CHROME_ARGS` | none | Chrome switches, separated by spaces | `launch`: extra switches for the Chrome it starts |
| `SAP_EXTENSION_PORT` | first free of 47823–47830 | a port | with `SAP_BROWSER=extension`, the local port where the extension connects |
| `SAP_EXTENSION_WAIT` | `35` | seconds | with `SAP_BROWSER=extension`, how long to wait for the extension to connect |
| `SAP_EXTENSION_START_CHROME` | `on` on macOS and Windows, `off` elsewhere | `on`, `off` | with `SAP_BROWSER=extension`, start your Chrome when it is not running, so the extension can connect |

## Network reader

These apply when the network reader runs: with `SAP_GUI_METHOD` unset
(`auto`) or `diag`, on Windows.

| Variable | Default | Values | Effect |
| --- | --- | --- | --- |
| `SAP_DIAG_PORT` | `3298` | a port | where the local SAProuter listens, on `127.0.0.1`. Put `/H/127.0.0.1/S/<port>` at the start of the connection's SAProuter string in SAP Logon |
| `SAP_DIAG_CELL` | from the traffic | `cw,ch[,x0,y0]` | the pixel size of SAP GUI's character cell, and the offset of the first one in the screen area. Set it when clicks miss on a theme or a display scaling. `cw` at least 3, `ch` at least 6 |
| `SAP_DIAG_REQUEST_MS` | `3000` | milliseconds | how long to wait for SAP GUI to send a request after a key or a click, before the answer says the input may have missed |
| `SAP_DIAG_QUIET_MS` | `60` | milliseconds | how long the traffic must be quiet after SAP's answer before an action ends |
| `SAP_DIAG_CAPTURE` | off | a folder | keeps a copy of the raw traffic, to debug the decoder. It holds everything SAP GUI sent and received, your logon included. The file is created readable by its owner only, where the system allows it. Keep it local and delete it after use |

## Answers and waits

| Variable | Default | Values | Effect |
| --- | --- | --- | --- |
| `SAP_VIEW` | `diff` | `diff`, `full` | `full`: every action answers with the whole screen. `diff`: only what changed, when the screen is the same and the changes are shorter |
| `SAP_FIORI_WAIT` | full waits | `busy` | faster Fiori waits: busy indicators only, without UI5's RecordReplay |
| `SAP_CODE` | while recording | `on`, `off` (also `true`, `1`, `false`, `0`) | the `code:` line in `sap_act` answers: the SDK call that repeats the action. Unset, it is there only while a recording is on. `on`: always. `off`: never, also while recording |
| `SAP_STRUCTURED` | `off` | `on` (also `true`, `1`) | answers that code reads (`sap_sessions`, `sap_act`, `sap_replay`, `sap_record`) also carry `structuredContent`, and these tools declare output schemas. The text is the same. See [MCP tools](tools.md#structured-content) |
| `SAP_TIMINGS` | off | `on`, `true`, `1` | every `sap_act` answer adds a line that says where the time went. One action can ask with `"timing": true` |

## Recording and files

| Variable | Default | Values | Effect |
| --- | --- | --- | --- |
| `SAP_RECORD_DIR` | `./sap-tests` (in the server's working directory) | a folder | where `sap_record` writes recordings and exports, and `sap_code_save` writes tests |
| `SAP_RECORD` | `off` | `off`, `on` | `on`: record every session from its first action, without `sap_record start` |
| `SAP_DOWNLOAD_DIR` | `downloads` in `SAP_RECORD_DIR` when that is set, else `./sap-downloads` | a folder | Web GUI: where a file SAP writes "to a local file" (List > Export > Local File) is copied. Web GUI keeps such a file inside the browser; the action's answer names the copy |
| `SAP_CODE_TOOLS` | `off` | `on` | adds the tools `sap_code_save` and `sap_code_test`: the agent can save a `*.sap.ts` test in `SAP_RECORD_DIR` and run it on this machine. Only `on` turns them on. Read [the risk](../guides/record-replay.md#code-tools-sap-code-save-and-sap-code-test) first |

Recordings hold the values that were typed: treat them like the system's
data.

## Agent CLI

| Variable | Default | Effect |
| --- | --- | --- |
| `SAP_CLI_DIR` | `.sap-gui/screens` | where the agent CLI writes answers and screens |
| `SAP_CLI_IDLE` | `30` | minutes without a command before the daemon exits |
| `SAP_CLI_SESSION` | one daemon per directory | a name: one daemon for every directory that sets it |

See [CLI for coding agents](../guides/cli-for-agents.md).

## Read by exported tests, not by the server

The Playwright specs that `export --to playwright` writes read these when
they run. The server itself never reads a password.

| Variable | Effect |
| --- | --- |
| `SAP_WEBGUI_URL` | the Web GUI address the spec logs on to |
| `SAP_FIORI_URL` | the launchpad address, for a Fiori recording |
| `SAP_USER`, `SAP_PASSWORD` | the user and password the spec logs on with |
| `SAP_VAR_<NAME>` | the value of the test's variable `<name>` (upper case) |

## Other variables the server reads

These are standard variables of the operating system or of other tools.
You do not normally set them for this server.

| Variable | Used for |
| --- | --- |
| `LOCALAPPDATA` (Windows), `XDG_CONFIG_HOME`, `CHROME_CONFIG_HOME` (Linux) | where Chrome's profile, and so its `DevToolsActivePort` file, is |
| `SystemRoot`, `windir` | the path to Windows PowerShell (`powershell.exe`) |
| `APPDATA` | `setup`: where Claude Desktop's config is on Windows |
| `CODEX_HOME` | `setup`: where Codex's `config.toml` is (default `~/.codex`) |

## For development only

| Variable | Effect |
| --- | --- |
| `SAP_TEST_CHROME` | the repository's tests: a Chrome to run browser tests against |
| `SAP_EXTENSION_CODE` | a fixed pairing code for the extension, for tests and CI; otherwise the code is kept in a file only you can read |
| `SAP_CLI_STATE_DIR` | where the agent CLI keeps its daemon's state, for tests |

`sap-ui-automation --help` lists the commands and the main settings
([CLI commands](cli.md)).
