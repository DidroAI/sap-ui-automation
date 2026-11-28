---
title: "SAP from the command line for coding agents"
description: "The sap-ui-automation command gives coding agents without MCP the same SAP tools: look, act, sessions, with the screen kept in a file until it is needed."
---

# CLI for coding agents

The agent CLI, `sap-ui-automation`, gives coding agents that can run shell commands
(Claude Code, Codex, Cursor) the same tools as shell commands: the agent
runs `sap-ui-automation look`, reads a short answer, and opens the screen file only
when it needs it. This
keeps screens out of the conversation until they matter, and works in
agents that have no MCP support.

## Set up

```sh
npm install -g sap-ui-automation             # puts sap-ui-automation on the PATH
sap-ui-automation install --skills --target all        # in your project: the skills for Claude Code, Codex and Cursor
sap-ui-automation sessions                             # what it finds now
```

`npx -y sap-ui-automation setup` installs the skills for your user instead,
in every coding agent it finds ([setup](../reference/cli.md#setup)). Then open SAP (for Web GUI and Fiori: log on in
the Chrome window it opens, see [Chrome](chrome.md)) and ask your agent to
work in it with `sap-ui-automation`. Without a global install, every command also
runs as `npx -y sap-ui-automation <command>`.

## Commands

With no arguments, `sap-ui-automation` serves MCP over stdio.

| Command | Does | Same as |
| --- | --- | --- |
| `sap-ui-automation sessions` | lists the SAP sessions open now | `sap_sessions` |
| `sap-ui-automation use <ref>` | makes a session the active one | `sap_use` |
| `sap-ui-automation look [--full] [--diff] [--id <id> [--rows 0-50] [--cols A,B]] [--print]` | writes the screen to a file and prints a few short lines (where the screen is, the status bar) and the file's path (`--print` prints the screen) | `sap_look` |
| `sap-ui-automation act '<json>' [--full]` | runs one action ([actions](../reference/actions.md)) | `sap_act` |
| `sap-ui-automation act '[<json>, ...]' [--full]` | runs one screen's actions in one call | `sap_act` with `actions` |
| `sap-ui-automation act set <id> <value>`, `press <id>`, `key <n>`, `okcode <cmd>`, `select <id>`, `check <id> [true\|false]`, `combo <id> [key]`, `f4 <id>`, `dblclick <id>`, `scroll <id> <to>`, `open <intent>` | shorthand for one action | `sap_act` |
| `sap-ui-automation okcode <cmd>` | same as `act okcode <cmd>`: it submits, no Enter after it | `sap_act` |
| `sap-ui-automation open <intent>` | same as `act open <intent>`: a Fiori app, e.g. `'#SalesOrder-manage'` | `sap_act` |
| `sap-ui-automation screenshot` | writes a PNG of the window or tab | `sap_screenshot` |
| `sap-ui-automation record <op> ['<json>']` | `start <name>`, `assert '{"check":"status","contains":"saved"}'`, `stop`, `list`, ... | `sap_record` |
| `sap-ui-automation daemon status\|stop` | the background process that keeps the session attached between commands | |

`act`, `okcode` and `open` print the whole answer, as `sap_act` gives it
(the notes, then the lines that changed or the new screen); `look` prints
a short summary. Each also prints the path of a file that holds the whole
answer.
`look`, `act`, `okcode`, `open`, `screenshot` and `record` take `--session <ref>`. Exit codes:
0 done, 1 error or refused, 2 usage.

| Variable | Default | Meaning |
| --- | --- | --- |
| `SAP_CLI_DIR` | `.sap-gui/screens` | where answers and screens are written |
| `SAP_CLI_IDLE` | `30` | minutes without a command before the daemon exits |
| `SAP_CLI_SESSION` | one daemon per directory | a name: one daemon for every directory that sets it |

### Several actions in one call

A JSON list in place of one action sends the list as `actions`: up to 20
actions, run in order, with one answer.

```sh
sap-ui-automation act '[{"do":"set","id":"ctxtVBAK-VKORG","value":"1000"},{"do":"set","id":"ctxtVBAK-VTWEG","value":"10"},{"do":"key","key":0}]'
```

Quote the list as one argument. Each entry is an action, and may add
`expect`, `show` and `unseen` ([Several actions in one call](../concepts/actions.md#several-actions-in-one-call)).
The printed summary starts with the `Ran k of n actions.` line, which says
why the batch stopped when it did. The exit codes are the same: a batch
that stops at a popup or a status message exits 0, one where an action
failed or was refused exits 1.

The daemon keeps the `SAP_*` settings it started with. A later command with
different settings is refused: run `sap-ui-automation daemon stop` first.

The same settings apply as for the MCP server: writes stay refused
unless `SAP_WRITE` allows them ([configuration](../reference/configuration.md)).
The CLI cannot ask you, so `SAP_WRITE=confirm`, the default, refuses writes here: a
write needs `SAP_WRITE=on`, and your approval of each command is then the
confirmation. The settings are yours: the bundled skill tells the agent
never to set `SAP_*` itself, but an agent with a shell could put
`SAP_WRITE=on` in front of a command, and only your command approval stops
that ([Security](../security.md#what-the-agent-can-do)).

## Teaching the agent

`sap-ui-automation install --skills` copies the bundled skills, among them
[`sap-ui-automation`](https://github.com/DidroAI/sap-ui-mcp/blob/main/skills/sap-ui-automation/SKILL.md)
and a `sap-ui-automation-cli` skill on driving SAP through these commands, into the
agent's folder: `.claude/skills` (Claude), `.agents/skills` (Codex) or
`.cursor/rules/<name>.mdc` (Cursor), chosen with
`--target claude|codex|cursor|all` (default `claude`); `--global` uses `~/.claude/skills` and
`~/.agents/skills` instead. `setup` installs them for the user as well. `sap-ui-automation init` does this as part of setting a project
up. The skill tells the agent
how SAP screens behave: fields take effect on Enter, popups come first,
value help instead of guessed codes, and never work around the write
setting.

## MCP or CLI?

Use MCP when the client supports it: the answers arrive as tool results and
the client can ask you to confirm writes. Use the CLI when the agent has
only a shell, or when you want the agent to write SDK scripts and tests
from what it did (while a recording is on, every action also prints its
SDK line, see [Writing tests](sdk-tests.md)).
