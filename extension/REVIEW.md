# Review: Agent Connector 0.3.0

> A record of the review of extension version 0.3.0, kept as it was. The
> extension was called "Agent Connector for SAP Systems" then; it is now
> **SAP UI MCP**, and its icon is the SAP logo with a pointer on a navy tile,
> not the `>_` mark findings U5 and F12 discuss. Current behaviour is in
> [README.md](README.md) and [PROTOCOL.md](PROTOCOL.md).

Before this version was called ready, four reviewers looked at it on their
own, from the code and the screenshots: a Fiori designer, a first-time user
(an SAP consultant on a Mac), a security engineer, and a reviewer for Web
Store and enterprise distribution. Each finding is marked **fixed** (with
where) or **rejected** (with why). A second round then checked the result
(at the end).

Severity: B blocker, M major, m minor.

## Security and privacy

| # | Finding | | Outcome |
|---|---|---|---|
| S1 | Any process running as the user (an agent with a shell) can read the keychain items (`security find-generic-password`, `secret-tool lookup`, DPAPI), and the profile fallback is plain text. | B | **Fixed in part.** The plain-text profile fallback is gone: without a keychain no password is saved (`savePassword`), and 0.2's profile passwords move to the keychain (`migrateProfilePasswords`). **Rejected in part:** an ACL that only the helper may read (`-T`) is not possible while the helper itself reads through `/usr/bin/security`, and a signed native helper is out of scope for now. Documented instead: README "What the keychain does not protect against" (give such an agent no shell, or use SSO). |
| S2 | The agent opens a same-origin window from a shared tab, keeps a reference, and reads the password typed into it when `sap_logon` reuses that tab. | B | **Fixed.** Nothing is typed into a tab the server had: every logon that types runs in a new `about:blank` tab with no opener (`doLogonSteps`). Service workers are bypassed in the logon tab (`Network.setBypassServiceWorker`). Residual, documented: a script gadget that reads the origin's storage on SAP's own logon page. |
| S3 | After `needs_user`, `password_change`, `wrong_password` or `identity_provider`, the tab is shared again while it still shows a password field: the agent can read what the user types. | B | **Fixed.** A tab that shows a password field is never shared (`guardTab`): held back, watched with the extension's own debugger, shared once the field is gone; survives a worker restart (`restorePrivate`). A shared tab that loads such a page (session timeout) is held back too and re-loaded fresh (`checkPasswordPage`). Test: "the tab at SAP's logon page is held back". |
| S4 | `Network.enable {maxPostDataSize: 0}` hides the body from the extension's password check; `getRequestPostData` then returns it. JSON bodies slip past. | H | **Fixed.** `Network.enable` is always sent with `maxPostDataSize: 65536`; a page's own form post without an inline body is treated as secret; JSON password keys are matched. Test: "a client that asks Chrome to leave bodies out…". |
| S5 | The 5 s wait for the logon page does not check the host: a redirect to another host's form gets the SAP password. | M | **Fixed.** That wait requires the system's host; the focusing script checks `location.hostname` and `top === self` right before each `Input.insertText` (`FOCUS`). |
| S6 | The extension's scripts run in the page's main world: page scripts can patch `focus()` and steer the typing. | M | **Fixed.** All logon scripts run in an isolated world (`evalIn` → `Page.createIsolatedWorld`); only the read of the launchpad's user and client (used to pick a tab, never to type) runs in the page (`SESSION`). |
| S7 | A look-alike host can be registered from a suggestion; editing a system's URL to a new host keeps its password. | M | **Fixed in part:** a password never follows a system to another host (`saveSystem`), the popup shows the full host, and the form warns on `http:`. **Rejected:** hiding suggestions for tabs opened by a shared tab; the user still reads the host and confirms in Chrome's permission prompt. |
| S8 | `sap_error` passes up to 200 characters of page text, which could echo a field; UI5 controls may keep the value; newline in the macOS label; the public `key` lets a side-loaded copy in another browser use the helper. | L | **Fixed:** every SAP message is scrubbed of the password and cut to 200 characters; `quote()` strips line breaks. **Checked:** on the real ECC and S/4 logons the tab handed back has no password in any field. **Rejected:** the `key` note: side-loading needs local access as the user, which S1 already covers. |

## Distribution

| # | Finding | | Outcome |
|---|---|---|---|
| D1 | No privacy policy. | B | **Fixed:** `PRIVACY.md` (data table, local only, Limited Use statement), linked from the popup's Settings, the manifest's homepage and `STORE.md`. |
| D2 | Passwords in clear text without the helper. | B | **Fixed:** see S1. |
| D3 | The store id is not allowed by the native host; who holds the key. | B | **Fixed as a procedure:** `STORE.md` "The extension id" (upload with the key to keep the id, or add the store id to `EXTENSION_IDS` and release npm first). The key itself stays with the maintainers. |
| D4 | No uninstall. | B | **Fixed:** `npx -y sap-ui-automation extension uninstall` removes the host manifests and registry keys, the helper, the keychain items and the copied folder (`uninstallNativeHost`), documented in both READMEs. Test: install, run, uninstall. |
| D5 | `debugger` needs a justification; consider an allow-list of methods. | M | **Fixed:** justifications for every permission in `STORE.md`. **Rejected:** a method allow-list: Playwright uses a wide, version-dependent set of methods; the deny-list plus scope checks (PROTOCOL.md "Scope") is what is enforced and tested. |
| D6 | Single purpose may read as two. | M | **Fixed:** the single-purpose statement in `STORE.md` puts saved logons inside the one purpose. |
| D7 | Trademark. | M | **Fixed:** "Not affiliated with SAP SE" in the manifest, "SAP is a trademark of SAP SE" in the READMEs and listing; the mark is now a flat tile with no gradient (see F12). |
| D8 | Per-user helper only; managed fleets can block it. | M | **Fixed in docs:** README "For IT" names `NativeMessagingAllowlist` / `NativeMessagingUserLevelHosts`. **Rejected for now:** an `install --system` mode; it needs admin rights and a test machine per OS. Follow-up. |
| D9 | The launcher points at the Node.js that installed it. | M | **Fixed:** the launcher falls back to `node` from PATH (and Homebrew's folders); `doctor` now runs the helper (`nativeHostAnswers`) instead of checking a file. Test: launcher with a vanished Node path. |
| D10 | Files removed in an update stay in the copied folder. | M | **Fixed:** `install` empties the folder first, only when it holds our extension (same manifest key). |
| D11 | Versions disagree (manifest 0.3.0, package 0.1.0). | M | **Rejected:** the extension and the npm package version separately on purpose (the store needs a rising extension version per upload); the popup now says "Extension Version", and `STORE.md` explains it. |
| D12 | Third-party notices out of date; no LICENSE in `extension/`. | m | **Fixed:** the font and lucide icons are gone (all icons drawn for this extension, no font bundled); `extension/LICENSE` added. |
| D13 | No `homepage_url`. | m | **Fixed** in the manifest. |
| D14 | `minimum_chrome_version` 132 unexplained. | m | **Fixed:** `STORE.md` (`Page.frameStartedNavigating`). |
| D15 | Store assets missing. | m | **Fixed in part:** the 128 px icon has 96 px of artwork in 16 px of space; `STORE.md` lists the rest. **Open:** the 1280×800 screenshots and the 440×280 tile are made at the first store upload. |
| D16, D17 | Host description name; "not in the Web Store". | m | **Rejected:** accurate as they are. |

## First-time user

| # | Finding | | Outcome |
|---|---|---|---|
| U1 | No way to uninstall. | B | **Fixed:** D4. |
| U2 | Passwords stop working after a Node.js upgrade. | B | **Fixed:** D9. |
| U3 | A password is saved for an `http://` address without a word. | B | **Fixed:** the form warns under the address (`f-url-http`). |
| U4 | Button names in the docs don't match the UI. | M | **Fixed:** both READMEs use the exact labels. |
| U5 | Four names for the product. | M | **Fixed:** "Agent Connector for SAP Systems" in the manifest, docs, CLI and the agent's messages ("the Agent Connector icon"). |
| U6 | The yellow bar's text in the docs is wrong. | M | **Fixed.** |
| U7 | The README says the extension keeps other logons; it now asks. | M | **Fixed.** |
| U8 | `sap-ui-automation extension pair` without `npx`. | M | **Fixed** everywhere. |
| U9 | Updating may reuse a cached old version. | M | **Fixed:** `npx -y sap-ui-automation@latest extension install`, then reload. |
| U10 | Setting `SAP_BROWSER` is jargon. | M | **Fixed:** the full Claude Desktop block, and "quit and reopen". |
| U11 | `doctor` in extension mode: how, and its wording. | M | **Fixed in docs** (`SAP_BROWSER=extension npx … doctor`, close the agent app first). **Rejected:** doctor telling "another server holds it" apart; the agent's own `sap_logon` says so (busy). |
| U12, U13 | Pinning; finding the folder on a Mac. | m | **Fixed** in the README and the CLI's output. |
| U14 | Client, language, user unexplained. | m | **Fixed:** a hint under each field. |
| U15 | Pairing and busy messages vague and inconsistent. | m | **Fixed:** "This extension and your agent don't match. Click Pair Again." and "Another agent app is already connected." on both sides. |
| U16 | The status strip stays over the form. | m | **Fixed** (also F10). |
| U17 | "Something went wrong." | m | **Fixed:** says what to do. |
| U18 | Version shown looks like a mismatch. | m | **Fixed:** "Extension Version". |
| U19 | "Open in Tab" next to an error. | m | **Fixed:** the tag is gone (F8). |
| U20 | Nothing in the popup says what the agent may do. | m | **Rejected for the popup** (height, F1); the README says it (works as you; `SAP_WRITE=off` keeps it to reading). |

## Fiori design

| # | Finding | | Outcome |
|---|---|---|---|
| F1 | About 700 px tall with three systems; Chrome caps popups at 600 px. | B | **Fixed:** compact controls in the list (32 px), merged detail lines, a shorter status text, sticky shell bar and footer. Three systems: 593 px. |
| F2 | Focus lost after Log On (the button is disabled). | B | **Fixed:** `aria-disabled` while busy. |
| F3 | Focus lost after menu picks, Remove, Cancel and a new save. | B | **Fixed:** focus goes back to the More button, to the next row after Remove, to the new row's main button after a save. |
| F4 | Save and Cancel in the wrong order. | B | **Fixed:** right-aligned, Save first, matching the tab order. |
| F5 | Save unreadable while pressed. | B | **Fixed:** an `:active` state for the emphasized button. |
| F6 | No gap between the user's hint and the password label; "Optional." | M | **Fixed.** |
| F7 | The busy dots overlap the strip's title. | M | **Fixed:** the strip keeps its icon; the dots, sized to 16 px, are only in the row. |
| F8 | "Open in Tab" next to an "Open" button. | M | **Fixed:** no tag; the button says **Show Tab** when the system is open. |
| F9 | "Update Password" makes the row's right edge ragged. | M | **Fixed:** a link in the error note; the row keeps **Log On** (which goes to the password, not to SAP). |
| F10 | The strip repeats other controls. | M | **Fixed:** no Resume button in it (the footer has it), hidden over the form and the empty list. |
| F11 | Solid and outline icons mixed; one glyph for two meanings. | M | **Fixed:** one outline set (1.5 px strokes); single sign-on has its own shield. |
| F12 | The mark blurs at 16 px; a gradient tile is near SAP's logo style. | M | **Fixed:** a flat tile, and a separate 16 px drawing (`icons/mark-16.svg`). **Rejected:** replacing the `>_` motif; it reads as "an agent at work in a window", which is the product. |
| F13 | The Ready badge looks like a button; "Pair Again" is an action, not a state. | m | **Fixed:** no border on the neutral badge; the state is "Code Mismatch". |
| F14 | Whole-row hover; missing `:active`/`:disabled` states. | m | **Fixed.** |
| F15 | "a SAP"; the checkbox label; "Fiori Launchpad" vs "launchpad"; "Add This System". | m | **Fixed:** "an SAP", **Use Single Sign-On** with a hint, "Fiori launchpad" in text. **Rejected:** "Add This System": "Add This SAP Page" says that it takes the page in front. |
| F16 | Form errors far from their fields. | m | **Fixed:** under the field, linked with `aria-describedby`. |
| F17 | Menu keyboard gaps. | m | **Fixed:** Arrow Down/Up on More opens the menu, Tab moves on, the menu is labelled by its button. |
| F18 | Contrast: link on the pressed button 4.21; the dashed add-row edge 1.65. | m | **Fixed:** pressed background `#e5e8eb`; dashed edge `--neutral-edge`. |
| F19 | Shadow and border on the shell bar; two live regions; port spinners; technical keychain name. | nit | **Fixed.** |
| F20 | Long names next to a wide button. | nit | **Fixed** with F9. |

## Live check

On this box's SAP systems (read-only; logon, first screen, log off):

| System | Result |
|---|---|
| ECC 6.0 Web GUI, client 800, a dialog user | `logged_on` in 3.2 s; asked again: `already` (same tab) |
| ECC, an RFC user | `refused` with SAP's "Logon through HTTP is not possible…" (and, on the HTTP port, SAP's "Log on with a dialog user" error page → `sap_error`) |
| S/4HANA Fiori launchpad, client 100 | `logged_on` in 1.9 to 3.6 s; asked again: `already` |
| ECC, a user that does not exist | `wrong_password` with SAP's "Client, name, or password is not correct"; asked again: refused at once, nothing sent. A non-existent user locks nobody, which is why it was used. |

No password appeared in any frame the relay received. The tabs of the
refused logons stayed with the user (held back), as designed. In one run,
two ECC Easy Access tabs were shared where one was expected; it did not
happen in the two runs after, and its cause was not found.

## Second round

Three reviewers checked the result: security; Fiori design; first-time user
and distribution together. Their verdicts on round one, then what they found
new and what was done.

**Verdicts.** Security: S2, S6, S8 hold; S1 holds in part (by design: any
process of the user can read the keychain); S3, S4, S5, S7 held only in
part, fixed below. Design: 13 of 20 hold; F3, F9, F10, F13, F15, F16, F18,
F19 held in part or not, fixed below. Distribution and first-time user: all
hold or hold in part except U8 (one command without `npx`), fixed below.

| # | Finding | | Outcome |
|---|---|---|---|
| R1 | A script the server leaves in a shared tab can hide SAP's logon page from the check (a field hidden at first, in a shadow root, `type=text` styled as a password), then read what the user types. | H | **Fixed in part:** a shared tab that comes to a password page is no longer held in place but emptied and closed, and the user logs on in a new tab the server never had (`replaceForUser`). **Rejected in part, documented:** the extension cannot stop a page the server scripts from drawing a password field of its own; PROTOCOL.md "Limits" and the README say to type the password only in a tab the extension opened. |
| R2 | A held tab can still be reached by another same-origin tab through a window reference. | H | **Fixed:** R1's new tab has no opener and was never shared; the old tab is emptied and closed. |
| R3 | Password fields in frames, or added without a page load, are missed. | H | **Rejected, documented** with R1: the server's own tabs are scripted by design; the firm guarantee is for the extension's own typing, which always happens in its own top-level tab. |
| R4 | A server `attach` in flight can complete after its tab was held back. | M | **Fixed:** `attachTab` undoes an attach that lands on a held tab; `cdp` and events of a held tab are dropped; the guard detaches the server before it attaches. |
| R5 | A restarted worker can answer the relay before held tabs are restored. | M | **Fixed:** the relay's requests wait for `privateRestored`. |
| R6 | `Network.enable` without `maxPostDataSize`, and XHR posts without an inline body. | M | **Fixed:** the size is always set; any request whose body Chrome left out is treated as secret. |
| R7 | No service-worker bypass in the guard. | M | **Fixed.** |
| R8 | Host checked, not scheme or port. | L | **Fixed:** a system registered with https is never typed into over http; a password is forgotten when the system's origin changes. Port changes on the same host stay allowed for typing (SAP moves from 8000 to 44300 on logon). |
| R9 | `scrub` misses encoded echoes. | L | **Fixed:** URL-encoded, HTML-escaped and case-changed forms. |
| R10 | `install`/`uninstall` could delete a source checkout's extension folder. | L | **Fixed:** never the package's own folder, nor one inside a checkout. |
| R11 | Focus lost after Cancel on a new system and after removing the last one. | M | **Fixed.** |
| R12 | The form's buttons below the fold under a sticky footer; Settings opening off-screen; focused rows under the sticky bars. | M | **Fixed:** the footer hides while editing and the form's buttons stick to the bottom; Settings scrolls into view; `scroll-padding` keeps focus visible. |
| R13 | With a new password asked, the open tab could not be reached; "Log On" opened the form. | M | **Fixed:** Show Tab when open; after a refused password the row's button is Open (the logon page, for the user), and the link updates the password. |
| R14 | Pressed button contrast 4.46. | M | **Fixed:** pressed text `#0054b6` (5.7:1). |
| R15 | Link style; http warning stacked; strip repeating the badge; Forget Password without confirmation; menu left behind on scroll; footer offset; Resume not emphasized while paused; faint busy dots; user shown in two cases. | m | **Fixed**, all. |
| R16 | Manifest description over 132 characters. | B | **Fixed** (122), with a test. |
| R17 | "For IT" said to force-install the unpacked extension. | B | **Fixed:** force-install needs the store listing or a hosted `.crx`. |
| R18 | Pair Again had nowhere to show its error without the helper. | M | **Fixed:** the pairing card, with its code field, shows on a code mismatch. |
| R19 | `NativeMessagingUserLevelHosts` advice wrong. | M | **Fixed:** a system-level manifest is needed there (not written by the CLI yet). |
| R20 | The privacy policy left data out. | M | **Fixed:** SAP's last answer, 0.2's profile passwords, tab ids, versions sent, per-system fields; the pairing code staying after uninstall. |
| R21 | The store's remote-code reading of relayed commands. | M | **Fixed:** STORE.md names the limits and the tests. |
| R22 | Edge users get Google Chrome started. | m | **Fixed in docs:** auto-start is for Google Chrome; others open their browser. |
| R23 | Launcher without nvm or Volta. | m | **Fixed:** Volta's folder and the newest nvm version. |
| R24 | Uninstall of a folder installed elsewhere; Linux message; copied README's links; `deliverables/` in STORE.md; main README's install steps. | m | **Fixed:** `install` remembers the folder; clearer messages; all docs but STORE.md copied; STORE.md and README updated. |
| R25 | U5, U8 leftovers ("sap-ui-automation extension", no `npx`). | m | **Fixed.** |

Open after both rounds, as follow-ups: a system-level helper install for
managed fleets (D8, R19); the store's 1280×800 screenshots and promo tile
(D15); a signed helper that the keychain could trust alone (S1).
