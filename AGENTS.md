# Notes for coding agents

This repository is SAP UI MCP: an MCP server, a CLI (`sap-ui-automation`) and an SDK that see and interact with SAP screens. People are in
[CONTRIBUTING.md](CONTRIBUTING.md); this file is the short version for agents.

## Commands

```sh
bun install --frozen-lockfile
bun run typecheck
bun run test          # bun test ./test; no SAP system needed, SAP and Chrome are faked
bun run build
```

Browser tests run only with `SAP_TEST_CHROME=<path to a Chrome or Chromium>`;
without it they are skipped. PowerShell scripts are parse-checked on Windows only.

## Where things are

- `src/server.ts`: the MCP tools. Every action goes normalise
  (`src/core/action.ts`) → assess (the surface) → guard (`src/core/guard.ts`) → act.
- `src/core/`: guard, session registry, views. `src/sapgui`, `src/webgui`,
  `src/fiori`: one surface each. `src/cli/`: setup, doctor, daemon, agent CLI.
  `src/record`, `src/runner`, `src/sdk`: recording, tests and the SDK.
- `docs/`: the documentation site; it ships in the npm package.

## Rules

- The guard is the product: no change may let an action that may write run
  under `SAP_WRITE=off`, or without the user's yes under `confirm`. Add a test
  for any change near `src/core/guard.ts`, the assess functions or `decide`.
- Errors the agent reads say what was wrong and what to do instead.
- Tool descriptions and answers are read by models on every call: keep them short.
- Never commit SAP passwords, system names of real customers, or captures.
- New dependencies: an exact version, published at least seven days ago (`bunfig.toml`).
