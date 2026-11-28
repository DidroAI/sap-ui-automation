---
title: "CLI commands: setup, doctor, sessions and more"
description: "The commands of the sap-ui-automation CLI, what each does and its exit codes."
---

# CLI commands

The package installs one command, `sap-ui-automation`. Without arguments it
is the MCP server on stdio; with a command it does one job and exits.

```sh
npx -y sap-ui-automation <command> [options]
# or, after npm i -g sap-ui-automation:
sap-ui-automation <command> [options]
```

| Command | Does | Exit code |
| --- | --- | --- |
| (none) | starts the stdio MCP server: what MCP clients run | runs until the client closes it |
| [`setup`](#setup) | sets up the coding agents found on this machine: the MCP server and the skills | 0; 1 when cancelled; 2 for an unknown agent or option |
| `init`, `install`, `test`, `show-trace`, agent CLI | see the table below | |
| [`doctor`](#doctor) | checks what the server can reach, and says what to change | 0 ready, 1 not ready |
| [`browser`](#browser) | opens the SAP window (the Chrome the server starts for Web GUI and Fiori) | 0; 1 when Chrome could not start |
| [`extension`](#extension) | installs, pairs or removes the Chrome extension | 0 |
| [`sessions`](#sessions) | lists the SAP sessions found now | 0; 1 when every surface failed |
| [`replay`](#replay) | runs recorded tests on an open session, with no model | 0 all passed, 1 otherwise |
| [`export`](#export) | writes a recorded test in another format | 0 |
| `--help`, `-h`, `help` | the usage and the main settings | 0 |
| `--version`, `-v` | the version | 0 |

An unknown command prints the usage and exits with 2. An error (a missing
file, a bad flag) prints its message and exits with 1.

Settings are environment variables, the same for the server and the
commands: [Configuration](configuration.md). `doctor`, `sessions` and
`replay` use `SAP_SURFACES`, `SAP_GUI_METHOD`, `SAP_CHROME_CDP`,
`SAP_ALLOW_SYSTEMS` and the other settings as the server would.

The following commands support project setup, testing, and interactive use:

| Command | Does | Guide |
| --- | --- | --- |
| `init [--yes] [--force] [--dry-run]` | sets a project up: `sap.config.ts`, `sap-tests/example.sap.ts`, agent skills, MCP clients, `.gitignore` | [Writing tests](../guides/sdk-tests.md) |
| `install --skills [--target claude\|codex\|cursor\|all] [--global] [--dry-run]` | copies the bundled agent skills into this project (default target `claude`) | [CLI for coding agents](../guides/cli-for-agents.md) |
| `test [files] [--config f] [--project p] [--reporter list,junit,json,html] [--grep re] [--retries n] [--list] [--update-locks]` | runs `*.sap.ts` tests | [Writing tests](../guides/sdk-tests.md) |
| `show-trace <file> [--out <file.html>] [--open]` | writes a recording or trace as one HTML page | [Trace viewer](../guides/trace-viewer.md) |
| `sessions`, `look`, `act`, `okcode`, `open`, `use`, `screenshot`, `record`, `daemon` | the agent CLI | [CLI for coding agents](../guides/cli-for-agents.md) |

## The server

```sh
sap-ui-automation
```

Starts the MCP server on stdin and stdout. MCP clients run this; you do not
normally run it yourself. It reads its settings once, at start. It stops
when the client closes stdin, or on SIGINT or SIGTERM, and then disconnects
from Chrome without closing it.

## setup

```sh
sap-ui-automation setup [<agent>...] [--agent <ids>] [--yes] [--dry-run] [--verbose] [--no-skills] [--no-mcp] [--extension]
```

Sets up the coding agents on this machine, the way `npx skills add` does
for skills, but with both parts:

- the MCP server, as `sap-ui-automation`, in each agent's MCP config;
- the skills `sap-ui-automation` and `sap-ui-automation-cli`, in each
  agent's skills folder, so the agent uses one when a task matches it.

In a terminal it asks which agents to set up: the ones found come first,
ticked, then the others under "Not found" (↑/↓ move, space ticks, `a`
ticks all, Enter confirms). Once answered, the list gives way to one line,
such as "19 agents selected". With `--yes`, or when it does not run in a
terminal, it prints the agents found on one line and sets up every one.
Names given on the command line win over both.

| Option | Effect |
| --- | --- |
| `<agent>...` | these agents (ids from the table below), found or not |
| `--agent <ids>`, `-a <ids>` | the same, comma-separated or repeated; `'*'` is every agent found |
| `--yes`, `-y` | no question: every agent found |
| `--dry-run` | say what would change, change nothing (the same summary, with "would") |
| `--verbose`, `-v` | one line per agent, with its config file and skills folder, instead of the grouped summary |
| `--no-skills` | the MCP server only |
| `--no-mcp` | the skills only |
| `--extension` | through the Chrome extension: new entries get `SAP_BROWSER=extension`, an existing entry of ours is switched to it (see below), and the extension's helper is installed too |

It prints a short summary, the agents grouped by what they got:

```
✓ Server and skills  Claude Code, Codex, Cursor, Windsurf, Copilot CLI, Gemini CLI, … (14)
✓ Skills only        Roo Code, Crush, Continue, Kilo Code, Trae
  Server added for 9 agents, already there for 2, switched to the extension for Codex, Cursor and Windsurf
  Skills installed in ~/.agents/skills, linked for 15 agents
✓ Chrome helper      installed
```

An agent it could not set up is under "Not set up", one it had nothing to do
for under "Skipped". Then, only when there is something to do by hand, a
"Needs your attention" block, one item per issue with the agents under it:
an entry left under the server's old name, with the command that removes
it; an entry without `SAP_BROWSER=extension` that setup does not change; a
write or a helper install that failed, with what to do instead. Last, the
next steps, numbered. `--verbose` prints one line per agent instead of the
groups, with its config file and skills folder, and the skills' old names
removed in each folder.

Colour (a green ✓, a yellow !, dim secondary text) is used only when the
output is a terminal and `NO_COLOR` is not set; the text is the same
without it.

### `--extension` and an entry that is already there

With `--extension`, an existing `sap-ui-automation` entry in a JSON file or
in Codex's `config.toml` gets `SAP_BROWSER=extension` added to its env and
is reported as switched to the extension. Nothing else in the entry or the
file changes: its command, its other variables and fields, the other
servers. An entry that sets `SAP_BROWSER` to another value, Goose's YAML
file, and an entry in a form setup does not read are left as they are and
named under "Needs your attention", with what to add.

Claude Code's entry is read with `claude mcp get sap-ui-automation`.
`claude mcp` cannot change an entry, and what it prints is not enough to
re-add one faithfully, so setup does not touch it: when it lacks the
variable, setup gives the command that re-adds it with its own variables
kept, `claude mcp remove ... && claude mcp add ... -e SAP_BROWSER=extension ...`.
Check its arguments before you run it: an argument with a space reads as two.

### The agents

| Agent | Id | Found when | MCP server | Skills folder |
| --- | --- | --- | --- | --- |
| Claude Code | `claude-code` | `claude` on the PATH | `claude mcp add sap-ui-automation --scope user` | `~/.claude/skills` (`$CLAUDE_CONFIG_DIR/skills`) |
| Codex | `codex` | `codex` on the PATH, or `~/.codex` | `[mcp_servers.sap-ui-automation]` in `~/.codex/config.toml` (`$CODEX_HOME`) | `~/.agents/skills` |
| Claude Desktop | `claude-desktop` | its folder (macOS `~/Library/Application Support/Claude`, Windows `%APPDATA%\Claude`) | `mcpServers` in `claude_desktop_config.json` | none |
| Cursor | `cursor` | `~/.cursor`, or `.cursor/mcp.json` in the project | `mcpServers` in the project's `.cursor/mcp.json` when it exists, else `~/.cursor/mcp.json` | `~/.agents/skills` |
| Windsurf (Devin Desktop) | `windsurf` | `~/.config/devin` (`%APPDATA%\devin`) or `~/.codeium/windsurf` | `mcpServers` in `~/.config/devin/mcp_config.json` | `~/.agents/skills` |
| VS Code (GitHub Copilot) | `vscode` | `.vscode/mcp.json` in the project | `servers` in the project's `.vscode/mcp.json` | `~/.copilot/skills` |
| GitHub Copilot CLI | `copilot-cli` | `copilot` on the PATH, or `~/.copilot` | `mcpServers` in `~/.copilot/mcp-config.json` (`$COPILOT_HOME`) | `~/.copilot/skills` |
| Gemini CLI | `gemini-cli` | `gemini` on the PATH, or `~/.gemini/settings.json` | `mcpServers` in `~/.gemini/settings.json` | `~/.gemini/skills` |
| Antigravity | `antigravity` | `~/.gemini/antigravity` | `mcpServers` in `~/.gemini/config/mcp_config.json` | `~/.gemini/config/skills` |
| OpenCode | `opencode` | `opencode` on the PATH, or `~/.config/opencode` | `mcp.servers` in `~/.config/opencode/opencode.json` (or `.jsonc`) | `~/.config/opencode/skills` |
| Cline | `cline` | `cline` on the PATH, or `~/.cline` | `mcpServers` in `~/.cline/data/settings/cline_mcp_settings.json` | `~/.agents/skills` |
| Roo Code | `roo` | `~/.roo` | not written (see below) | `~/.roo/skills` |
| Kiro | `kiro` | `kiro-cli` on the PATH, or `~/.kiro` | `mcpServers` in `~/.kiro/settings/mcp.json` | `~/.kiro/skills` |
| Zed | `zed` | `~/.config/zed` (Windows `%APPDATA%\Zed`) | `context_servers` in its `settings.json` | `~/.agents/skills` |
| Goose | `goose` | `goose` on the PATH, or `~/.config/goose` (Windows `%APPDATA%\Block\goose\config`) | an `extensions:` entry in `config.yaml` | `~/.config/goose/skills` |
| Amp | `amp` | `amp` on the PATH, or `~/.config/amp` | `amp.mcpServers` in `~/.config/amp/settings.json` (or `.jsonc`) | `~/.config/agents/skills` |
| Junie | `junie` | `junie` on the PATH, or `~/.junie` | `mcpServers` in `~/.junie/mcp/mcp.json` | `~/.junie/skills` |
| Warp | `warp` | `~/.warp` | `mcpServers` in `~/.warp/.mcp.json` (not on Windows) | `~/.agents/skills` |
| Qwen Code | `qwen-code` | `qwen` on the PATH, or `~/.qwen` | `mcpServers` in `~/.qwen/settings.json` | `~/.qwen/skills` |
| Factory Droid | `droid` | `droid` on the PATH, or `~/.factory` | `mcpServers` in `~/.factory/mcp.json` | `~/.factory/skills` |
| Crush, Augment, Continue, Kilo Code, Trae | `crush`, `augment`, `continue`, `kilo`, `trae` | their folder in the home folder | not written | `~/.config/crush/skills`, `~/.augment/skills`, `~/.continue/skills`, `~/.kilo/skills`, `~/.trae/skills` |

`~` is the home folder (`%USERPROFILE%` on Windows); `~/.config` is
`$XDG_CONFIG_HOME` when it is set. Each MCP format comes from the agent's
own documentation. Where that documentation does not give the file (Roo
Code keeps its in VS Code's storage) or the format (Crush now reads a
`crushrc` file), setup installs the skills only: add the server in the
agent's MCP settings with the command setup prints. The Cline file is the
one its docs name for the Cline CLI; the VS Code extension may keep its own
list.

### How the skills are installed

One real copy goes to `~/.agents/skills/<name>`, which Codex, Cursor,
Windsurf, Cline, Zed and Warp read. Every other agent's folder gets a link
to it (a junction on Windows). Where no link can be made, the folder gets a
copy instead, and the summary says so. Agents that share a folder are written
once. Running setup again updates the copy in place and leaves the links.

Each copy holds a `.sap-ui-automation` marker. A folder of the same name
that is not from this package is never replaced or removed. Copies under
the skills' old names (`sap-gui-drive`, `sap-gui-cli`) are removed only when
they are this package's.

For an agent setup does not know, `npx skills add DidroAI/sap-ui-mcp`
installs the same skills.

### What it never does

- It never replaces an existing `sap-ui-automation` entry; with
  `--extension` it only adds `SAP_BROWSER=extension` to its env (see above).
- It keeps the rest of a config file as it was: other servers, settings,
  comments (in the JSON files that allow them) and layout.
- It keeps a `.bak` copy of a config file before it first changes it.
- A file it cannot read safely is left alone, with the entry to add by hand.
- It names an entry left under the server's old names (`sap-gui-mcp-server`,
  `sap-gui`) and says how to remove it.
- It adds no settings: the server starts with `SAP_WRITE=confirm`, the
  default. Add variables in the agent's configuration.

The command it writes depends on how it was started: `npx -y
sap-ui-automation` when run through `npx`, `sap-ui-automation` when
installed on the PATH, else Node with the path of the script. On Windows it
is wrapped in `cmd /c`.

## doctor

```sh
sap-ui-automation doctor
```

Checks what the server can reach on this machine, one block per area, a
mark per check (`✓` or `✗`), and the one thing to do when a check fails.
It ends with `Ready.` or `Not ready yet: fix the ✗ above, then run doctor
again.`

| Area | Checks |
| --- | --- |
| Chrome, `launch` (default) | Chrome found; whether the SAP window runs; then its tabs |
| Chrome, `extension` | the extension connected (it waits up to 35 s), paired; then the tabs it shares |
| SAP GUI for Windows, scripting (unless `SAP_GUI_METHOD=diag`) | PowerShell may run the host; SAP GUI is running; scripting is on in SAP GUI; scripting is allowed on the SAP system; the two "notify" options are off |
| SAP GUI for Windows, network reader (unless `SAP_GUI_METHOD=scripting`) | the local router listens; connections go through it; decoding (bytes lost, what was not read, SNC); the router's messages |
| Chrome, `attach` or `SAP_CHROME_CDP` | Chrome reachable, its version, `SAP_ALLOW_ORIGINS`, open tabs; the Web GUI and Fiori tabs found |

With `SAP_GUI_METHOD` unset (`auto`), both ways of reading SAP GUI are
checked, and either one that works is enough. On a machine other than
Windows, SAP GUI for Windows is listed as not checked. In `attach` mode, if Chrome asks whether to allow remote
debugging, click Allow.

Every failed check, its cause and its fix: [FAQ and troubleshooting](../faq.md).

## browser

```sh
sap-ui-automation browser
```

Opens the SAP window: the Chrome window the server starts for Web GUI and
Fiori in the default browser mode (`SAP_BROWSER=launch`), with a profile of
its own. Open your SAP address there and log on once. If the window is
already open, it says so. The agent opens the same window by itself when
it needs SAP, so this command is optional. See
[Chrome](../guides/chrome.md#the-sap-window-launch-the-default).

## extension

```sh
sap-ui-automation extension install [dir]
sap-ui-automation extension helper
sap-ui-automation extension pair
sap-ui-automation extension uninstall [dir]
```

| Command | Does |
| --- | --- |
| `install [dir]` | copies the Chrome extension to `dir` (default `~/sap-ui-automation-extension`) to load with **Load unpacked**, and installs its helper: the extension then pairs in one click and keeps saved SAP passwords in the keychain |
| `helper` | installs only the helper, for the extension installed from the Chrome Web Store |
| `pair` | prints the pairing code, to pair the extension by hand |
| `uninstall [dir]` | removes the helper from every browser, the SAP passwords it saved, and the copied extension |

Guide: [Use your everyday Chrome with the extension](../guides/chrome.md#use-your-everyday-chrome-with-the-extension).

## sessions

```sh
sap-ui-automation sessions
```

Lists the SAP sessions the server finds now, in the format of the
`sap_sessions` tool ([MCP tools](tools.md#sap-sessions)), then exits.
Problems of a surface (SAP GUI scripting off, no Chrome) go to stderr. It
exits with 1 only when every surface failed: that is a setup problem, not
"nothing open".

## replay

```sh
sap-ui-automation replay <file>... [--var name=value]... [--session <ref>] [--loose] [--continue] [--stay] [--json] [--junit <file>]
```

Runs recorded tests (`.saptest.json`) on a session you have open, with no
model, under the same guard as `sap_act`. It never logs on.

| Option | Effect |
| --- | --- |
| `<file>...` | one or more recordings. Several run in order on one session; each hands its variables, captured ones included, to the next. The run stops at the first test that fails |
| `--var name=value` | a value for a test variable; repeat for several. A name no test has is an error |
| `--session <ref>` | the session: number, id, system, transaction or surface, as in `sap_use`. Omitted: the first one found. An unavailable explicit target fails; list sessions and verify the intended id before retrying |
| `--loose` | landing on another screen than recorded is a note, not a failure |
| `--continue` | on a screen with a choice the recording does not have (availability control), press its neutral Continue and say so |
| `--stay` | after a failure, stay on the failing screen. Default: leave the transaction with `/n` (unsaved input is dropped) |
| `--json` | the results as JSON |
| `--junit <file>` | also write JUnit XML: one suite per test, one case per step |

A step that may write needs `SAP_WRITE=on`. Guide:
[Recording and replay](../guides/record-replay.md).

## export

```sh
sap-ui-automation export <file> --to <target> [--out <file>]
```

Writes one recording in another format.

| Target | File | For |
| --- | --- | --- |
| `calm` | `.calm.json` | SAP Cloud ALM manual test case, as the input of a Cloud ALM MCP server's `calm_create_test_case` tool |
| `vbs` | `.vbs` | SAP GUI scripting (VBScript), for SAP GUI for Windows |
| `playwright` | `.spec.ts` | Playwright test for Web GUI (`@playwright/test`) |
| `playwright-sap` | `.psap.spec.ts` | Playwright test with playwright-sap's `locateSID` |
| `sap-ts` | `.sap.ts` | a test for the SDK's test runner ([Writing tests](../guides/sdk-tests.md)) |
| `gherkin` | `.feature` | Gherkin feature (Given / When / Then step list) |

| Option | Effect |
| --- | --- |
| `--to <target>` | required: one of the targets above |
| `--out <file>` | where to write. `-` prints to stdout. Default: next to the recording, with the target's suffix in place of `.saptest.json` |

It prints the path written.
