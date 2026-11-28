# Contributing

Thank you for helping. Bug reports, fixes, new screens the view gets wrong,
and words in more logon languages are all welcome.

By taking part you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).
Security issues go through [SECURITY.md](SECURITY.md), not public issues.

## Never put SAP data in an issue or a pull request

Screens, recordings, DIAG captures and logs from a real system hold your
company's data, and DIAG captures can hold a logon. Before you paste a
view or attach a file, replace names, numbers, texts, host names and user
names with made-up ones. Test fixtures in this repository are synthetic,
and must stay so.

## Set up

You need [Bun](https://bun.sh) 1.4.4 or later (the tests and the lockfile;
CI uses 1.4.4) and Node.js 22 or later (the built server runs on plain Node;
CI runs 22 and 24).

```sh
git clone https://github.com/DidroAI/sap-ui-mcp.git
cd sap-ui-mcp
bun install --frozen-lockfile
bun run typecheck
bun run test
bun run build
node dist/cli.js --help
```

`bunfig.toml` refuses packages published less than seven days ago. Pin new
dependencies to an exact version at least that old.

## How it fits together

```
MCP client (Claude Code, Codex, Cursor, ...)
   │  stdio, JSON-RPC
   ▼
src/server.ts        the MCP tools: sap_sessions, sap_look, sap_act, sap_screenshot, ...
   │                 every action: normalise (core/action.ts) → assess → guard (core/guard.ts) → act
   ▼
src/core/registry.ts sessions across surfaces, one driver per session, SAP_ALLOW_SYSTEMS
   │
   ▼  Surface / Driver (src/core/types.ts), built from SAP_SURFACES in src/surfaces.ts
   ├── sapgui        src/sapgui/        ──▶ Windows PowerShell host (src/sapgui/ps) ──▶ SAP GUI scripting (COM)
   ├── sapgui, diag  src/sapgui-diag/   ──▶ local SAProuter on 127.0.0.1 ──▶ DIAG decoder (src/diag)
   │                                        and keyboard/mouse input through PowerShell
   ├── webgui        src/webgui/        ──▶ Chrome DevTools protocol (src/browser, playwright-core)
   └── fiori         src/fiori/         ──▶ Chrome DevTools protocol (src/browser, playwright-core)
```

- **The server** (`src/server.ts`) knows only the types in
  `src/core/types.ts`. It never talks to SAP GUI or Chrome itself.
- **The registry** (`src/core/registry.ts`) asks every surface for its
  sessions, filters them by `SAP_ALLOW_SYSTEMS`, keeps one driver per
  session, and checks the driver is still on its session each time it is
  used.
- **A surface** finds sessions and opens drivers. **A driver** reads one
  session as text and runs actions on it.
- **The guard** (`src/core/guard.ts`) decides on every action from the
  surface's own classification (`assess`) and the settings: `SAP_WRITE`,
  the transaction lists, the command field rule, `SAP_ALLOW_LOGOFF`.
- **The view.** Each reader produces the same full format (a header line,
  `WINDOW` lines, then one control per line). `src/core/compact.ts` shortens
  it, `src/core/ids.ts` gives the short handles, `src/core/diff.ts` and
  `src/core/views.ts` decide whether an answer holds the whole screen or
  only what changed.
- **Record and replay** (`src/record/`) sit around `perform` in the server
  and drive the same `Driver` through the same guard.

The `diag` method is not a separate surface name: it is a second
implementation of the `sapgui` surface, chosen with `SAP_GUI_METHOD=diag`
in `surfacesFromEnv`.

## Where things are

| Folder | What |
| --- | --- |
| `src/core/` | what every surface shares: the `Surface` and `Driver` types, actions, the guard, the commit and safe words, the compact view, ids, diffs, the registry of sessions, the per-session queue |
| `src/sapgui/` | SAP GUI for Windows through scripting; `ps/` is the PowerShell host |
| `src/sapgui-diag/`, `src/diag/` | SAP GUI without scripting: the local SAProuter, input through PowerShell, and the DIAG decoder |
| `src/webgui/`, `src/fiori/` | Web GUI and Fiori in Chrome |
| `src/record/` | record, replay, export |
| `src/server.ts`, `src/surfaces.ts` | the MCP tools, and which surfaces run on this machine |
| `src/cli.ts`, `src/cli/` | the command line, `setup` and `doctor` |
| `src/browser/`, `extension/`, `native-host/` | the three browser modes; the Chrome extension and its helper |
| `skills/` | the agent skills (`sap-ui-automation`, `sap-ui-automation-cli`) |
| `docs/` | the documentation site (VitePress); the markdown also ships in the npm package |
| `examples/` | client configurations, prompts and a recorded test |

## Run it without an SAP system

The Linux Node 24 check installs the Chromium version pinned by Playwright and runs the browser tests. All CI tests run without a live SAP system or SAP GUI:

| What | How | Needs |
| --- | --- | --- |
| Unit tests: view, ids, diff, guard and the commit rule, registry, server, record and replay, DIAG decoder and router | `bun run test` | nothing |
| Web GUI reader and actions in a browser, on synthetic pages (`test/webgui-*.test.ts`, `test/chrome.test.ts`) | `SAP_TEST_CHROME=/path/to/chrome bun run test` | a Chrome or Chromium binary; skipped without it |
| PowerShell scripts parse, and the SAP GUI host and window tests | part of `bun run test` | Windows; skipped elsewhere |
| The built server, its PowerShell host and COM, against a fake SAP GUI | `bun run build && node test/sapgui/e2e.mjs` | Windows |
| The documentation site, and every link between its pages | `bun run docs:build` | nothing |

For the browser tests, any Chrome or Chromium works, for example
Playwright's (`npx playwright install chromium`). On Ubuntu 23.10 and
later, a Chromium that is not installed as a package may refuse to start
without a sandbox profile; the tests then fail to launch it, not on the
code.

The fakes:

- `test/fakes.ts`: a surface and driver in memory, for the server and
  registry tests.
- `test/sapgui/`: a fake SAP GUI scripting engine and its fixtures,
  described in [test/sapgui/README.md](test/sapgui/README.md). The text
  view of each fake screen is held to a golden file in
  `test/sapgui/fixtures/expected/`; after a change to the format that is
  meant, write them again with
  `UPDATE_EXPECTED=1 bun test test/sapgui/format.test.ts` and review the
  diff.
- `test/fiori-fixtures.ts` and the synthetic pages of the Web GUI tests:
  hand-written HTML that looks to the reader like the real thing.
- `test/diag/build.ts`: synthetic DIAG bytes, built item by item.
- `test/record-fakes.ts`, `test/diag-record-fakes.ts`: sessions that record
  and replay without SAP.

To try the server by hand, point an MCP client at your build
(`node /path/to/dist/cli.js`), or use the
[MCP Inspector](https://github.com/modelcontextprotocol/inspector):

```sh
npx @modelcontextprotocol/inspector node dist/cli.js
```

## With an SAP system

If you have a test system, these scripts check against it. They read a
password from a file and never print it, and they write screen content only
where you tell them to: keep that out of Git.

- `test/dev/webgui-logon.ts`, `test/dev/fiori-logon.ts`: log a throwaway
  Chrome on to a test system.
- `test/dev/soak.ts`: walks a logged-on Web GUI session through about sixty
  read-only steps and reports failures, time and tokens per step.
- `test/dev/measure.ts`: counts what each rule of the compact view saves.
- `node test/sapgui/e2e.mjs --real`: reads (never acts on) the SAP GUI for
  Windows session that is open.
- `scripts/diag-dev/replay.ts`: replays a DIAG capture
  (`SAP_DIAG_CAPTURE`) through the decoder.

The token counts use the Anthropic `count_tokens` API when
`ANTHROPIC_API_KEY` is set. These development scripts are not part of the
npm package; the server itself makes no such call.

## Good first contributions

- A screen the view reads wrong: a fixture with made-up data and the line
  you expected (see `test/sapgui/` or the synthetic Web GUI pages).
- Safe and commit words in another logon language (`src/core/words.ts`),
  with a test.
- A docs page that was wrong or unclear for your setup. Docs-only changes
  need `bun run docs:build` to pass, nothing else.

Issues labelled
[good first issue](https://github.com/DidroAI/sap-ui-mcp/labels/good%20first%20issue)
are a place to start.

## Add a surface

A surface is a kind of SAP front end, or a second way to reach one. Open an
issue first ("New surface or transaction"): it is a large change, and worth
agreeing on before you write it.

### 1. Implement the interfaces

Both are in [src/core/types.ts](src/core/types.ts).

`Surface`:

- `name`: a `SurfaceName`.
- `discover()`: the sessions open right now, as `SessionInfo` (id, system,
  client, user, transaction, title, where). It never logs on and never
  opens anything.
- `open(session)`: a `Driver` on one of them.
- `doctor()`: setup checks for `sap-ui-automation doctor`, each with what
  was found and, when not ok, the one thing to change.

`Driver`:

- `refresh()`: fresh header facts (system, client, transaction, title).
  The registry and the guard use them on every call.
- `valid()` (optional): is the driver still on its session?
- `look(options)`: the screen as text (step 2).
- `assess(action)`: read, navigate or commit, **before** the action runs
  (step 4).
- `act(action)`: run the action; a one-line note of what was done, or an
  `ActionError` whose message is meant for the model.
- `screenshot()`, `close()`, and `timing()` (optional).

### 2. The reader and the view

Produce the full view format the other readers produce: the header line
(`TRANSACTION ... PROGRAM ... SCREEN ... SYSTEM ...`), a `WINDOW` line per
window, then one control per line, `<id>  <type>  <label and value>
<state>`. Use SAP scripting ids where the front end has them. Then
`look({ compact: true })` is `compact()` from `src/core/compact.ts` on
that, and handles, diffs and recordings work without more code. For long
controls, give `src/core/rows.ts` a way to scroll and read, so `sap_look`
with `rows` works.

### 3. The action driver

Take the normalised actions of `src/core/action.ts` (`set`, `press`,
`key`, `select`, `check`, `combo`, `okcode`, `f4`, `focus`, `dblclick`,
`tree`, `grid`, `toolbar`, `scroll`). Resolve ids with `resolveId` from
`src/core/ids.ts`: a handle that names several controls, or none, is an
error that lists what the screen holds, never a guess. An action returns
when the front end has finished the round trip to SAP, not after a timer.
Document the subset you support; refuse the rest with what to do instead.

### 4. Guard classification

`assess` must fail closed: anything it does not know to be safe is a
commit. Reuse the words in `src/core/words.ts` and the logon screen check
there. Refuse password fields and logon screens. Rate an action that ends
sessions or the logon with `closes: true`. The guard in
`src/core/guard.ts` applies `SAP_WRITE`, the transaction lists and
`SAP_ALLOW_LOGOFF` on top; a surface never decides those itself.

### 5. Registration

1. Add its name to `SurfaceName` in `src/core/types.ts` and to
   `SURFACE_NAMES` in `src/core/registry.ts`.
2. Build it in `surfacesFromEnv` in `src/surfaces.ts`, and add it to the
   default list for the platforms it runs on.
3. Add it to the `SAP_SURFACES` help in `src/cli.ts`, and its checks to
   `doctor`.

### 6. Fakes and tests

Test without the real front end: a fake of what the surface talks to (see
`test/sapgui/` for SAP GUI, synthetic pages for Web GUI, `test/diag/build.ts`
for DIAG traffic, and `test/fakes.ts` for a surface in memory). Include:

- golden views of a few typical screens (a form, a table, a popup, a tree);
- tests for `assess` on every kind of control, including the ones that must
  be refused with `SAP_WRITE=off`;
- a record and replay round trip.

### 7. Docs

A guide page in `docs/guides/`, a line in `docs/concepts/surfaces.md`, its
requirements in the README, and a line in `CHANGELOG.md`.

## Documentation site

The site is [VitePress](https://vitepress.dev) in `docs/`, with its own
`package.json` and lockfile. It loads nothing from other sites: no
analytics, no hosted search, no external fonts.

```sh
bun run docs:dev     # local preview with live reload
bun run docs:build   # what CI builds; fails on a dead link
```

The same markdown files ship in the npm package, so agents can read them
offline. Links between pages are relative and end in `.md`
(`concepts/safety.md`); links to repository files use full GitHub URLs.

## Commit messages

[Conventional Commits](https://www.conventionalcommits.org), with the area
in brackets, as in `git log`:

```
feat(webgui): read the totals line of an ALV grid
fix(sapgui-diag): row buttons are writes
docs: say which DIAG actions work and which are refused
test(diag): lost bytes, joins, modes, large messages
```

The subject says what the change does, in plain words. The body, if any,
says why.

## Pull requests

- One change per pull request, with tests.
- `bun run typecheck`, `bun run test` and `bun run build` pass; for docs
  changes, `bun run docs:build` too.
- New or changed behaviour has tests on a fake or a synthetic page. No real
  SAP data, host names or user names anywhere in the diff.
- A change to what the guard allows needs a test that shows the actions that
  must stay refused are still refused.
- Say whether it was checked on a real system, and which surface, SAP release
  and front-end version.
- Docs updated where users see a change, and a line in `CHANGELOG.md`
  under "Unreleased".

The [pull request template](.github/PULL_REQUEST_TEMPLATE.md) holds the same
list.

## Releasing (maintainers)

The npm package is `sap-ui-automation`. Its trusted publisher on npm must
point to GitHub repository `DidroAI/sap-ui-mcp`, workflow `release.yml`,
environment `npm`. A maintainer can check it with
`npm trust list sap-ui-automation` before tagging a release.

1. Set the version in `package.json`, `server.json` (twice),
   `mcpb/manifest.json`, `.claude-plugin/plugin.json`, and `SERVER_VERSION`
   (`src/server.ts`) and `SDK_VERSION` (`src/sdk/session.ts`); a test checks
   they agree. Move the "Unreleased" changelog entries under it.
2. Merge that to `main`, then tag it there: `git tag v0.2.0 && git push origin v0.2.0`.
3. `release.yml` builds and tests, then waits for approval in the `npm`
   environment. Once approved it publishes to npm through trusted publishing
   (no token: npm trusts this workflow and that environment), creates the
   GitHub release with the `.mcpb`, and lists the version in the MCP Registry.
   If the registry step fails, run the "MCP Registry" workflow by hand.
