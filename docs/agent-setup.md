---
title: "Setting up sap-ui-automation (instructions for an AI agent)"
description: "For an AI agent with a terminal: the steps to install the sap-ui-automation MCP server, and what to do for each line doctor prints."
---

# Setting up sap-ui-automation (instructions for an AI agent)

You are an AI agent with a terminal (Claude Code, Codex, Cursor, ...). The
user asked you to set up the sap-ui-automation MCP server (npm package
`sap-ui-automation`). Follow these steps in order. Keep the user informed
in one or two lines per step. People: the prompt to paste is in
[Set up with your agent](getting-started/setup-prompt.md).

## Rules

- **Never type an SAP password and never log on to SAP.** The user logs
  on. The server refuses every action on a logon screen.
- Do not edit MCP client config files by hand: `setup` does it and keeps a
  `.bak` of each file it changes.
- Do not change `SAP_WRITE` unless the user asks. The default, `confirm`,
  requests MCP client approval for flagged writes. Codex Full Access can accept automatically.
- When a step needs the user to click something (SAP GUI options, Chrome,
  SAP Logon), say what to click and wait until they say it is done.

## 1. Check Node.js

Run `node --version`. It must be 22 or later. If Node is missing or older,
tell the user to install the LTS version from https://nodejs.org (or with
their package manager), and wait.

## 2. Run setup

```sh
npx -y sap-ui-automation setup --dry-run
npx -y sap-ui-automation setup
```

Show the user what the dry run would change, then run it for real. Run by
an agent (no terminal to answer in), `setup` asks nothing: it takes every
agent it finds. To limit it, pass `--agent <ids>` (see
[CLI commands](reference/cli.md)). Its "Next" lines say which apps to
restart; pass them on.

If the user works in their everyday Chrome through the UI Automation for
SAP extension, run `npx -y sap-ui-automation setup --extension` instead.

## 3. Run doctor

```sh
npx -y sap-ui-automation doctor
```

It prints one block per area, a line per check (`✓` or `✗`), and under a
`✗` a `→` line with what to do. Act on each `✗`, then run doctor again
until its last line starts with `Ready.`

| Output | What to do |
| --- | --- |
| `✗ Chrome: Google Chrome was not found on this machine` | Ask the user to install Google Chrome, or set `SAP_CHROME_PATH` to its program file. Nothing has to be switched on in Chrome. |
| `✓ SAP window: not running yet` | Run `npx -y sap-ui-automation browser`. A Chrome window opens. Ask the user to open their SAP address there (Web GUI or the Fiori launchpad) and log on, and wait. |
| `✗ Chrome: no Chrome with remote debugging allowed is running` | Only with `SAP_BROWSER=attach`. Ask the user to open `chrome://inspect/#remote-debugging`, tick "Allow remote debugging for this browser instance", then click Allow when Chrome asks. |
| `✗ Chrome extension: no SAP UI MCP extension connected` | Ask the user to install the extension from the [Chrome Web Store](https://chromewebstore.google.com/detail/ui-automation-for-sap/geglpbkaklfpmnbidfcpflegmdkjodkn), then run `npx -y sap-ui-automation setup --extension` and ask them to restart Chrome once. |
| `✗ Chrome extension: the extension is installed but not paired` | Ask the user to click the extension's icon in Chrome's toolbar and Pair (or run `npx -y sap-ui-automation extension pair` and give them the code it prints). |
| `✗ SAP systems: none registered in the extension` | Ask the user to open their SAP system in Chrome, click the extension's icon and "Add This SAP Page". |
| `✗ SAP GUI is running: not running` | Ask the user to start SAP Logon and log on to a system. |
| `✗ Scripting is on in SAP GUI: off` | Ask the user to open SAP Logon > Options > Accessibility & Scripting > Scripting, tick "Enable scripting", and restart SAP Logon. |
| `✗ Scripting is allowed on the SAP system` | The system has profile parameter `sapgui/user_scripting` off. Only the SAP Basis team can set it to `TRUE` (transaction RZ11). Tell the user so, and go on: Web GUI and Fiori, or the network reader, may work without it. |
| `✗ Notice "a script is attaching" is off` (or "opens a connection") | Ask the user to untick "Notify when a script attaches to SAP GUI" and "Notify when a script opens a connection" in the same Scripting options. |
| `✗ PowerShell may run the host` | A Windows policy restricts PowerShell. Only the user's IT team can allow it. Tell the user so, and suggest Web GUI or Fiori in Chrome, which need no PowerShell. |
| `– not checked: it runs only on Windows` | Not an error. SAP GUI for Windows needs Windows; on macOS and Linux use Web GUI or Fiori. |
| Any other `✗` | Read the `→` line to the user and do what it says. [FAQ and troubleshooting](faq.md) has one entry per check. |

On Windows, doctor checks SAP GUI two ways (scripting and the network
reader). One that works is enough.

## 4. Check in the agent

When doctor says `Ready.`, ask the user to restart the agent apps setup
named and to open an SAP screen. In the new session, call `sap_sessions`
and `sap_look`, and describe the screen in three lines.

## 5. Tell the user how writes work

Report the effective write mode. Under `confirm`, flagged writes require an
affirmative client response. Codex Full Access may accept automatically.
A client without elicitation refuses flagged writes, as does `SAP_WRITE=off`.
See [Confirm mode](concepts/confirm-mode.md).
