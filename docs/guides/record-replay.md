---
title: "Record an agent's SAP run and replay it as a test"
description: "Keep an agent's SAP run as a test file, replay it with no model, and export it as a Cloud ALM test case or an SAP GUI script."
---

# Recording and replay

How do you turn an agent's run in SAP into a repeatable test? Record it
with `sap_record`, then run it again with no model with `sap_replay` or
`sap-ui-automation replay`.
Every `sap_act` is already a small, exact instruction: a JSON action on an
SAP control id. Recording keeps those instructions, with what the screen
showed after each one, in one file. `replay` runs the file again;
`export` writes it in formats test teams already use.

```
agent run ──record──▶ <name>.saptest.json ──replay──▶ pass / fail per step
                              │
                              └──export──▶ Cloud ALM test case · SAP GUI script (VBS)
                                           Playwright spec · Gherkin feature
```

Status: a working prototype. Record and replay have been run on Web GUI
and on SAP GUI for Windows (scripting, and the [network
reader](network-reader.md#record-and-replay)); not yet on Fiori. Details
under [What was checked](#what-was-checked).

::: warning Recordings hold typed values
A recording holds every value that was typed, as it was typed, and the
status bar and titles of the screens. Passwords cannot be typed through this
server at all, but business data can. Treat recordings like the system's
data: keep them where that data may be kept, and review them before you
commit or share them.
:::

## Record a run

Ask the agent to record, or call the tool yourself. Use a dedicated test session for recording and replay. Verify the system, client
and session id first. Replace `<test-session-id>` with that exact id in the calls below. The transaction command discards any unsaved input.

```
sap_record {"op":"start","session":"<test-session-id>","name":"VA03 display order"}
sap_act    {"session":"<test-session-id>","do":"okcode","value":"/nVA03"}
sap_act    {"session":"<test-session-id>","do":"set","id":"ctxtVBAK-VBELN","value":"19097"}
sap_act    {"session":"<test-session-id>","do":"key","key":0}
sap_record {"op":"stop"}
```

- From `start` on, every `sap_act` that works on that session is a step. An
  action that failed, was refused, or was held and not confirmed is not
  recorded.
- `{"op":"undo"}` drops the last step from the recording. SAP is not
  undone.
- `{"op":"status"}` shows the steps so far, and `{"op":"help"}` every op
  with an example.
- While recording, each `sap_act` answer has a `code:` line: the
  [SDK](sdk-tests.md) call that repeats the action. Each action of a batch
  (`actions`) is its own step.
- `stop` writes `va03-display-order.saptest.json` in the recordings
  directory and gives hints: typed values that are still fixed, a document
  number reused without a capture, a test with no check.
- Recordings go to `SAP_RECORD_DIR` (default `./sap-tests` in the server's
  working directory). The tools take a name, never a path.
- `SAP_RECORD=on` records every session from its first action, without
  `start`: a trace of whatever the agent did, to sort out afterwards.

## Add checks, variables and captures

A test needs checks: what must be true after a step. Mark them on the
screen they are about, right after the step:

```
sap_record {"op":"assert","session":"<test-session-id>","check":"field","id":"txtVBAK-NETWR","equals":"2.500,00"}
sap_record {"op":"assert","session":"<test-session-id>","check":"status","contains":"has been saved"}
sap_record {"op":"assert","session":"<test-session-id>","check":"title","contains":"Overview"}
```

`check` is `status`, `field`, `title`, `transaction` or `text` (anywhere on
the screen); the value is `equals`, `contains` or `matches` (a regular
expression). A field check without one of them takes the field's value now.
A check is tried at once and refused if it does not hold, so a recording
cannot contain a check that was false when it was made.

Values that change between runs become variables:

```
sap_record {"op":"variable","name":"order","value":"19097"}
```

The value is replaced by `${order}` wherever it stands alone: in what was
typed, in what is expected, in the recorded status bar and titles.

A value SAP makes at a step (a new document number) is a capture: read from
the screen at every replay and used by the steps after it.

```
sap_record {"op":"capture","session":"<test-session-id>","name":"order","from":"status","pattern":"Order (\\d+)"}
```

`{"op":"note","text":"Open the order"}` says what the last step is for; the
exports use it.

## Replay

From the command line:

```sh
sap-ui-automation replay sap-tests/va03-display-order.saptest.json --var order=4711
```

From the agent:

```
sap_replay {"session":"<test-session-id>","name":"VA03 display order","variables":{"order":"4711"}}
```

- Replay runs on a session you have open. It never logs on.
- It uses no model: the same actions on the same ids, through the same
  driver and **the same guard** as `sap_act`. `SAP_WRITE`, the system list
  and the transaction lists apply to every step.
- A step that may write needs `SAP_WRITE=on`. With `off` or `confirm` it
  fails with that reason: a replay cannot stop to ask at each step.
- Each step checks that SAP showed no error, that the screen is the recorded
  one, and that every check and capture holds. The first failing step stops
  the run, and the result shows the screen there.
- A popup that only informs, which the recording does not have, is
  confirmed and noted (`PASS ... WITH NOTES`). A question, or a screen that
  offers a choice (availability control), fails the step.

Options:

| Command line | `sap_replay` | Effect |
| --- | --- | --- |
| `--var name=value` | `"variables"` | another value for a variable |
| `--loose` | `"screens":"loose"` | another screen number than recorded is a note, not a failure |
| `--continue` | `"choices":"continue"` | press the neutral Continue on a choice the recording does not have |
| `--stay` | (always) | stay on the failing screen; the command line otherwise leaves with `/n` |
| `--json` | `"format":"json"` | the result as data |
| `--junit <file>` | | JUnit XML, one case per step |
| `--session <ref>` | `"session"` | the session to run on |
| several files | | run in order on one session, handing variables on |
| | `"from"`, `"repair"` | resume at a failed step with a repair ([below](#repairing-one-step-and-going-on)) |

Every flag: [CLI commands](../reference/cli.md#replay). Every parameter:
[MCP tools](../reference/tools.md#sap-replay).

## Export

```sh
sap-ui-automation export sap-tests/va03-display-order.saptest.json --to calm
```

or `sap_record {"op":"export","name":"VA03 display order","to":"calm"}`.

| Target | File | For |
| --- | --- | --- |
| `calm` | `.calm.json` | SAP Cloud ALM manual test case |
| `vbs` | `.vbs` | SAP GUI scripting, for SAP GUI for Windows |
| `playwright` | `.spec.ts` | Playwright test for Web GUI |
| `playwright-sap` | `.psap.spec.ts` | the same with playwright-sap's `locateSID` |
| `gherkin` | `.feature` | a step list in Given / When / Then |
| `sap-ts` | `.sap.ts` | a test for `sap-ui-automation test` ([Writing tests with the SDK](sdk-tests.md)) |

The Playwright spec logs on by itself from `SAP_WEBGUI_URL` (or
`SAP_FIORI_URL`), `SAP_USER` and `SAP_PASSWORD`, and reads variables from
`SAP_VAR_<NAME>`. It is a file you run; the server never logs on. Details
of each target under [Export targets](#export-targets).

### Tidy code from a recording

The `sap-ts` export is the recording step for step, with the agent's
detours, typos and error round trips. The tidied code is the test a person
would have written:

```
sap_record {"op":"code","tidy":true,"name":"VA01 create order"}
```

It takes the recording that is on, or else the one `name` names (default:
the one last stopped). Each rule logs a line with its reason:

| Rule | What it does |
| --- | --- |
| abandoned | drops a `/n<tcode>` visit where nothing was saved, checked, captured or noted, when the next `/n` left it |
| error | drops a key or button that only raised E (or A) and stayed on the screen, when steps follow |
| repeat | keeps the last set, check or dropdown of a control, or tab of a tab strip, before any round trip |
| capture | captures a 5+ digit number of a status bar that later steps type or expect |
| variable | makes each typed value a variable |
| status | checks the success message (S) a save led to |
| title | checks the title a step landed on, when it changed the screen to one not reached before |
| handle | uses the shortest unique id recorded for each control; numbered controls such as `btn[0]` keep their full id |

The code has one `sap.step(...)` block per screen, key names
(`sap.key("Enter")`), `sap.save()` for key 11, and conditions for what SAP
shows for some data only: `sap.dismissInfo()` for an information popup,
`if (await sap.at("SAPLATP4/0500")) await sap.button("Continue").press()`
for the availability screen, `sap.save({ acceptWarnings: true })` for a save
that answered with a warning, and
`const order = await expect(sap.status()).capture(/Order (\d+)/)`. The
helpers are in [Writing tests with the SDK](sdk-tests.md#steps-and-screens-sap-shows-for-some-data-only).

The answer ends with the removal log and a TODO list (what tidy could not
decide). The code is not run: run it before you rely on it. A removal that
was needed shows up as a failure at the step after it. By default every
typed value becomes a variable, and `acceptWarnings` accepts any warning:
read the code before you keep it.

### Code tools: `sap_code_save` and `sap_code_test`

An agent with a file system writes the tidied code to a file and runs it
with `sap-ui-automation test`. For an agent without one, `SAP_CODE_TOOLS=on` adds two
tools:

| Tool | Input | Does |
| --- | --- | --- |
| `sap_code_save` | `{"name","code"}` | checks the code, then writes `<name>.sap.ts` in `SAP_RECORD_DIR` |
| `sap_code_test` | `{"name","variables"?,"session"?}` | checks it again, runs it through the test runner on the session, answers pass or fail |

::: danger The agent writes code that runs on your machine
These tools let an agent write code that the server then runs on the
user's machine, with the user's rights. The agent reads SAP screens, and
text on a screen (a long text, a material description, a workflow note)
can carry instructions meant for it. Such text can reach the code the agent
writes. The checks below make the obvious ways out of a test fail, but they
are defence in depth, not a sandbox: the code runs in the server's own
process. Turn the tools on only where you would let the agent's author run
scripts on that machine.
:::

What `sap_code_save` checks:

- **Name, not path.** A `/`, `\`, `..`, a leading `.` or a drive letter is
  refused; the file name is the slug of the name.
- **Syntax.** The code must parse once its TypeScript types are stripped.
  It is not type-checked against the SDK.
- **Imports.** Static, named imports only: `expect`, `test` and
  `ExpectError` from `"sap-ui-automation/test"`, or `expect`,
  `ExpectError` and `Refused` from `"sap-ui-automation"`, plus `type`
  imports. No `connect`, no `import()`, no re-exports.
- **Words.** Outside strings and comments, no `process`, `require`, `eval`,
  `Function`, `globalThis`, `fetch`, `Bun`, `Deno`, `child_process`,
  `constructor`, `Reflect`, `Object` and the like, and none of a session's
  insides (`registry`, `policy`, `driver`, `recorder`, `options`,
  `surfaces`).
- **Computed member access.** Only a number in brackets (`rows[0]`).
- **Commit parity.** A call that may write (`sap.save()`, key 11, a Save
  button, `btn[11]`, `okcode("/11")`) is refused unless the recording of
  the same name has a write. This is read from the text; the guard at run
  time is what holds.

`sap_code_test` runs the same checks on the file as it is, then runs a copy
of it under the server's session, `SAP_WRITE`, `SAP_ALLOW_TCODES` and
`SAP_BLOCK_TCODES`: a test cannot widen them. Every action goes through the
guard as in any script. The answer is `PASS` or `FAILED` per test; on a
failure, the line, the `sap.step` it was in, the trace file and the screen.
It is refused while a recording is on.

## In CI

`replay` exits with 0 when every test passed and 1 otherwise, and writes
JUnit XML with `--junit`, which CI servers read:

```sh
sap-ui-automation replay sap-tests/*.saptest.json --junit report.xml
```

It needs a machine where an SAP session is open and logged on: a Chrome
with a Web GUI tab the server can reach (the SAP window it starts, or a
Chrome reached with `SAP_BROWSER=attach` or `SAP_CHROME_CDP`), or a
Windows desktop with SAP GUI. It does not create the data a test needs
or restore the system afterwards: run it on a test system. For a runner
that logs on by itself, export to Playwright.

## With the network reader

Recordings made on a session the network reader reads name controls the way that
method's actions do, and record the method, so they are replayed with the
same method and are not exported to VBS. Information popups are passed with
their Enter key. A recorded Enter on a popup that only informed is not sent
when SAP does not show that popup this time (its checks still run); the
recorded answer to a question (Yes, Save, any button of a popup that asks)
is never skipped: if SAP does not show the question, or shows another popup
in its place, the step fails. A screen damaged in transit is never judged:
the replay waits for a whole one, or fails the step with "screen damaged in
transit". Record and replay through the network reader were run against
SAP GUI for Windows 8.00 on ECC 6.0, read-only
([Network reader](network-reader.md#limits)).

## File format and design

The rest of this page is the design: what is recorded and why, the file
format, how replay finds controls and repairs a step, each export target,
what was tested, and open questions.

### Record

#### Where the recording lives

A tool, `sap_record`, with an environment variable for the directory and for
"record everything".

| | |
| --- | --- |
| `sap_record {"op":"start","name":"..."}` | starts a recording on the active session; off until then |
| `SAP_RECORD_DIR=./sap-tests` | where recordings and exports are written (default: `sap-tests` in the server's working directory) |
| `SAP_RECORD=on` | records every session from its first action, named `session <time>`, without `start` |

Why a tool and not only an environment variable:

- A test needs **checks**. Only the agent or the user knows that "the status
  bar says the order was saved" is the point of the run. Marking it needs a
  tool call at that moment, on that screen.
- A session holds exploration that is not part of the test. `start`, `stop`
  and `undo` let the agent keep the part that is.
- The variable alone would record everything, always, including typed
  values, without the user choosing it per run.

`SAP_RECORD=on` stays for the other case: keep a trace of whatever the agent
did, and decide afterwards.

The tools take a **name**, never a path. Recordings and exports are read and
written in the one directory, and the name is reduced to letters, digits and
dashes, so an agent cannot make the server read or write elsewhere. The
command line takes paths, because the user types them.

#### What is recorded

The server calls the recorder around every action it runs
([`src/server.ts`](https://github.com/DidroAI/sap-ui-mcp/blob/main/src/server.ts), one line in `perform`). While a recording is on, for the
recorded session:

1. read the full view of the screen (before);
2. run the action through the driver, as always;
3. read the full view again (after);
4. add a step: the action as it ran, the control it was done on (full SAP id,
   type, label), the guard's risk class (`read`, `navigate`, `commit`), the
   screen before (transaction, program, screen number, window title) and the
   screen and status bar after.

Rules:

- **Only actions that worked are steps.** An action that failed, was refused
  by the guard, or was held for confirmation and not confirmed is not
  recorded. A confirmed action is.
- **Recording never breaks the action.** If a screen cannot be read, the step
  has a gap; the action's answer is unchanged.
- **The file is written after every change**, so a crash loses nothing.
- **One session per recording.** Actions on other sessions run and are
  counted, not recorded.
- **Values are recorded as typed.** Passwords cannot be typed through this
  server at all, but a recording holds business data: treat the file like the
  system's data.

Cost while recording: two extra reads of the screen per action. On Web GUI
(an ECC demo system) a full read took 30 to 50 ms; an `okcode` took about 1.2 s with or
without recording.

#### Marking checks, variables and captures

| Operation | Does |
| --- | --- |
| `{"op":"assert","check":"status","contains":"has been saved"}` | the status bar after the last step |
| `{"op":"assert","check":"field","id":"txtVBAK-NETWR","equals":"2.500,00"}` | a control's value. Without `equals`, `contains` or `matches`: its value now |
| `{"op":"assert","check":"title","contains":"Overview"}` | also `transaction`, and `text` (anywhere on the screen) |
| `{"op":"variable","name":"order","value":"19097"}` | a value that changes between runs |
| `{"op":"capture","name":"order","from":"status","pattern":"Order (\\d+)"}` | a value SAP produced at the last step; also from a `field` or the `title` |
| `{"op":"note","text":"..."}` | what the last step is for (used by the exports) |
| `{"op":"undo"}` | drops the last step from the recording; SAP is not undone |
| `{"op":"status"}`, `{"op":"stop"}`, `{"op":"list"}`, `{"op":"export","to":"..."}` | |

- **A check is tried on the screen as it is now and refused if it does not
  hold**, with what is there instead. A recording cannot contain a check that
  was false when it was made.
- A check or capture belongs to the last step: it describes the screen that
  step led to. A field check stores the control's full SAP id and its label.
- **A variable** is written `${name}` wherever its value stands alone: in what
  was typed, in what is expected, in the recorded status bar and titles, in
  steps already recorded and in later ones. "Alone" means not inside a longer
  word or number: `19097` is replaced in `Order 19097 saved`, not in `219097`.
- **A capture** is a variable whose value is read from the screen at every
  replay. From the step that captures it on, its recorded value is the
  variable; the step that produced it still types what it typed.
- `stop` answers with hints: typed values that are still fixed, a document
  number in a status bar that later steps reuse without a capture, no check
  at all.

### File format

One JSON file per run, `<name>.saptest.json`, format id `sap-gui-test/1`.

JSON, not YAML: the server has no YAML dependency, the actions inside are
already JSON (the same objects `sap_act` takes, so a step can be pasted into
a tool call), and SAP ids contain `\`, `[`, `:` and `#`, which YAML quotes in
ways people get wrong. The file is validated with a schema on every load, and
every action in it must be one the server accepts today.

```json
{
  "format": "sap-gui-test/1",
  "name": "Create and display",
  "recorded": { "at": "2026-01-02T03:04:05.000Z", "by": "sap-ui-automation 0.1.0", "surface": "webgui", "system": "ABA", "client": "800" },
  "start": { "transaction": "SMEN", "program": "SAPLSMTR_NAVIGATION", "screen": "100", "title": "SAP Easy Access" },
  "variables": {
    "customer": { "value": "2200", "description": "a customer of sales area 1000" },
    "order": { "value": "5001", "description": "read from the status bar after step 5" }
  },
  "steps": [
    { "action": { "do": "okcode", "value": "/nZA01" }, "risk": "navigate",
      "after": { "transaction": "ZA01", "program": "SAPMZA01", "screen": "100", "title": "Create Order: Initial Screen" } },
    { "action": { "do": "set", "id": "ctxtZORD-KUNNR", "value": "${customer}" },
      "target": { "id": "wnd[0]/usr/ctxtZORD-KUNNR", "type": "field", "label": "Customer" },
      "risk": "navigate",
      "on": { "transaction": "ZA01", "program": "SAPMZA01", "screen": "100", "title": "Create Order: Initial Screen" },
      "after": { "transaction": "ZA01", "program": "SAPMZA01", "screen": "100", "title": "Create Order: Initial Screen" } },
    { "action": { "do": "key", "key": 11 }, "risk": "commit",
      "after": { "transaction": "ZA01", "program": "SAPMZA01", "screen": "100",
                 "status": { "type": "S", "text": "Order ${order} has been saved" } },
      "expect": [ { "check": "status", "op": "contains", "value": "has been saved" } ],
      "capture": [ { "var": "order", "from": "status", "pattern": "Order (\\d+)" } ] },
    { "action": { "do": "set", "id": "ctxtZORD-VBELN", "value": "${order}" },
      "target": { "id": "wnd[0]/usr/ctxtZORD-VBELN", "type": "field", "label": "Order" } }
  ]
}
```

(The example is the synthetic system of the unit tests, shortened.)

| Field | Meaning |
| --- | --- |
| `recorded` | when, by which server version, on which surface, system and client. No user name |
| `start` | the screen the recording started on |
| `variables` | name → the value it had in the recording (the default at replay), and a description |
| `steps[].action` | the action as `sap_act` takes it; absent for a step that only checks |
| `steps[].target` | the control: full SAP id, type and label when recorded |
| `steps[].risk` | `read`, `navigate` or `commit`, as the surface classified it then |
| `steps[].on`, `steps[].after` | transaction, program, screen number, window title; `after.status` is the status bar (type S, I, W, E or A, and text) |
| `steps[].expect[]` | `check` (status, field, title, transaction, text), `op` (equals, contains, matches), `value`; for a field, its `id`, `label`, `type` |
| `steps[].capture[]` | `var`, `from` (status, field, title), `id` for a field, `pattern` (first group is the value) |
| `steps[].note` | what the step is for |

The file is meant to be edited by hand: delete a step, change a default, add
a check.

### Replay

```sh
sap-ui-automation replay sap-tests/va03-display-order.saptest.json --var order=4711 --junit report.xml
```

or, from an agent, `sap_replay {"session":"<test-session-id>","name":"VA03 display order","variables":{"order":"4711"}}`.

Replay uses no model. It runs on a session the user has open (it never logs
on), through the same driver as `sap_act` and **the same guard**: the write
setting, the system list and the transaction lists apply to every step.

For each step:

1. fill in the variables. A variable without a value stops the run before
   the first step; it is never an empty string;
2. find the control (below);
3. ask the guard, then run the action;
4. read the screen and check it:
   - the status bar shows no error (`E`) or abort (`A`) message, unless the
     recording did at that step;
   - the screen is the recorded one: same transaction, program and screen
     number. `--loose` (`"screens":"loose"`) makes this a note, for a system
     where screen numbers differ;
   - every capture finds its value; then every check holds. Captures first,
     so a check may use a value captured at the same step.

A window SAP shows after a step that the recording does not have there is
handled by what it asks:

- a popup that only informs (text and Continue, no question, no input): the
  replay confirms it and notes it on the step;
- a screen that offers a choice (availability control: complete delivery,
  delivery proposal, continue without confirming): the step fails and names
  the ways on, and nothing is pressed, because the choice decides what is
  saved. `--continue` (`"choices":"continue"`) makes the replay press the
  neutral Continue instead, and say so;
- a question or a window that takes input: the step fails.

When the replay did anything the recording does not have, the first line of
the result says `PASS ... WITH NOTES` and names the steps.

#### Repairing one step and going on

A replay that fails says where the step failed (`failed (act)`, `(landing)`,
`(check)`, `(refused)`) and leaves the session on that screen. Whoever ran
it can hand back a repair for that one step and let the replay go on:

```json
{"name": "VA03 display order", "from": 3, "variables": {"order": "19126"},
 "repair": {"why": "SAP asks for the company code first",
            "actions": [{"do": "set", "id": "ctxtBKPF-BUKRS", "value": "1000"}, {"do": "key", "key": 0}],
            "place": "after"}}
```

`from` resumes at that step on the screen as it is, with the variables the
failed run ended with. `place` says how the actions relate to the recorded
action: `before` (do them, then the recorded action runs), `instead` (they
replace it: its control has another id now), `after` (it already ran; they
complete it: a popup it raised). The other kind of repair is a capture, for
a number SAP makes anew when it saves:
`{"why": "...", "capture": {"var": "order", "from": "status", "pattern": "Order (\\d+) has been saved"}}`.

With `after`, `"earlier": [...]` names the actions an earlier try at the
same step already ran without getting it through: they are not run again,
and the proposed recording holds them before the new ones.

The server calls no model. It carries out the repair under rules the caller
cannot change ([`src/record/repair.ts`](https://github.com/DidroAI/sap-ui-mcp/blob/main/src/record/repair.ts)):

- every action passes the guard, as in `sap_act`;
- no write the recording does not have: an action that may write is refused
  unless the recorded step is itself a write, the repair replaces or completes
  it (not `before`), and it is the only one;
- a confirmation is the write it completes: while SAP holds a warning in the
  status bar or a popup that it raised at a write (the step being repaired, or
  the step before it), Enter or a confirming button counts as that write. SAP
  saves on the Enter that acknowledges a warning raised by Save. So it is
  refused on a step that is not that write, refused `before` the recorded
  write, and with writing off the guard refuses it as a write;
- no leaving the transaction, no other app;
- no invented data: a typed value is in the recording or on the screen;
- a screen that offers a choice (availability control) is not answered;
- at most 4 actions;
- the step is still judged by the recording: the screen it led to and every
  marked check. A capture is allowed on a step that writes only, its value is
  one token of letters and digits, and with the recorded number replaced by
  the variable every check of the step must hold.

A repair that worked is in the result (`repaired:` under the step, `PASS ...
REPAIRED at step N` in the first line) with a proposed change to the test.
With `"format":"json"` the result is data: per step the outcome, the phase of
a failure and the repair; the full screen; and `proposal` (the changes in
words, the recording with them written in, and for each of its steps the
step of the replayed recording it comes from). Nothing is saved: the person
decides whether the proposed recording replaces the old one.

The first failing step stops the run; later steps are reported as skipped.
On the wrong screen or after an SAP error, the marked checks are not run:
they would only repeat the failure. The result holds, per step, pass, fail or
skipped, the time, what held, what failed and why, and **the screen at the
failure** in the compact view an agent or a person can read.

#### Robust to small screen changes

Steps address controls by SAP scripting id, which SAP keeps stable. The id is
a path, and only its last segment names the control:

```
wnd[0]/usr/subSUBSCREEN_HEADER:SAPMV45A:4021/txtVBAK-NETWR
           └ the subscreen it sits in ─────┘ └ the field ─┘
```

A support package, an enhancement or the move to S/4HANA can change the
subscreen or the tab around a field without changing the field. So the
replay looks for the control in this order, and takes a fallback only when
exactly one control matches:

1. the recorded id;
2. the same last segment anywhere on the screen (`txtVBAK-NETWR`);
3. the same field name with another control type (`ctxtVBAK-NETWR`).

A step that used a fallback passes with a note saying which id was found.
Controls that are numbered, not named (`btn[8]`, `menu[1]`, `lbl[1,13]`,
`shell`), are never looked for elsewhere: the same number in another toolbar
is another button. Labels are never used either: two fields can share a
label, and acting on the wrong one is worse than failing.

#### Data

- **Values to change:** variables, with the recorded value as default.
  `--var name=value` or `"variables"`. A name no test has is an error.
- **Documents created by earlier steps:** captures. The replay of "create an
  order, then display it" creates a new order and displays that one, not the
  recorded number.
- **Tests that build on each other:** `replay a.saptest.json b.saptest.json`
  runs them in order on one session and hands every variable of `a`,
  captured ones included, to `b`. It stops at the first test that fails.
- **A clean start:** a recording that begins with `/n<transaction>` is its
  own clean start. Otherwise the replay first sends `/n` plus the transaction
  the recording started in, and stops if that does not open the screen the
  recording started on. `start` tells the agent to begin with an okcode.
- **A clean end:** after a failure the command line leaves the transaction
  with `/n` (unsaved input is dropped; nothing is saved), so the next test
  starts from a known place; `--stay` keeps the failing screen. `sap_replay`
  always stays on the failing screen, because the agent will want to look.
- **Writes:** a step that may write needs `SAP_WRITE=on`. With `off` or
  `confirm` it fails with that reason. A replay cannot stop to ask at each
  step, and a confirmation for the whole run is an open question.

What replay does not do: create the data a test needs (a customer, stock, an
open period), or restore the system afterwards. A test that needs a document
should create it in an earlier step or an earlier test.

#### Output

Each step says how long it took, and how long it took when recorded (the
recording keeps `ms` per step). An action that took over twice as long as
recorded, and over a second more, gets a `slower:` line (in JUnit, the
case's `<system-out>`); it never fails the step.

Text (above), `--json` (the result objects), `--junit <file>` (JUnit XML, one
suite per test and one case per step, which CI servers read). Exit code 0
when every test passed, 1 otherwise.

### Export targets

`sap-ui-automation export <file> --to <target>` or
`sap_record {"op":"export","name":"...","to":"<target>"}`. Each exporter is a
pure function from the recording to a text file.

| Target | File | For |
| --- | --- | --- |
| `calm` | `.calm.json` | SAP Cloud ALM manual test case |
| `vbs` | `.vbs` | SAP GUI scripting, for SAP GUI for Windows |
| `playwright` | `.spec.ts` | Playwright test for Web GUI |
| `playwright-sap` | `.psap.spec.ts` | the same with playwright-sap's `locateSID` |
| `sap-ts` | `.sap.ts` | a test for this package's runner, written with its scripting API |
| `gherkin` | `.feature` | a step list in Given / When / Then |

#### SAP Cloud ALM

**Manual test cases.** Cloud ALM's test management API creates a manual test
case with `POST calm-testmanagement/v1/ManualTestCases`: a title, activities
(`toActivities`) and, in each, actions (`toActions`) with a title, a
description, an expected result and an evidence flag.

The export is a JSON file shaped as the input of an MCP tool named
`calm_create_test_case`, as `{"tool":"calm_create_test_case","arguments":{...}}`,
with `title`, `activities[].title` and `activities[].steps[]` (`title`,
`description`, `expected`, `evidence`). A Cloud ALM MCP server that offers
such a tool (none ships with this project) can take `arguments` as they are;
otherwise map them to the API fields above. Nothing in this server calls
Cloud ALM.

- One activity per screen the test works on, titled `VA03: Display Sales
  Order: Initial Screen`. Opening a transaction belongs to the screen it
  opens.
- One step per action, in a tester's words: `Enter "<order>" in the field
  "Order" (VBAK-VBELN)`. The label is what the tester sees; the field name is
  what a consultant looks for; the full id is in the description.
- Expected result: the screen that appears, the status bar, the marked
  checks.
- Evidence is asked on steps with a check and on steps that write.
- A first activity, "Preparation", holds the system, the surface and the
  test data (`<order> = 19097`).
- Sizes are kept within 250 and 500 characters for titles, 4000 for
  texts, 50 steps per activity and 30 activities.

**Automated test cases.** Cloud ALM does not store automated tests; it shows
those of a connected test automation tool and starts them there. As far as
public documentation says: an endpoint with the use case "Test Automation"
points to the tool's REST API with OAuth client credentials; Cloud ALM pulls
the tool's test cases into its Test Case Overview, triggers runs and reads
results back. SAP's own providers are the test automation tool for S/4HANA
Cloud and Tricentis Test Automation; UiPath documents the same connection
for its Test Manager. So "export to an automated Cloud ALM test case" is not
a file: it is a service that implements the provider side and runs
`replay`, and it is not part of this server. The exact endpoint
contract was not read (it is on SAP Business Accelerator Hub); sources:
[SAP KBA 3628967](https://userapps.support.sap.com/sap/support/knowledge/en/3628967),
[SAP expert portal, Test Management](https://support.sap.com/en/alm/sap-cloud-alm/implementation/sap-cloud-alm-implementation-expert-portal/testmanagement.html),
[SAP blog on the test automation tool](https://blogs.sap.com/2021/08/16/integrating-sap-cloud-alm-and-the-test-automation-tool-for-sap-s-4-hana-cloud/),
[UiPath Test Manager and SAP Cloud ALM](https://docs.uipath.com/test-manager/automation-cloud/latest/user-guide/sap-cloud-alm).

#### SAP GUI scripting (VBS)

A VBScript in the style of SAP GUI's own recorder (Customize Local Layout →
Script Recording and Playback): the recorder's header that attaches to the
running session, then `session.findById("<id>")` calls.

| Action | Script |
| --- | --- |
| `okcode` | `findById("wnd[0]/tbar[0]/okcd").text = "/nVA03"`, then `findById("wnd[0]").sendVKey 0` |
| `set`, `press`, `select`, `focus` | `.text = "..."`, `.press`, `.select`, `.setFocus` |
| `key` | `session.ActiveWindow.sendVKey <n>` (key names become their number) |
| `check`, `combo` | `.selected = True`, `.key = "..."` |
| `f4`, `dblclick` | `.setFocus`, then `sendVKey 4` or `2` |
| `tree`, `grid`, `toolbar` | `doubleClickNode`, `setCurrentCell` + `doubleClickCurrentCell`, `pressToolbarButton` |

These are the calls the server's own SAP GUI driver makes. Beyond the
recorder's style, the script keeps what makes it a test: variables as named
arguments (`cscript //nologo test.vbs /order:4711`), `Landed` after each step
(no `E` or `A` message, the recorded program and screen number), `Expect` for
each check, `Capture` for each capture, exit code 1 at the first failure.

A Web GUI recording exports to VBS as well, because Web GUI carries the same
scripting ids. A Fiori recording does not.

#### Playwright

A stand-alone `@playwright/test` spec for Web GUI. It logs on from
`SAP_WEBGUI_URL`, `SAP_USER` and `SAP_PASSWORD`, reads variables from
`SAP_VAR_<NAME>`, and carries its own helpers:

- `sid(page, id)`: a control by its SAP id. Web GUI writes the id into each
  control's `lsdata` attribute, as a JavaScript literal on NetWeaver 7.5
  (`SID:'wnd[0]/...'`) and as JSON on S/4HANA 2025 (`"SID":"wnd[0]/..."`);
  the helper matches both, and takes the field inside a table cell, not the
  cell;
- `settle(page)`: Web GUI answers each action with one POST and shows a
  loading bar meanwhile; the helper waits for both;
- `okcode`, `type` (key events, as Web GUI needs), `noError` (the status bar
  after each step).

Covered: command field, typing, keys, buttons, tabs, radio buttons,
checkboxes, double-click and value help on a control with an id. Tree nodes,
ALV grid cells, toolbars inside controls and dropdown entries have no id of
their own in the page (the server's driver reaches them by node key, row and column);
those steps are written as `test.fixme` with the reason, never as a guessed
click. For such tests, `replay` is the runner.

**playwright-sap** ([playwright-sap.dev](https://playwright-sap.dev/)) is an
open-source Playwright fork with SAP locators. `locateSID` takes exactly the
id we record, so the `playwright-sap` target writes the same spec with
`page.locateSID(id)` in place of the spec's own helper. Two limits, seen with version
1.1.6: as shipped its id match expects JSON in
`lsdata` and finds nothing on NetWeaver 7.5; and it has no locator for tree
nodes, grid cells or popup list rows either. The plain target is the default
because it works on both `lsdata` forms and needs no fork.

A Fiori recording is written with UI5 id suffixes (`[id$="..."]`). That
output is a starting point and has not been run.

#### sap-ts: the scripting API

`sap-ts` writes the recording as a `*.sap.ts` test that imports
`sap-ui-automation/test` and drives the session through the scripting API:
each step is the SDK line `sap_act` answers with (`await sap.set("VBAK-VBELN",
vars.order);`), the variables are a `const vars = {...}` block with the
recorded values, a capture is a `const` read with its pattern
(`const order = /Order (\d+)/.exec(await sap.status().text())?.[1] ?? "";`)
and used as `order` in the steps after it, and each check is a waiting
`expect` (`toContainText`, `toHaveValue`, `toHaveTitle`, `toHaveTransaction`;
`matches` becomes a regular expression). Notes are comments.

A step that confirmed a popup that only informs is written as
`if (await sap.control("wnd[1]/tbar[0]/btn[0]").exists()) await sap.press(...)`:
a replay skips that step when SAP does not show the popup again, and so does
the test. The checks a replay makes on its own after every step (no error in
the status bar, the recorded screen) are not written; the test checks what
the recording marked.

`sap_record {"op":"code"}` gives the same file for the recording that is on,
or, with none on, a draft of every action the server ran on the session.

##### Tidy: the test a person would have written

The export above is the recording step for step: an agent's detours, typos
and error round trips included. `sap_record {"op":"code","tidy":true}` (with
`"name"`, or the recording that is on) and `exportSapTs(test, { tidy: true })`
first tidy it (`src/record/tidy.ts`). Each rule logs one line with its reason:

| Rule | What it does |
|---|---|
| abandoned | drops a `/n<tcode>` visit where nothing was saved, checked, captured or noted, when the next `/n` left it |
| error | drops a key or button that only raised E (or A) and stayed on the screen, when steps follow |
| repeat | keeps the last set, check or dropdown of a control, or tab of a tab strip, before any round trip (a tab is kept when something was done on it) |
| capture | captures a 5+ digit number of a status bar that later steps type or expect |
| variable | makes each typed value a variable |
| status | checks the success message (S) a save led to |
| title | checks the title a step landed on, when it changed the screen to one not reached before (not after `/n`, not into a popup or a data-dependent screen) |
| handle | uses the shortest unique id recorded for each control (`target.handle`); numbered controls such as `btn[0]` keep their full id, because a popup's buttons share those numbers |

The code then has one `sap.step(...)` block per screen, key names
(`sap.key("Enter")`), `sap.save()` for key 11, and conditions for what SAP
shows for some data only: `sap.dismissInfo()` for an information popup,
`if (await sap.at("SAPLATP4/0500")) await sap.button("Continue").press()` for
the availability screen, `sap.save({ acceptWarnings: true })` for a save that
answered with a warning, and `const order = await expect(sap.status()).capture(/Order (\d+)/)`.
A numbered button is pressed by its label. The answer ends with the removal
log and a TODO list (what tidy could not decide).

On the fake SAP of the tests, an agent-like run of 23 steps (two wrong
transactions, a forgotten field, a typo, a checkbox toggled, tabs clicked to
and fro) becomes 13 steps; its code passes through the runner on a system
with the availability screen, the save warning and the popup, and on one
without them. The step-for-step export fails on the second.

`verifyTidy(sapOrDriver, recording)` checks the removals on a system: it
replays the tidied recording and, when a step fails, puts back the last
removal before it and runs again (at most 4 runs). Each run is a whole
replay, writes included when the test writes and the policy allows: use a
test system. It verifies the tidied *recording*, not the code: a replay has
no "if", so the conditions above are checked only by running the code.

Once code passes, the runner writes `<name>.sap.lock.json` next to it:
what each screen looked like, per `sap.step`. Later runs compare each
action's landing with it and fail with `Drift` where SAP answers otherwise,
so the code keeps the model-free drift detection of a replay; screens the
code asks about (`sap.at`, `sap.popup`, `dismissInfo`) are branches, not
drift. See [Lock files](sdk-tests.md#lock-files).

To save and run such code from an agent without a file system, see
[Code tools](#code-tools-sap-code-save-and-sap-code-test).

While a recording is on, every `sap_act` answer of an
action that ran ends its note with the same line, e.g.
`code: await sap.set("VBAK-VBELN", "4711");` (about ten tokens).
`SAP_CODE=on` adds it without a recording too; `SAP_CODE=off` leaves it out
even while recording.

#### Gherkin, and Tosca-like tools

`gherkin` writes a `Scenario Outline` with the variables as `Examples`. It
is the step list for people and for Cucumber-style tools; its steps are
sentences, not bound to code.

Tricentis Tosca, Worksoft Certify and similar tools keep tests in their own
repositories and scan SAP screens with their own engines; they have no open
file format a recorder can write. What they do take is a step list with
control ids and data, which the recording already is. A converter for one of
them is work to do with a client who owns the tool.

### What was checked

Run on an SAP ERP 6.0 demo system through Web GUI in Chrome, read-only
(nothing was saved in SAP):

- **Record:** through the MCP tools, a five-step VA03 run: `/nVA03`, type
  order 19097, Enter, open the tab "Item overview", Back. Checks on the net
  value, the sold-to party, the window title and a table cell; the order as
  a variable; a deliberately false check, which was refused with the actual
  value.
- **Replay:** `sap_replay` and `sap-ui-automation replay` both pass, 5 of 5
  steps in 4.6 to 4.8 s. With `order=19096` it passes (another order, same
  values). With `order=99999999` it fails at step 3 with SAP's message ("SD
  document 99999999 is not in the database or has been archived"), skips the
  rest, shows the screen, exits 1 and leaves the transaction.
- **Export:** all five targets written from that recording.
- **The Playwright spec was run** with `@playwright/test` 1.65 against the
  same ECC: it passes in 9 s, and fails with SAP's message for
  `SAP_VAR_ORDER=99999999`. It ran in the browser that was already logged
  on, with the spec's log-off hook removed. Its own logon from a new browser
  was not verified: during the check the system sent every new logon of the
  test user back to the logon page without an error, for this repository's
  own [`test/dev/webgui-logon.ts`](https://github.com/DidroAI/sap-ui-mcp/blob/main/test/dev/webgui-logon.ts) too.

Unit tests ([`test/record.test.ts`](https://github.com/DidroAI/sap-ui-mcp/blob/main/test/record.test.ts), 43 tests when this was checked; 54 in November 2026) run record, replay and the
exports against a small SAP in memory ([`test/record-fakes.ts`](https://github.com/DidroAI/sap-ui-mcp/blob/main/test/record-fakes.ts)), including
what the live check could not: a document created by one step and used by
the next, a field moved to another subscreen, a write refused by the guard,
and two tests in a row.

Not run:

- **The VBS export** was not executed. Record and replay on SAP GUI for
  Windows were run on SAP GUI 8.00 against ECC 6.0, by scripting
  ([SAP GUI for Windows](sap-gui-windows.md#limits)) and by the network
  reader ([Network reader](network-reader.md#limits)), but are not
  described step by step here.
- **Fiori.** Actions are recorded and replayed through the Fiori driver;
  from the Fiori view only the app, the toasts (as the status) and the whole
  text are read, so field checks do not work there yet. Nothing was run.
- **A replay that writes** on a real system (`SAP_WRITE=on`).
- **S/4HANA**, and so the claim that field-name fallbacks carry an ECC
  recording over.
- Creating the exported test case in a Cloud ALM tenant.

### Open questions

1. **Screens that differ by data.** A popup that appears only for some
   customers ("credit limit exceeded") makes the replay land on another
   screen. Today that is a failure (or a note with `--loose`). Optional
   steps ("if this popup, press Enter") would handle it, at the price of a
   format that starts to be a language. Wait for real cases.
2. **Confirming a replay that writes.** `SAP_WRITE=on` for the whole server
   is coarse. A single confirmation that lists the test's writing steps, for
   one replay, fits the existing confirm mode; not built.
3. **Trimming.** An agent explores; the recording keeps every action that
   worked. `undo` and editing the file are the tools today. Should `stop`
   propose the steps that changed nothing?
4. **Dates and other computed values.** `${today}` and the like are not
   variables yet; a recorded date is a fixed value.
5. **Checks on tables and lists.** A cell is checked by position (`[1,0]`).
   "The row whose material is M-08" needs a way to name a row.
6. **Fiori.** Field checks need the reader of this file to understand the
   Fiori view, or the Fiori view to move towards the common format.
7. **Format of the view.** Replay reads facts from the text view
   ([`src/record/screen.ts`](https://github.com/DidroAI/sap-ui-mcp/blob/main/src/record/screen.ts)). If the view changes, that file changes. A
   structured screen from the drivers would be firmer, and is a larger
   change to the `Driver` contract.

### Files

| | |
| --- | --- |
| [`src/record/format.ts`](https://github.com/DidroAI/sap-ui-mcp/blob/main/src/record/format.ts) | the file format, its schema, variables |
| [`src/record/screen.ts`](https://github.com/DidroAI/sap-ui-mcp/blob/main/src/record/screen.ts) | reads a screen's facts from its text view; finds a control again |
| [`src/record/checks.ts`](https://github.com/DidroAI/sap-ui-mcp/blob/main/src/record/checks.ts) | evaluates checks and captures |
| [`src/record/recorder.ts`](https://github.com/DidroAI/sap-ui-mcp/blob/main/src/record/recorder.ts) | the recorder |
| [`src/record/replay.ts`](https://github.com/DidroAI/sap-ui-mcp/blob/main/src/record/replay.ts) | the replay, its text and JUnit output |
| [`src/record/repair.ts`](https://github.com/DidroAI/sap-ui-mcp/blob/main/src/record/repair.ts) | a repair of one step: its rules, the capture, the proposed test |
| [`src/record/tools.ts`](https://github.com/DidroAI/sap-ui-mcp/blob/main/src/record/tools.ts) | `sap_record` and `sap_replay` |
| [`src/record/tidy.ts`](https://github.com/DidroAI/sap-ui-mcp/blob/main/src/record/tidy.ts) | tidy (the rules, the log, the TODO list) and `verifyTidy` |
| [`src/record/code-tools.ts`](https://github.com/DidroAI/sap-ui-mcp/blob/main/src/record/code-tools.ts) | `sap_code_save` and `sap_code_test` (off unless `SAP_CODE_TOOLS=on`) |
| [`src/record/cli.ts`](https://github.com/DidroAI/sap-ui-mcp/blob/main/src/record/cli.ts) | `replay` and `export` on the command line |
| [`src/record/export/`](https://github.com/DidroAI/sap-ui-mcp/tree/main/src/record/export) | `calm.ts`, `vbs.ts`, `playwright.ts`, `sap-ts.ts` (with `sap-ts-tidy.ts`), `gherkin.ts`, and `words.ts` (a step in a tester's words) |
| [`src/server.ts`](https://github.com/DidroAI/sap-ui-mcp/blob/main/src/server.ts), [`src/cli.ts`](https://github.com/DidroAI/sap-ui-mcp/blob/main/src/cli.ts), [`src/index.ts`](https://github.com/DidroAI/sap-ui-mcp/blob/main/src/index.ts) | the hook in `perform`, the two commands, the exports of the package |
