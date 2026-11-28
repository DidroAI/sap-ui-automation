# Changelog

All notable changes to this project are listed here. The project follows
[Semantic Versioning](https://semver.org); before 1.0, a minor version may
change the tools or the view format.

## Unreleased

### Changed

- The product is now called SAP UI MCP, and the repository is
  DidroAI/sap-ui-mcp. The npm package, the commands, the skills and the MCP
  server id keep the name `sap-ui-automation`, so existing setups keep working.
- Docs, CLI help and agent skills use `sap-ui-automation` for shell commands.
- Chrome extension 0.4.4: named SAP UI MCP, with the new icon.

## 0.5.1

### Fixed

- A tool call that names an unavailable SAP session now asks the agent to
  select an open session before continuing.
- Setup preserves customized, unmarked skills when installing or migrating
  the bundled SAP skills.
- First-run instructions explain client approval behavior and how to
  preserve unsaved work when opening a transaction.
- The Linux Node 24 CI check runs the browser tests against Chromium.

### Changed

- The extension (0.4.2) links to its guide on docs.didro.ai from Chrome's
  menu (right-click the icon, then its name), instead of the repository.

### Documentation

- The Chrome extension is public in the Chrome Web Store; the docs no
  longer call it unlisted.

## 0.5.0 (2026-11-26)

### Fixed

- Network reader (SAP GUI without scripting), from the failing and the
  expensive runs of the last round (Claude Haiku, ECC and S/4HANA):
  - `set` on a dropdown chooses its entry, as on the other surfaces (FB50's
    D/C was refused as "does not take text").
  - After a cell right of a table's edge was reached with Tab, the table's
    fixed columns (FB50's G/L account, D/C, amount) stay in reach; only the
    columns that moved wait for SAP's next screen.
  - BP's locator "Start" (`BUS_LOCA_SRCH01-GO`) is a search, by the rule the
    scripting and Web GUI surfaces already apply to a button named as the
    start of a search; with `SAP_WRITE=off` it was refused as a write.
  - A dropdown key SAP sends without the list's leading zeros (BP's "1" for
    01) is the same entry: it was chosen again, then reported as not taken.
  - A subscreen that scrolls on its own (XD01's address tab): an action on
    an element scrolled out of view is refused with the scroll that brings
    it up (the click landed elsewhere), and `scroll` with id `screen` turns
    the wheel over that subscreen.
  - A classic list's page says the line it starts at (ME2L: 0, 25, 50): every
    page looked like the first, so scrolls answered "did not move" and a look
    with rows never got past the first page.
  - A scroll to rows after the page on show works when the last page starts
    on it (MM01's Select View(s): 17 of 28 on show answered "already there").
  - A grid read by range says which rows it shows ("(rows 49 to 70 of 71)"),
    not "49 more rows (22 sent so far)".
  - A key SAP shows with its text ("1000 C.E.B. BERLIN" for "1000") is not
    reported as a value SAP did not take.
  - A `set` after a dropdown choice on the same row typed into the dropdown
    (the click only closed it, and the caret check passed on the dropdown's
    caret): FB50's amounts never reached SAP. The caret must now be inside
    the field, and a second click waits out the double-click time (two quick
    clicks on a table cell chose it, and SAP dumped).
  - A dropdown's entry is chosen by its place in SAP GUI's cached list, with
    no Enter (typing the text missed when entries share first letters, and
    the Enter could reach SAP); an empty key chooses the blank entry, as on
    the other surfaces.
  - ME21N's requisition and its item are reached with Tab: from the first
    column (a click drifts right across the table), the Tabs 80 ms apart
    (SAP GUI dropped a burst); a cell left of the one typed last goes back
    with Shift+Tab.
  - SAP GUI's request is read for the table cells it sends: a value that did
    not reach its cell is said so, with the cell it went into instead.
  - A dropdown choice whose Enter went to SAP is said so.
  - What an update keeps of a container that scrolled on its own moves with
    it (XD01's labels stayed at their old rows).
  - `scroll` with id `screen` works when a field lies under the window's
    edge, whatever SAP's scroll item said (VA05).
  - Each action's line says the success message of the screen it ended on:
    in a batch FB50's "Document ... was posted" (the answer to Enter at its
    tax warning) was lost under the next action's "Enter valid date".
  - A `set` into a read-only field names the open field beside or above it
    (MIGO takes the storage location typed into GOITEM-LGOBE, and on S/4 the
    material into GODYNPRO-MAKTX).
  - Buttons on a screen that only displays (its title says so, its keys
    were read, none is an offered Save) move to other views, as on the
    scripting surface: BP's "Company Code" in "Display Organization" was
    refused with writes off.
  - The session window, and a popup's area, are found by the dynpro's own
    title when a value help's caption replaced it (S/4 ME2N: every action
    failed with "No SAP GUI window titled ...").
  - The field SAP put the cursor on is typed into without a click when
    nothing was input since SAP's screen, also where the view lays it out
    of view (XD01's country after "Fill out all required entry fields":
    SAP GUI scrolls to the cursor, SAP's own count does not say so).
  - A field scrolled out of view in a subscreen that scrolls on its own is
    reached with Tab from the field on show before it, when only input
    fields lie between (XD01's country).
- A batch goes on after a `scroll` that leaves the status bar's error as it
  was, as after `set`, `check` and `focus` (shared batch rule).
- A key written as the views print it, with its button's text first
  ("Next page (Shift+F11)"), is that key, on every surface.

### Changed

- **`SAP_WRITE=confirm` is the default**, instead of `off`. Each action
  that may write waits for your yes, asked in the client (MCP elicitation)
  or, in a script, by `onConfirm`. A client that cannot ask (Claude
  Desktop, Cursor, `claude -p`, `codex exec`), the agent CLI (`sap-gui`),
  and a test or script without `onConfirm` still get every write refused;
  the refusal and the server's log say how to get writes.
- To keep the old behaviour, set `SAP_WRITE=off`: read-only, every write
  refused, no question and no note. `on` is unchanged.
- In Codex's Full Access mode (approvals set to never), Codex accepts the
  question without showing it, so `confirm` protects nothing there: use
  `off`.
- `sap_act`, `sap_replay` and `sap_code_test` are marked destructive only
  with `SAP_WRITE=on` or `SAP_ALLOW_LOGOFF=on`. Under `confirm` the server
  asks before each write itself, so clients such as Codex do not also ask
  before every navigation.

- Network reader: a shorter compact view. A grid names each column by one
  title and its empty columns by id only; a table control names its open
  columns right of the edge by title only; the keys every screen has, and on
  SAP Easy Access all keys, are left out; a selection screen's texts show as
  text; an icon with a quick info shows the text. 17% fewer characters over
  the screens of two captured runs (46% on Easy Access). The full view and a
  look by id keep everything.

## Unreleased

### Fixed

- Extension 0.4.3: on first run, the first system's password field stayed
  off when the helper was installed after the extension (the usual order:
  extension from the store, then `setup --extension`). An open form now
  follows the helper, and the field opens up within seconds.

## 0.4.1 (2026-11-26)

### Changed

- The extension (0.4.1) shows `npx -y sap-ui-automation setup --extension`
  as its one setup command, in the first-run steps and wherever it says
  how to install the helper.
- `setup` prints a short summary instead of a line per agent: the agents
  grouped by what they got (server and skills, server only, skills only,
  not set up, skipped), counts instead of paths, short names. What needs
  doing by hand comes in one "Needs your attention" block, one item per
  issue with the agents under it, and the next steps are numbered. The old
  per-agent lines, with their paths, are behind the new `--verbose`.
- The picker lists the agents found first and the others under "Not
  found", and leaves one line ("19 agents selected") once answered.
- Colour on a terminal (a green ✓, a yellow !, dim secondary text), none
  when `NO_COLOR` is set or the output is not a terminal.
- `setup --extension` switches an existing `sap-ui-automation` entry to the
  extension: in a JSON file or Codex's `config.toml` it adds
  `SAP_BROWSER=extension` to the entry's env and changes nothing else. For
  Claude Code it gives the command that re-adds the entry with it.

## 0.4.0 (2026-11-26)

### Changed

- `setup` works like `npx skills add`, with the MCP server too: it lists the
  coding agents it finds, asks in a terminal which to set up (the ones found
  are ticked), and gives each one the server and the skills. It knows 25
  agents: besides Claude Code, Codex, Claude Desktop, Cursor, Windsurf and
  VS Code, now GitHub Copilot CLI, Gemini CLI, Antigravity, OpenCode, Cline,
  Kiro, Zed, Goose, Amp, Junie, Warp, Qwen Code and Factory Droid (server
  and skills), and Roo Code, Crush, Augment, Continue, Kilo Code and Trae
  (skills only). See the table in [CLI commands](docs/reference/cli.md#the-agents).
- New options: `--agent <ids>` / `-a` (`'*'`: every agent found), `--yes` /
  `-y` (no question), `--no-mcp` (the skills only). Names given as before
  (`setup codex cursor`) still work.
- The skills get one copy in `~/.agents/skills` and a link to it in each
  other agent's folder (a copy where no link can be made). A rerun updates
  the copy in place.
- Config files keep their comments and layout where setup adds the server.
- For agents setup does not know, `npx skills add DidroAI/sap-ui-mcp`
  installs the skills.

## 0.3.1 (2026-11-26)

### Changed

- `setup --extension` installs the extension's helper too: one command sets
  up the agent apps, the skills and the helper. Its closing lines say what
  to do in Chrome, with the store's link.

### Documentation

- The Chrome extension is in the Chrome Web Store (unlisted):
  https://chromewebstore.google.com/detail/ui-automation-for-sap/geglpbkaklfpmnbidfcpflegmdkjodkn.
  The guides and the server's messages install it from there, with
  `extension helper`; loading it unpacked stays for developers.

## 0.3.0 (2026-11-26)

### Fixed

- SAP GUI for Windows: `set` into a field SAP keeps closed says why (after
  an error or a warning SAP opens only the fields its message names)
  instead of "The method got an invalid argument".
- SAP GUI for Windows: a click on an ALV grid's or a table control's row
  selects the row; it was refused as "not a button", and under
  `SAP_WRITE=off` as a possible write.
- SAP GUI for Windows: a field's id with another type in front
  (`ctxtRF05L-BELNR` for `txtRF05L-BELNR`), a selection criterion's name
  (`MS_MATNR`) and a table column written as the legend shows it
  (`txtKONP-KBETR`) find their control.
- SAP GUI for Windows: a table column's id with a `row` (`set` on
  `txtRV45A-KWMENG` with row 1) is that row's cell; a dropdown in a table
  cell takes `row` and `col`; `press` on a tab selects it; an ALV grid takes
  `"how":"cell"`; `WERKS-LOW` finds `MS_WERKS-LOW` when only one field ends
  so; the rows of a list without a scrollbar are read instead of refused.
- An Enter right after an okcode that only expects "any screen" or "a
  popup" is skipped like a bare one; it ran on the empty initial screen
  ("Enter valid date").
- `sap_act` with `actions` and a top-level `expect`, `"do":"look"` or `app`
  runs the actions (the `expect` goes to the last one) instead of refusing
  "one action or actions, not both"; an empty `sap_act` answers with the
  screen.
- After a table's columns were said once ("as listed before"), the next
  change on that screen came back as the whole view: the diff printed the
  old column legend as removed. It is now the changed lines only (VA02: 5.4k
  characters to 170), on every surface.
- The number notation is read from grouped quantities with three decimals
  (`9.983,000`) and from tree nodes too (MMBE's stock overview said
  `NUMBERS unknown`).
- Network reader (SAP GUI without scripting), from the first end-to-end runs
  with writes (ECC, Claude Haiku):
  - `check` sets a box to the state asked for; a box already there is not
    clicked (it was toggled whatever the value said).
  - The Enter of a message popup (an error or information with only text,
    labelled "Confirm") acknowledges it, as on the other surfaces; with
    `SAP_WRITE=off` it was refused as a write.
  - A table cell can be named the way `sap_act` describes it, the table's id
    with `row` and `col`, or a column's field name with `row`.
  - A table's head names the columns open for input even while they are
    empty.
  - A screen SAP sends again with only what changed (FB50 after a warning)
    keeps the fields' texts, the values typed included, and its tabs; they
    showed as empty read-only fields.
  - `btn[N]`, a toolbar button's text with its key ("Display Document
    (F2)") and a tab's caption are ids, as on the other surfaces.
  - Dropdowns: the entries are read from SAP GUI's own cache on the PC, so
    `combo` lists them, takes a key or a text, refuses one that is not there,
    and chooses in one input (the list closed before when another window was
    brought forward); a choice shows as typed until the next Enter.
  - `set` in a cell of an editable ALV grid (ME51N's items).
  - A table cell right of what SAP GUI shows is reached with Tab from the
    nearest cell on show (SAP GUI scrolls the table sideways); the reader
    follows a table scrolled sideways (its fixed columns stay). Other actions
    on such a cell are refused: a click there typed into another cell.
  - Table rows were placed one row too high in tables with a title, and the
    click point of a row was at its upper edge: clicks into item tables
    missed. A row under the window's scroll bars is refused, with the scroll
    that brings it up.
  - A step whose answer goes through more than one screen keeps the status
    messages of the screens before the last: FB50's "Document ... was
    posted" was replaced by the next screen's error, and the agent posted
    again.
  - A screen taller than SAP GUI's window scrolls (`scroll` with id
    `screen`, the mouse wheel); clicks follow the scroll SAP reports, and a
    field under the window's edge is refused with that scroll instead of
    being clicked where another field is.
  - A popup SAP sends again as an update (after SAP GUI's type-ahead call)
    keeps its fields; it came back empty.
  - `set` clicks again when a dropdown chosen just before swallowed the click,
    and types nothing when the cursor still did not come; a second cell
    further right in a row reached with Tab goes on with Tab.
  - When SAP GUI shows a popup the traffic did not describe, the refusal
    says so and how to close it.

### Changed

- SAP GUI for Windows: the compact view leaves out SAP GUI's window line,
  the status bar's panes, its own toolbar buttons (new window, shortcut,
  settings, More, Enter), labels repeated on their fields and a selection
  screen's text fields. The full view keeps them.
- SAP GUI for Windows: typing into fields and moving the cursor no longer
  read the screen again, and the guard judges an action on the read of the
  moment before; a table control's cells are read without their tooltip
  and label. Batches that fill a form are several times faster.

## 0.2.1 (2026-11-25)

### Fixed

- `--version`, the MCP server's `serverInfo` and new recordings said
  0.1.0 in the 0.2.0 release.

### Documentation

- A "Choose your setup" page sends each reader to the right guide in four
  questions, with a table of which surface runs on which system.
- The Chrome guide starts with the three browser modes (`launch`, the
  default; `attach`; `extension`). It described `attach` as the default.
  One section says how to install the extension, which is in review in
  the Chrome Web Store.
- The README is shorter: what it is, where it runs, a quick start per way
  of working, status and limits.
- Added: the `browser` and `extension` commands, `export --to sap-ts`, the
  variables `SAP_CHROME_PATH`, `SAP_START_URL`, `SAP_CHROME_PROFILE`,
  `SAP_CHROME_ARGS`, `SAP_EXTENSION_WAIT` and `SAP_EXTENSION_START_CHROME`,
  FAQ entries for the launch and extension modes, and the install step the
  SDK needs in a project.
- Security pages cover the extension's local port and its passwords.
- A "Setup problem" issue template that asks for the output of `doctor`.

## 0.2.0 (2026-11-25)

### Fixed

- Log on from the extension's side panel failed with "The logon page looks
  different from SAP's": the panel keeps the window's focus, so the logon page
  never had it and the extension refused to type. The logon tab now gets focus
  for typing.
- Save (key 11) in Web GUI presses the Save button: Chrome could keep
  Ctrl+S for itself, and the key did nothing.
- SAP GUI for Windows: a selection screen (VA05, MMBE, ME23N) no longer
  shows a 785-row list; only a classic list is a list.
- A session opened with `/o` knows the number notation its sibling of the
  same logon already showed, instead of `NUMBERS unknown`.
- SAP GUI for Windows: buttons of a toolbar control (ME23N's document
  overview) are pressed again; SAP GUI refused them. Menu buttons list
  their entries and choose one with `"value"`.
- Table rows whose only cells are unticked checkboxes read as empty rows.
- A grid read with `cols` says which names matched no column.

### Changed

- The helper (`extension helper`) accepts the Chrome Web Store's copy of
  the extension (`geglpbkaklfpmnbidfcpflegmdkjodkn`) as well as the
  unpacked one.
- SAP GUI for Windows is read both ways at once by default
  (`SAP_GUI_METHOD` unset, or `auto`): SAP GUI scripting, and the network
  reader for connections logged on through its router. `sap_sessions`
  lists the sessions of both, and the agent works in the one it needs.
  `SAP_GUI_METHOD=scripting` or `diag` keeps to one, for setups where
  nobody watches the agent. `doctor` reports the two apart and is ready
  when one works.
- The skills carry the product's name: `sap-gui-drive` is now
  `sap-ui-automation`, `sap-gui-cli` is now `sap-ui-automation-cli`. Their
  descriptions name the transaction codes, business objects and phrasings
  that should make an agent pick them. `setup` and `install --skills` remove
  the copies they wrote under the old names, so the agent does not see each
  skill twice.
- `setup` installs the skills too, as the Cloud ALM server's setup does:
  for Claude Code (`~/.claude/skills`), Codex (`~/.agents/skills`) and
  Cursor, marked so that the next setup updates them; `--no-skills` leaves
  them out. `install --skills --global` puts Codex's in `~/.agents/skills`,
  where Codex reads a user's skills (was `~/.codex/skills`).
- Parallel sessions: `sap_sessions` tells the agent how to work in several
  sessions at once (one per task, `session` on every call). `sap_logon` has
  `newSession: true`: another session in a new window, on the same system
  or another, even when one is open. In Web GUI, `/o<tcode>` is followed
  into the new browser window, as in SAP GUI. A call that waits for its
  session's turn keeps to that session, even when another one becomes the
  active one meanwhile.
- `sap_logon` says whether the session is new or reused, its id, and
  whether SAP shows the logon's system, client and user. An extension too
  old for `newSession` is an error, not a reused tab that looks new.
- `sap_sessions` marks a Web GUI tab SAP shows no system for yet as not
  verified. At SAP's limit of sessions per logon, `/o` says so and points to
  another logon.
- The `sap-gui-drive` skill has a section on working in several sessions at
  once.
- The `sap-gui-drive` and `sap-gui-cli` skills are rewritten to follow the
  Agent Skills authoring guidance: a description that says what the skill
  does and when to use it, numbered steps, and current rules for sessions
  (`/o` in Web GUI too and sent on its own, "not verified", SAP's limit of
  sessions), numbers and Save.
- The SAP window opens on an empty tab the first time, instead of a local
  page; after that it opens the last SAP address, as before.
- `setup`, `doctor` and the error texts print commands as `npx -y
  sap-ui-automation ...`, which work without a global install.
- `setup` points out entries left under the server's old names
  (`sap-gui-mcp-server`, `sap-gui`), which give the agent the tools twice.
- The Chrome extension is now **UI Automation for SAP** (0.4.0) and opens
  as a side panel beside the page instead of a popup. The panel names the
  agent, says whether saves wait for your yes, lists each step the agent
  takes in SAP (transaction, field, value), turns amber while a save waits
  for your answer, and marks the system the agent works in. Systems are
  cards that open in place to add or edit; each step of the activity is one
  line that opens on a click. Settings gives the one command that connects
  an agent, and shows what the agent may do, as set in the agent. The Pause
  Sharing switch is gone:
  Cancel on Chrome's debugging bar still stops sharing, and the panel offers
  Share again.
- `setup --extension` adds the server with `SAP_BROWSER=extension`, for
  agents that should reach Chrome through the extension; an entry that is
  already there is named, with what to add to its env.
- With `SAP_BROWSER=extension`, the server sends the panel the agent's name,
  its write policy and each step (`panel` and `activity` notes on the relay;
  extension/PROTOCOL.md).

Preparing the first public release.

### Security

- A Fiori app sent as an okcode (`#SalesOrder-manage`,
  `/n#SalesOrder-manage`) now meets `SAP_ALLOW_TCODES` and
  `SAP_BLOCK_TCODES`, as `open` does.
- The active session stays where it is when its surface fails one
  discovery; before, the next call without a session named could run in
  another tab, on another system.
- Code tools refuse `\u` escapes outside strings, and `test.use` can no
  longer set `onConfirm`, `allowLogoff`, `allowSystems` or `env`.
- The extension relay answers a malformed request path with 400 instead
  of ending the server, and takes only small frames before pairing.
- The DIAG router no longer ends the server when SAP GUI resets its
  connection while the onward one is being dialled.
- `SAP_ALLOW_TCODES`, `SAP_BLOCK_TCODES` and `SAP_ALLOW_SYSTEMS` refuse
  entries that match nothing (`SE*`, `/nSE38`) when the server starts.
- A session reference such as `ABA` that fits several sessions is an
  error listing them, unless the active session is one of them.
- A confirmed write does not run when another call acted in the session
  while the user was asked; a queued `sap_act` keeps to its session when
  `sap_use` runs meanwhile; a new logon in the same SAP GUI session slot
  starts without what the server kept for the old one.

### For agents

- The server names itself (title, description, website) when a client
  connects.
- `destructiveHint` on `sap_act`, `sap_replay` and `sap_code_test` is
  false with `SAP_WRITE=off` and `SAP_ALLOW_LOGOFF` off, so clients that
  ask before every destructive call stop asking on each navigation.
- Arguments that do not fit a tool's schema are answered in plain words;
  `sap_record` accepts `do` for `op`; `sap_look` and `sap_act` are marked
  to load up front in Claude Code.
- A batch reports progress per action and stops when the client cancels.
- Batch-step fields (`expect`, `show`, `unseen`) on a single action are
  refused instead of ignored.
- `AGENTS.md`; the docs add the server under one name,
  `sap-ui-automation`, everywhere.

### Documentation

- A documentation site in `docs/` (VitePress): getting started, concepts,
  guides per surface, reference, security and data handling. It loads
  nothing from other sites. The same markdown ships in the npm package, so
  agents can read it offline.
- `CONTRIBUTING.md` describes the surface abstraction and how to add a
  surface; `SECURITY.md` has a threat model and a data-handling statement.
- `examples/`: MCP client configurations, prompts for common tasks, and a
  synthetic recorded test to replay and export.

### Install

- A Claude Desktop extension (`.mcpb`), built with `bun run build:mcpb` and
  attached to each release.
- Install docs with copy-paste snippets and install links for Cursor,
  VS Code, Windsurf and Codex.

### Fixes

- `sap-gui test` loads `sap.config.ts` and `*.sap.ts` as ES modules in a
  project whose `package.json` says `"type": "commonjs"` (what `npm init`
  writes). It used to fail with "Cannot use import statement outside a
  module".
- `init` creates a `.gitignore` in a git project that has none, so traces
  and results, which hold screens of business data, are not committed.
- zod 4.6.7 (GHSA-mrhx-c7xc-m3w5).
- With `SAP_WRITE=off`, changing or choosing a list layout (`&OL0`, `&OAD`,
  Settings > Layout) and further selection criteria or dynamic selections
  navigate instead of being refused. Saving or deleting a layout is still a
  write.
- A classic list's row range (`look` with `rows`) no longer reads a row twice
  or loses one at a page boundary.
- With `SAP_WRITE=off`, BP's Open BP and the locator's Start, and OK in
  Fiori's Adapt Filters dialog, navigate instead of being refused.
- Web GUI on S/4HANA reads dropdown cells of a table control (the Tax Code
  column in MIRO).

### Project

- CI runs on Linux, Windows and macOS with Node 22 and 24, checks what the
  npm package holds, runs the built command on plain Node, sets up a fresh
  project from the packed tarball (`init --yes`, `test --list`), and builds
  the docs site.
- CodeQL and Dependabot.
- Releases are published from a tag only, by a workflow, with npm
  provenance.
- Issue templates for bugs, features and new surfaces or transactions, each
  asking that business data be removed first.

## 0.1.0 (2026-11-24)

The first public version.

### Surfaces

- **SAP GUI for Windows**, through SAP GUI scripting, driven from Windows
  PowerShell (nothing else to install).
- **SAP GUI for HTML (Web GUI)** and **SAP Fiori** in Chrome. The server
  starts the installed Google Chrome itself, with a profile of its own (the
  SAP window), the first time the agent needs SAP: you log on there once,
  and nothing has to be set up in Chrome. The window stays open between
  agent sessions and is found again; `sap-ui-automation browser` opens it
  by hand; `doctor` says whether it runs. `SAP_CHROME_PATH` names the
  Chrome to start, `SAP_START_URL` the address a new window opens on.
- `SAP_BROWSER=attach` uses the browser you already work in instead
  (Chrome or Edge, once remote debugging is allowed at `chrome://inspect`).
  A DevTools endpoint named in `SAP_CHROME_CDP` wins over both.
- `SAP_BROWSER=extension` reaches your everyday Chrome through the **Agent
  Connector for SAP Systems** extension (`extension/`) instead: no remote
  debugging switch, only the tabs of the SAP systems registered in the
  extension are shared. The extension is a list of your systems (name, Web
  GUI or launchpad address, client, language, user) in SAP Fiori's Horizon
  look, with its own mark (no SAP artwork): *Add This SAP Page* fills one in
  from the current tab, *Log On* (or *Open*, *Show Tab*) opens it, and the
  More menu edits, forgets the password or removes it. With a saved password
  it logs on by itself, filling SAP's logon page like a password manager in
  a new private tab, from an isolated script world, on the system's own host
  only: the server and the agent never see the password. The agent gets
  `sap_systems` and `sap_logon`; `sap_logon` answers each outcome with what
  to ask the user (wrong password, locked user, new password needed, SAP's
  question about other logons, an identity provider, SAP's error page,
  paused, not registered, Chrome closed), never retries a refused password,
  and never ends the user's other logons (only `otherLogons: "keep"`, after
  the user said so). A tab that shows a password field is never shared with
  the server. On macOS and Windows the server starts Chrome when it is
  closed. `sap-ui-automation extension install` copies the extension and
  installs its helper (a native messaging host): the extension pairs in one
  click and keeps passwords only in the macOS Keychain, the Secret Service
  or Windows DPAPI; `extension uninstall` removes it all. The link to the
  server is a local WebSocket, paired with a code and encrypted (AES-GCM).
  See `extension/PROTOCOL.md`, `extension/PRIVACY.md` and the design and
  security review in `extension/REVIEW.md`.
- **SAP GUI without scripting (experimental)**: `SAP_GUI_METHOD=diag` reads
  the screen from SAP GUI's DIAG traffic through a local SAProuter, and acts
  with the keyboard and mouse (see below).
- Sessions are found by themselves; `sap_use` switches between them.

### Tools

- `sap_sessions`, `sap_use`, `sap_look`, `sap_act`, `sap_screenshot`,
  `sap_record`, `sap_replay`.
- One set of JSON actions on every surface: `set`, `press`, `key`,
  `select`, `check`, `combo`, `okcode`, `f4`, `focus`, `dblclick`, `tree`,
  `grid`, `toolbar`, `scroll` (and `click` on Fiori).

### The view

- A compact text view with one line per control, SAP's ids shortened to
  unique handles, labels paired with values, checkbox states, tree nodes,
  ALV grid cells, table controls, classic lists and popups.
- After an action that leaves the session on the same screen, only what
  changed (`SAP_VIEW=full` for the whole screen each time).
- Long lists: `scroll`, and `sap_look` with `id` and `rows` to read a range.
- An id that names several controls, or none, is refused with what the
  screen holds; the server never picks the nearest match.

### Safety

- Writes are off by default (`SAP_WRITE=off`); `confirm` asks the user
  for each one through MCP elicitation, and refuses it when the client
  cannot ask.
- Every action is classified as read, navigate or commit, failing closed.
- Allow and block lists for systems, transactions and browser origins.
- Never logs on, never types into password fields, never acts on a logon
  screen.

### Record and replay (prototype)

- `sap_replay` can resume at a failed step with a repair for that one step
  (`from`, `repair`, `"format":"json"`): a few actions or a capture, carried
  out under fixed rules (no added write, no leaving, no invented data, the
  recorded checks still judge), with a proposed change to the test in the
  result. The server calls no model.
- `sap_record` keeps a run as a test file; `sap_replay` and
  `sap-ui-automation replay` run it again with no model.
- `export` writes a SAP Cloud ALM manual test case, a SAP GUI script (VBS),
  a Playwright spec, or a Gherkin feature.

### SAP GUI without scripting (DIAG method, experimental)

- **Reading.** The decoder is our own (MIT), its item types, ids and sizes
  established from captured traffic. On the ECC screens captured while it
  was built, the view held nearly all the texts and values that SAP GUI
  scripting reads of the same screens, including ALV cells, tree nodes,
  table-control columns and popup entries. Controls of an ended
  transaction no longer show on the next one.
- **The view, as on the other surfaces.** The status bar is the `sbar` line,
  so errors and warnings come first in an answer; greyed-out buttons, keys,
  menus and tree nodes are marked, and `sap_look` with `id "mbar"` lists
  every menu entry; empty read-only fields show as `NAME@col=""`; a value
  typed with `set` shows as typed until SAP gets it with the next Enter,
  and a field that then shows something else is reported.
- **Ids.** A field name, `{FCODE}` of a push button or tab, a toolbar
  button or key by its text, `FIELD[n]` (the table's own row number, as the
  view prints it; a row not on show is scrolled to, and nothing is done if
  it does not come) or `@row,col`. Scripting cell ids `FIELD[col,row]`
  count the row from the first row on show. Toolbar buttons and function
  keys carry no function code in the traffic, so `{CODE}` does not name
  them: the refusal lists the screen's keys.
- **Actions.** `okcode`, `key`, `set`, `press`, `click`, `dblclick`,
  `select`, `check`, `focus` (fields), `f4` (fields), `combo`, vertical
  `scroll`, `tree`, `grid`, `toolbar`, and `sap_look` with `id`, `rows` and
  `cols`. Refused, with what to do instead: `focus`, `f4`, `set` or
  `check` where their first click would press, tick or open something;
  scrolling or reading other rows while typed values have not reached SAP;
  sideways scrolling; a grid toolbar button named by part of its name;
  input to a window that cannot be told apart without doubt from another
  SAP GUI window. The guard judges the input sent: a click on a push button
  or a box with a function code is rated as pressing it, a click on an
  element the reader cannot classify as a write.
- **Waits.** An action ends when SAP has answered the request of its last
  input, read from the traffic, not after a timer; `timing` says where the
  time went. A lost or unreadable answer ends the wait with "session state
  unknown", and the next `sap_look` recovers.
- **Record and replay.** Tests name controls the way the actions do and
  record the method (a `diag` test is not replayed through scripting, nor
  exported to VBS). Information popups are passed with their Enter key; a
  recorded Enter on a popup that only informed is not sent when SAP does
  not show it; the answer to a question is never skipped (the step fails);
  a screen damaged in transit is never judged.
- **Robustness.** Lost or garbled bytes no longer blind the connection: the
  decoder finds its place again (in linear time), and the view says when a
  screen may miss parts or holds something it cannot read yet. Compressed
  blocks over 64 MB are refused. The relay outlives a failing reader or
  capture, closed connections are let go, router messages go to stderr,
  and `doctor` reports what was lost or not read, and SNC (not readable).
- **Not verified live yet:** the actions, waits, cell sizes, window
  matching and record/replay ran against synthetic traffic and captures
  only, not against SAP GUI.

### Command line

- `setup` adds the server to Claude Code, Codex and Claude Desktop;
  `doctor` checks what the server can reach and says what to change;
  `sessions` lists the SAP sessions found.

### Also in the repository

- `skills/sap-gui-drive`, a skill for agents working in SAP screens, also
  shipped in the npm package and as a Claude Code plugin.
