---
title: "Security and data handling: where SAP screen content goes"
description: "For SAP security, Basis and data protection: what runs where, what leaves the machine, what is written to disk, and what the agent can do under each setting."
---

# Security and data handling

This page is for the people who decide whether an agent may work in SAP:
SAP security, Basis and data protection. It says what runs where, what
leaves the machine, what is written to disk, and what the agent can do
under each setting.

To report a vulnerability, see
[SECURITY.md](https://github.com/DidroAI/sap-ui-mcp/blob/main/SECURITY.md).

## In short

- **It runs locally.** The server is a process on the user's machine,
  started by the user's MCP client (Claude Code, Codex, Cursor, ...). There
  is no hosted service and no account.
- **No telemetry, no analytics, no update checks.** It sends nothing to
  Didro or to any other third party.
- **It talks only to what the user already uses:** SAP GUI on the same
  machine, Chrome through its local DevTools endpoint (a Chrome window the
  server starts, the user's Chrome or Edge, or the user's Chrome through
  the extension's local port),
  and, with the network reader only, the SAP system or router SAP GUI is
  already connected to.
- **Screen content goes to the MCP client, and from there to the model
  provider the user chose.** That is the only path off the machine, and
  the user controls it.
- **No credentials.** It never logs on, never stores a password, never
  types into a password field. It works in sessions the user opened. The
  optional Chrome extension is the exception the user chooses: it keeps
  the passwords of the systems registered in it in the system's keychain
  and types them into SAP's logon page itself; the server and the agent
  never see them
  ([extension/PRIVACY.md](https://github.com/DidroAI/sap-ui-mcp/blob/main/extension/PRIVACY.md)).
- **The default requests MCP client approval.** A flagged write
  runs only after the client accepts it
  (`SAP_WRITE=confirm`), and is refused where the client cannot ask.
  Codex Full Access can accept automatically. `SAP_WRITE=off` refuses flagged writes.
- **Files are written only to local folders**, named by environment
  variables (with defaults in the working directory), and only when a
  recording, saved test code, a download or a debug capture is asked for.

## What runs where

```
 User's machine                                                  │  Elsewhere
                                                                 │
 MCP client ──stdio──▶ sap-ui-automation ──▶ SAP GUI (scripting)│──▶ SAP system (as today)
     │                       │                                   │
     │                       ├──▶ Chrome / Edge (DevTools, local)│──▶ SAP system (as today)
     │                       │                                   │
     │                       └──▶ 127.0.0.1:3298 router ─────────│──▶ SAP system (diag method only)
     │                                                           │
     └──────────── screen content, screenshots ──────────────────│──▶ model provider chosen by the user
```

The connection from SAP GUI or the browser to the SAP system is the one the
user already has. The server adds no new path to SAP, except that SAP GUI's traffic passes
through a relay inside the server on its way when a connection entry routes
through it (the network reader). On Windows that relay listens on
`127.0.0.1:3298` unless `SAP_GUI_METHOD=scripting`; it accepts connections
from this machine only.

## Data flows

| From | To | What | How | Leaves the machine? |
| --- | --- | --- | --- | --- |
| SAP GUI for Windows | server | the screen's controls, texts and values | SAP GUI scripting, through a Windows PowerShell process the server starts | no |
| Chrome or Edge | server | the content of SAP tabs (Web GUI, Fiori) | Chrome DevTools protocol on the local endpoint the browser announces, or the one named in `SAP_CHROME_CDP` | no |
| Chrome extension | server | the DevTools protocol of the tabs of registered systems only (`SAP_BROWSER=extension`) | a WebSocket to the server on `127.0.0.1` (ports 47823 to 47830), after pairing | no |
| SAP GUI | server, then SAP | SAP GUI's DIAG traffic (network reader only) | a SAProuter on `127.0.0.1` that relays to the next hop of the route | only to the SAP system or router, as before |
| server | MCP client | the screen as text, action results, screenshots | stdio | no |
| MCP client | model provider | what the client puts in the model's context | the client's own connection | **yes**, to the provider the user configured |
| server | disk | recordings, downloads, debug captures | local files (below) | no |

The server itself calls no model. Replaying a recorded test needs none.

## What is stored on disk

| What | Folder | Written when | Holds |
| --- | --- | --- | --- |
| Recorded tests and their exports | `SAP_RECORD_DIR` (default `./sap-tests`) | after `sap_record start`, or with `SAP_RECORD=on` | the actions, the values typed, screen titles and status bar texts, checked field values |
| Test code the agent saves, and its run traces | `SAP_RECORD_DIR` | only with `SAP_CODE_TOOLS=on`, on `sap_code_save` and `sap_code_test` | the `*.sap.ts` file; a copy while it runs, deleted after; traces under `sap-results` |
| Files Web GUI exports "to a local file", browser downloads | `SAP_DOWNLOAD_DIR` (default `downloads` in `SAP_RECORD_DIR` when set, else `./sap-downloads`) | when an action in Web GUI produces such a file | whatever SAP exported |
| SDK test runner traces | configured output directory (default `./sap-results`) | when a test uses SAP | compact screens and action values, plus step PNGs when screenshots are enabled |
| Raw DIAG traffic | `SAP_DIAG_CAPTURE` | only when set | the whole SAP GUI session, **logon included**; file mode 0600 |
| Reports and exports from the command line | the paths given (`--junit`, `--out`) | when the user runs the command | test results, the test steps |

`./` is relative to the working directory. The MCP client chooses it when it
starts the server. The `sap_screenshot` tool returns its image to the client.
The SDK test runner can also save screenshots in a local trace. Review
traces and exports before sharing them. Leave `SAP_DIAG_CAPTURE` unset
outside debugging.

## What the agent can do

The agent acts as the SAP user whose session it works in. SAP's
authorisations are the real limit. On top of them, the server classifies
every action before it runs as **read** (value help, expanding a tree,
scrolling), **navigate** (typing, Enter, tabs, Back, Execute F8) or
**commit** (anything that may save, and anything not known to be safe).

| `SAP_WRITE` | Read and navigate | Commit (Save, Post, Delete, Release, Yes on a save popup, unknown buttons) |
| --- | --- | --- |
| `confirm` (default) | allowed | run only after the MCP client accepts that exact action; refused when the client cannot ask |
| `off` (read-only) | allowed | refused |
| `on` | allowed | allowed |

Under every setting:

- the system and client must be in `SAP_ALLOW_SYSTEMS`, when set;
- the transaction must pass `SAP_ALLOW_TCODES` and `SAP_BLOCK_TCODES`;
- browser tabs must be of an origin in `SAP_ALLOW_ORIGINS`, when set;
- the command field is used only through the `okcode` action;
- logging off is refused unless `SAP_ALLOW_LOGOFF=on`;
- password fields and logon screens are refused.

With `SAP_WRITE=off` the agent can still **read** everything the SAP user
can display, and can start reports with Execute (F8). Some reports update
the database when executed: block them with `SAP_BLOCK_TCODES`.

With `SAP_CODE_TOOLS=on` (off by default) the agent can also **save and
run test code** on the user's machine: `sap_code_save` writes a `*.sap.ts`
file to `SAP_RECORD_DIR`, and `sap_code_test` runs it with the user's
rights. Every SAP action in it goes through the same guard, under the
server's `SAP_WRITE` and transaction lists. The code is checked before it is
saved and before it runs (imports, forbidden words such as `process` and
`fetch`, no write the recording of the same name does not have), but these
checks are defence in depth, not a sandbox: the code runs in the server's
own process. Text on an SAP screen can try to steer what the agent writes.
Turn it on only where you would let the agent's author run scripts on that
machine. See
[Code tools](guides/record-replay.md#code-tools-sap-code-save-and-sap-code-test).

With `confirm`, the MCP client asks the user (MCP elicitation), so the
agent cannot answer for them. A client without elicitation cannot ask, and
every write is refused. Codex in Full Access mode (approvals set to never)
accepts the question without showing it: there use `off`. With such a client, `SAP_WRITE=on` plus the
client's own approval of each `sap_act` call is the alternative; that
approval is then the only check on writes. The agent CLI cannot ask either.
See
[Confirm mode](concepts/confirm-mode.md).

**The agent CLI and a shell.** The settings are environment variables. An
agent that can run shell commands (Bash in Claude Code, Codex, Cursor) can
start the agent CLI with `SAP_WRITE=on` in front of the command itself.
The CLI cannot tell who set it. The bundled skills tell the agent never to
set `SAP_*` itself, but only your approval of each command actually stops
it: do not auto-approve `sap-ui-automation` commands, or shell commands in general,
when the agent works on a system where writes matter. The same applies to
an agent that can edit its MCP client's configuration.

**Not tried on a live system yet:** confirm mode on Fiori and on SAP GUI
for Windows (it was tried on Web GUI through interactive Claude Code: the
question, a decline, and a screen that changed before the yes), and confirm
in clients other than Claude Code. Writes through the network reader have
run on test systems only ([Network reader](guides/network-reader.md#limits)).

More in the [safety model](concepts/safety.md) and the
[configuration reference](reference/configuration.md).

## Recommended settings for production systems

Start with a test or sandbox system. For a production system:

- **A dedicated SAP user with display authorisations only.** The server
  cannot exceed what the user may do; this is the control that holds when
  everything else fails.
- **`SAP_WRITE=off`** (read-only; the default is `confirm`). Use `confirm`
  only on systems where a wrong save can be reversed.
- **`SAP_ALLOW_SYSTEMS=PRD/100`**: name the systems and clients the agent
  may see. Sessions on others are hidden.
- **`SAP_ALLOW_TCODES`** with the transactions the task needs, or at least
  **`SAP_BLOCK_TCODES`** with the ones it must never open: `SE38`, `SA38`,
  `SE16N`, `SM30`, `SE37`, `SM59`, `SU01`, `PFCG`, and your own reports that
  update data on F8.
- **`SAP_ALLOW_ORIGINS`** with the SAP hosts, for Web GUI and Fiori.
- **A separate Chrome profile** for SAP work, so that remote debugging
  does not expose other tabs.
- **A model provider with zero data retention**, or a self-hosted model,
  under a data processing agreement that covers SAP data. Screen content
  reaches the provider; this is where personal data in SAP leaves the
  machine.
- **No other MCP servers that can send data out** (web, email, chat) in
  the same client session, if the data must not leave through them.
- **Leave `SAP_DIAG_CAPTURE` unset**, and keep
  `SAP_RECORD` off unless a test is being recorded.
- **Leave `SAP_CODE_TOOLS` off**: it lets the agent run code on the machine.
- **Pin the package version** in the client configuration
  (`sap-ui-automation@0.5.1`), so that the code that runs is the code you
  reviewed.

Example, for a read-only investigation:

```sh
SAP_WRITE=off
SAP_ALLOW_SYSTEMS=PRD/100
SAP_ALLOW_TCODES=VA03,MM03,ME23N,FB03,XD03
SAP_ALLOW_ORIGINS=https://sap.example.com
```

## Threat model, in summary

**Assets:** SAP data on screen; the user's SAP session and authorisations;
recordings, downloads and captures on disk.

**Actors:** the model or agent, mistaken or prompt-injected through text on
an SAP screen; other programs on the same machine, which can reach the
browser's DevTools endpoint and the network reader's local port; anyone who
gets a recording or a capture.

**Mitigations:** each write asked about by default (or refused, with
`SAP_WRITE=off`), failing closed; allow lists of
systems, transactions and browser origins on every call; the command field
only through `okcode`; no logon, no passwords; confirmations bound to one
action and the screen it was asked on; a write runs only on the screen the
agent was last shown; the network reader bound to `127.0.0.1`; DIAG
captures readable by their owner only; recordings confined to one folder.

**Not protected against:** an agent that passes what it read to another
tool it has; an agent with a shell that sets `SAP_WRITE=on` for the agent
CLI itself, where you approve commands without reading them; a custom
button whose text looks safe but writes; reports that
write on F8; other local programs using the DevTools endpoint; anything the
SAP user's authorisations allow once writes are on. The guard is a safety
net for an agent that makes mistakes, not a security boundary.

The full threat model is in
[SECURITY.md](https://github.com/DidroAI/sap-ui-mcp/blob/main/SECURITY.md).
