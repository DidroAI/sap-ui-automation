---
layout: home
title: "SAP UI MCP: an MCP server for SAP GUI, Web GUI and Fiori"
titleTemplate: false
description: "Let Claude, Codex, Cursor and other AI agents see and interact with the SAP screens you have open: SAP GUI for Windows, Web GUI and Fiori."
hero:
  name: SAP UI MCP
  text: Let AI agents see and interact with SAP screens
  tagline: SAP GUI for Windows, Web GUI and Fiori, in a compact text view. Runs on your machine.
  actions:
    - theme: brand
      text: Choose your setup
      link: /getting-started/choose
    - theme: alt
      text: Install in your client
      link: /getting-started/installation
    - theme: alt
      text: GitHub
      link: https://github.com/DidroAI/sap-ui-mcp
features:
  - title: The screens you already have open
    details: Finds your SAP GUI, Web GUI and Fiori sessions and works in them as you, under your SAP authorisations. It never sees a password. You log on, or the Chrome extension types the password itself.
  - title: A compact, complete view
    details: One line per control with SAP's own ids, labels, values and whether they can be edited. After an action on the same screen, only what changed.
  - title: Configurable write controls
    details: The default requests client approval for flagged writes. Codex Full Access can accept automatically. SAP_WRITE=off refuses flagged writes.
  - title: Runs locally, no telemetry
    details: Nothing leaves your machine except what your MCP client sends to the model provider you chose.
  - title: Record a run, replay it as a test
    details: An agent's run becomes a file that replays with no model, and exports to the formats test teams use.
  - title: Every MCP client
    details: Claude Code, Claude Desktop, Codex, Cursor, Windsurf, VS Code and any other client that starts a stdio server; a command line for agents without MCP.
---

<div class="launch-video">
  <h2>See it in 8 minutes</h2>
  <p>The Chrome extension, one setup command, then Codex working in two SAP sessions at once.</p>
  <div class="frame">
    <iframe src="https://www.youtube-nocookie.com/embed/YwM0q31qy2k" title="SAP UI MCP launch video" loading="lazy" allow="accelerometer; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen></iframe>
  </div>
</div>

<style>
.launch-video { max-width: 960px; margin: 48px auto 0; padding: 0 24px; }
.launch-video h2 { font-size: 24px; font-weight: 600; margin: 0 0 8px; border: 0; padding: 0; }
.launch-video p { margin: 0 0 16px; color: var(--vp-c-text-2); }
.launch-video .frame { position: relative; aspect-ratio: 16 / 9; border-radius: 12px; overflow: hidden; background: var(--vp-c-bg-soft); }
.launch-video iframe { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; }
</style>
