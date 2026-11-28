# Examples

## Clients

How to add the server to each client, with a few prompts to try:

- [Claude Code](clients/claude-code.md)
- [Claude Desktop](clients/claude-desktop.md)
- [Codex](clients/codex.md)
- [Cursor](clients/cursor.md)
- [VS Code (GitHub Copilot)](clients/vscode.md)

Every client, in more detail: [Install in your client](../docs/getting-started/installation.md).

## Prompts

Longer prompts for common tasks: [prompts/](prompts/).

## Recorded tests

A test recorded with `sap_record` and replayed without a model: [recorded-test/](recorded-test/).

## SDK

- [sdk/check-order.ts](sdk/check-order.ts): a script that attaches to an open Web GUI session and checks an order in VA03.
- [sdk/va03.sap.ts](sdk/va03.sap.ts): the same check as a test for `sap-ui-automation test`.

See [Writing tests with the SDK](../docs/guides/sdk-tests.md). These need the SDK and the test runner, which ship with the next version.
