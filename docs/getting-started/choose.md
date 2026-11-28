---
title: "Choose your setup for SAP GUI, Web GUI or Fiori"
description: "Four questions to pick what to install: which SAP screens, which Chrome, whether SAP GUI scripting is allowed, and which agent you use."
---

# Choose your setup

Which setup do you need? Four questions take you to the right page: which
SAP screens, which Chrome, whether SAP GUI scripting is allowed, and which
agent. Each path ends with
`npx -y sap-ui-automation doctor`, which checks what the server can reach
and says what to change.

## Which SAP screens?

| You work in | Your computer | Go to |
| --- | --- | --- |
| SAP GUI for HTML (Web GUI) or SAP Fiori, in a browser | Windows, macOS or Linux | [Which Chrome?](#which-chrome) |
| SAP GUI for Windows | Windows | [Is SAP GUI scripting allowed?](#is-sap-gui-scripting-allowed) |
| SAP GUI for Java | macOS or Linux | not supported: use Web GUI or Fiori if your system offers them |

Several at once is fine: on Windows the server looks for SAP GUI, Web GUI
and Fiori sessions together.

## Which Chrome?

Web GUI and Fiori run in Google Chrome. Pick a browser mode
(`SAP_BROWSER`):

| You want | Mode | What you do |
| --- | --- | --- |
| nothing to set up in Chrome | `launch` (the default) | log on to SAP in the Chrome window the server opens ([guide](../guides/chrome.md#the-sap-window-launch-the-default)) |
| your everyday Chrome, with its single sign-on, and only your SAP tabs shared | `extension` | install the SAP UI MCP extension, pair it, register your systems ([guide](../guides/chrome.md#use-your-everyday-chrome-with-the-extension)) |
| your everyday Chrome or Edge, without an extension | `attach` | allow remote debugging in `chrome://inspect` ([guide](../guides/chrome.md#your-chrome-with-remote-debugging-attach)) |

Then go to [Which agent?](#which-agent).

## Is SAP GUI scripting allowed?

SAP GUI scripting must be on in SAP GUI on your PC **and** allowed on the
SAP system (`sapgui/user_scripting`). `doctor` checks both.

| Scripting | Method | Guide |
| --- | --- | --- |
| allowed, or your basis team can allow it | SAP GUI scripting | [SAP GUI for Windows](../guides/sap-gui-windows.md) |
| not allowed | the network reader (DIAG), **experimental**: reads SAP GUI's traffic through a local SAProuter; no SNC | [Network reader](../guides/network-reader.md) |

Both methods run by default (`SAP_GUI_METHOD=auto`); set
`SAP_GUI_METHOD=scripting` or `diag` to keep to one. Then go to
[Which agent?](#which-agent).

## Which agent?

| Your agent | Path |
| --- | --- |
| Claude Code, Codex, Cursor, Claude Desktop, Windsurf, VS Code, Gemini CLI, Copilot CLI, OpenCode, Goose, Cline and [more](../reference/cli.md#the-agents) | `npx -y sap-ui-automation setup` adds the server and the skills to each one it finds. One client by hand: [Install in your client](installation.md) |
| Claude Desktop, one click | the `.mcpb` file from the [latest release](https://github.com/DidroAI/sap-ui-mcp/releases/latest) ([details](installation.md#claude-desktop)) |
| Another MCP client | a stdio server with the command `npx -y sap-ui-automation` ([details](installation.md#other-clients)) |
| An agent with a shell and no MCP, or you want screens kept out of the chat | the `sap-ui-automation` command line and its skill ([CLI for coding agents](../guides/cli-for-agents.md)) |
| No agent: scripts and tests in CI | the SDK and the test runner ([Writing tests](../guides/sdk-tests.md)), or replay what an agent recorded ([Recording and replay](../guides/record-replay.md)) |

With `SAP_BROWSER=extension`, run `setup --extension` instead of `setup`.

## Then

1. `npx -y sap-ui-automation doctor` until it says `Ready.`
   ([what each ✗ means](../faq.md)).
2. Restart your agent, open an SAP screen, log on, and ask: *"Look at my
   SAP screen and tell me which fields are required."*
3. Check your write mode. Under the default, flagged writes require a
   client response. Codex Full Access can accept automatically.
   [Your first session](first-session.md).

Stuck? Open a [setup problem](https://github.com/DidroAI/sap-ui-mcp/issues/new?template=setup_problem.yml)
with the output of `doctor`.

## What runs where

| Surface | Windows | macOS | Linux | Method |
| --- | --- | --- | --- | --- |
| SAP GUI for Windows | yes | no | no | SAP GUI scripting and the network reader (experimental), both by default |
| Web GUI | yes | yes | yes | Chrome: `launch`, `attach` or `extension` |
| Fiori | yes | yes | yes | Chrome: `launch`, `attach` or `extension` |
| SAP GUI for Java | no | no | no | not supported |
