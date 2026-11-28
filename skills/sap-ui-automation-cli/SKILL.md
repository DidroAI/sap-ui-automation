---
name: sap-ui-automation-cli
description: Works in SAP from the shell with the sap-ui-automation CLI (look, act, okcode, sessions). Opens transactions, reads and fills screens, reads ALV lists, looks up, creates or changes documents, in SAP GUI for Windows, Web GUI (SAP GUI for HTML) and Fiori, on ECC or S/4HANA. Use this skill whenever the user wants something looked up, checked, created or changed in SAP and there are no sap_* tools in your tool list but you can run shell commands, or when the user asks for the sap-ui-automation CLI. It applies even if the user names no tool or says only a transaction code (VA03, ME23N, MM03, FB03, MIGO) or a business object (sales order, purchase order, material, customer, vendor, invoice, delivery, goods receipt, Fiori app).
---

# Driving SAP screens with the `sap-ui-automation` CLI

`sap-ui-automation` works in the SAP sessions the user has open, as that user and
under their authorisations. It never logs on: with no session open, ask the
user to open SAP. `npx -y sap-ui-automation <command>` is the same program.

`look` prints a few short lines (header, status bar) and the path of a file
with the whole screen. `act`, `okcode` and `open` print their whole answer:
what ran, then the new screen, or only the lines that changed.

```
$ sap-ui-automation act set ctxtVBAK-AUART OR
set ctxtVBAK-AUART

CHANGED 1 of 48 lines on VA01 · "Create Standard Order: Overview" (same screen; sap_look shows all of it):
~ ctxtVBAK-AUART  field  Order Type = "OR"  (edit)
screen: .sap-gui/screens/7-act.txt
```

Read the printed lines. Open the file only when you need the screen: to
find an id, read values or see a list.

## One screen, one command

1. **Identify the target.** List sessions with `sap-ui-automation sessions`, then inspect the intended
   screen using `sap-ui-automation look --session <id> --print`. Check system, client, user, transaction and any
   popup. If the target disappears, list sessions again and verify the new id.
   Keep existing work intact. To start another transaction use a fresh session
   (`/oVA03` for VA03 on SAP GUI or Web GUI). Use `/n` only in a known clean
   session or with permission to discard its contents.
2. **Send the whole screen in one `act`**: the fields, then the key that
   submits them, as one JSON list in single quotes.

   ```sh
   sap-ui-automation act --session '<verified-id>' '[{"do":"set","id":"ctxtVBAK-AUART","value":"OR"},{"do":"set","id":"ctxtVBAK-VKORG","value":"1000"},{"do":"key","key":0}]'
   ```

3. **Read the answer, not the screen again.** It prints what ran, then the
   new screen or `CHANGED n of m lines` (`~` changed, `+` new, `-` gone,
   `=` context). `Ran k of n actions. Stopped: ...` means the list ended
   early: go on from the screen it shows with the actions that did not run.
4. **Read the `STATUS` line.** `E`: nothing went through, correct the field
   it names. `W`: Enter accepts it, when the warning is acceptable for the
   task. `A`: an abort. Success is the status bar line (`sbar  status  S: ...`).
5. **Report** what you read or saved, with the document number from the
   status bar.

A list ends at the first surprise: a failure, a popup, an E/W/A status, a
held write, or another screen (unless the next action's id is on it and it
does not write). `okcode /n<tcode>` and `open` go on into the screen they
open. To go on through a screen you know comes, add
`"expect":{"screen":"4001"}` to the step (`{"screen":"*"}`: any screen). A
write on a screen the list reached after you sent it does not run: read
that screen, then send the write, or add `"unseen":true` when you know it.

A `look` right after an `act`, on the same screen, prints only
`Unchanged since your last sap_act` and the act's file.

## Commands

```
sap-ui-automation sessions                       the open sessions; * marks the active one
sap-ui-automation use <n|id|system|tcode>        make one the active session
sap-ui-automation look [--full] [--diff]         the screen (file); --print prints it
sap-ui-automation look --id <id> [--rows 100-150] [--cols VBELN,NETWR]   one control whole, a range of rows
sap-ui-automation look --id mbar | --id 'menu[2]'   the menus and their entries; one menu whole
sap-ui-automation act '<json>' [--full]          one action (below); '[...]' one screen's actions (20 at most)
sap-ui-automation okcode </nVA03>                same as act okcode: starts a transaction (no Enter after it)
sap-ui-automation open <'#Intent-action'>        same as act open: a Fiori launchpad app
sap-ui-automation screenshot                     a PNG (charts, HTML panels the text cannot show)
sap-ui-automation record start "<name>" | assert '<json>' | stop | list | status   a repeatable test
sap-ui-automation replay <file>                  run a recorded test again, no model
sap-ui-automation daemon status | stop
```

`look`, `act`, `okcode`, `open`, `screenshot` and `record` take
`--session <ref>`. Exit codes: 0 done, 1 error or refused (the message is
on stderr), 2 usage.

## Actions

Shorthands for the common ones: `act set <id> <value>`, `press <id>`,
`key <n>`, `select <id>`, `check <id> true|false`, `combo <id> [key]`,
`f4 <id>`, `dblclick <id>`, `scroll <id> <row|next|prev|first|last>`.
Everything else is JSON:

```
{"do":"set","id":"ctxtVBAK-AUART","value":"OR"}     type into a field
{"do":"set","id":"<grid>","row":0,"col":"SEATSOCC","value":"12"}   a cell of an input grid
{"do":"press","id":"btn[8]"}                        a button (btn[N] is function key N)
{"do":"key","key":0}                                0 Enter, 3 Back, 4 F4, 8 F8, 11 Save, 12 Cancel
{"do":"select","id":"tabpT\\08"}                    tab, radio button, menu entry, list item
{"do":"select","id":"<table or grid>","row":2}      select a row
{"do":"check","id":"...","value":true}              checkbox
{"do":"combo","id":"...","key":"PROG"}              dropdown entry; without key: lists the entries
{"do":"okcode","value":"/nVA03"}                    the command field (the only way to type into it)
{"do":"f4","id":"..."}                              value help
{"do":"grid","id":"...","row":0,"col":"VBELN","how":"double|select|cell"}
{"do":"tree","id":"...","node":"<key>","how":"double|select|expand|collapse"}
{"do":"toolbar","id":"...","button":"<id>"}
{"do":"scroll","id":"...","to":120}                 a row from 0, or next/prev/first/last
{"do":"open","app":"#SalesOrder-manage"}            Fiori: a launchpad app by its intent
```

## How SAP screens behave

- **Fields take effect on Enter.** `set` only types. Fill the screen, then
  `act key 0` once.
- **Do not guess codes**: open the value help (`act f4 <id>`) and pick.
- **`okcode /n<tcode>` drops unsaved input** in the current transaction.
- **Popups come first.** A `WINDOW wnd[1]` blocks the screen below until it
  is answered.
- **A list shows the rows on screen and the total.** Never conclude that an
  entry is missing from the rows on screen: scroll, or
  `look --id <id> --rows 100-150`. A wide grid shows its first 15 columns
  and names the others: read them with `--cols`.
- **Numbers follow the user's notation.** Trust the `NUMBERS` line: with
  `NUMBERS 1.234,56`, "1.000" is one thousand and "312,000" is 312. When it
  says `NUMBERS unknown`, find the notation first (an amount with decimals
  on another screen, or the user's defaults in SU3).
- **Leaving without saving:** `act key 3` (Back) or `act key 12` (Cancel).
  When SAP asks whether to save, answer No unless the user asked to save.

## Several sessions

`sap-ui-automation okcode /oVA03` opens another session of the same logon (SAP GUI
and Web GUI), and that session becomes the active one. Send it on its own:
inside a list it is refused. Then pass `--session <id>` on every command
instead of relying on the active session. A Web GUI session that
`sap-ui-automation sessions` marks "not verified" is still loading or shows a popup:
list again before you work in it.

A logon has a limit of sessions (6 unless the system sets another). When
`/o` answers that the logon has all the sessions it allows, answer SAP's
popup and reuse a session you no longer need. Do not send `/o` again.

## Writing to SAP

Saving, posting, releasing and deleting change the system for real. The
user's `SAP_WRITE` setting decides what happens:

- **confirm** (default) and **off** (read-only): the action is refused.
  The CLI cannot ask the user, so confirm refuses here too. Tell the user what you would
  have saved and whether the document may be locked. Discard only your own
  disposable input or edits the user authorized you to discard.
- **on**: the action runs, and the user's approval of your command is the
  check. Before a save the user has not asked for, describe it in plain
  words. Afterwards say what you saved, with the document number.

Save with `sap-ui-automation act key 11` on every surface (in Web GUI the CLI presses
the toolbar's Save button for it).

Never work around the setting, for example with a save code in the command
field. The `SAP_*` settings are the user's decision: never set, export or
change them yourself (no `SAP_WRITE=on` in front of a command), not even to
repeat what is already set. Report a refused write to the user, who decides.

The CLI keeps a background daemon per directory, started on the first call
with that call's `SAP_*` settings. A call with other settings is refused.
Run `sap-ui-automation daemon stop` only when the user asked for the new settings.
