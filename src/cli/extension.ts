/**
 *   sap-ui-automation extension install [dir]  copies the Chrome extension to a folder Chrome can load, and
 *                                               installs its helper (pairing in one click, passwords in the keychain)
 *   sap-ui-automation extension pair           prints the pairing code, for pairing by hand
 *   sap-ui-automation extension uninstall [dir] removes the helper, the passwords it saved, and the copied extension
 *
 * Until the extension is in the Chrome Web Store, it is loaded unpacked from a
 * folder. The package's own copy lives in npm's cache, which npx may clear, so
 * `install` copies it to a stable place first (default ~/sap-ui-automation-extension,
 * a folder Chrome's file dialog shows on every system). `unpack` is the same.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const EXTENSION_HELP = `  sap-ui-automation extension install [dir]
                                copy the Chrome extension to dir (default ~/sap-ui-automation-extension) to load it
                                in chrome://extensions > Load unpacked, and install its helper: the extension
                                then pairs in one click and keeps saved SAP passwords in the keychain
  sap-ui-automation extension helper
                                install only the helper, for the extension from the Chrome Web Store: it then
                                pairs in one click and keeps saved SAP passwords in the keychain
  sap-ui-automation extension pair
                                print the pairing code, to pair the extension by hand (SAP_BROWSER=extension)
  sap-ui-automation extension uninstall [dir]
                                remove the helper from every browser, the SAP passwords it saved in the keychain,
                                and the copied extension (dir, default ~/sap-ui-automation-extension)`;

/** Where files go: the user's home and environment (tests pass their own), and whether uninstall clears the keychain. */
export interface ExtensionOptions {
  home?: string;
  env?: Record<string, string | undefined>;
  keychain?: boolean;
}

/** Where `install` copied the extension last: kept next to the pairing file, for `uninstall`. */
async function folderFile(o: ExtensionOptions): Promise<string> {
  const { pairingFile } = await import("../browser/extension/pairing.js");
  return join(dirname(pairingFile(process.platform, o.env ?? process.env, o.home ?? homedir())), "extension-folder");
}
async function rememberFolder(dir: string, o: ExtensionOptions): Promise<void> {
  try {
    const f = await folderFile(o);
    mkdirSync(dirname(f), { recursive: true, mode: 0o700 });
    writeFileSync(f, `${dir}\n`);
  } catch {}
}
async function rememberedFolder(o: ExtensionOptions): Promise<string | undefined> {
  try {
    return readFileSync(await folderFile(o), "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}

/** Does this folder hold our extension (its manifest's key is ours)? */
function hasOurManifest(dir: string): boolean {
  try {
    const mine = JSON.parse(readFileSync(join(bundledExtensionDir(), "manifest.json"), "utf8")) as { key?: string };
    const there = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as { key?: string };
    return !!mine.key && there.key === mine.key;
  } catch {
    return false;
  }
}

/** Is this folder a copy of our extension? Only such a folder is ever emptied:
 *  never the package's own extension folder, nor one inside a source checkout. */
function isOurCopy(dir: string): boolean {
  if (resolve(dir) === resolve(bundledExtensionDir())) return false;
  if (existsSync(join(dir, "..", "package.json")) || existsSync(join(dir, "..", ".git"))) return false;
  return hasOurManifest(dir);
}

/** A path that exists and is not an empty folder. */
function inUse(dir: string): boolean {
  if (!existsSync(dir)) return false;
  try {
    return !statSync(dir).isDirectory() || readdirSync(dir).length > 0;
  } catch {
    return true;
  }
}

/** The extension folder shipped with the package: <package>/extension, from src/cli or dist/cli alike. */
export function bundledExtensionDir(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "extension");
}

export async function extensionCommand(args: string[], out: (l: string) => void = console.log, err: (l: string) => void = console.error, o: ExtensionOptions = {}): Promise<number> {
  const home = o.home ?? homedir();
  const sub = args[0];
  if (sub === "pair") {
    const { extensionPairCommand } = await import("../browser/extension/index.js");
    for (const l of await extensionPairCommand()) out(l);
    return 0;
  }
  // The extension from the Chrome Web Store needs only its helper: no unpacked copy.
  if (sub === "helper") {
    const { installNativeHost } = await import("../browser/extension/native.js");
    try {
      const host = installNativeHost({ home, env: o.env ?? process.env });
      if (!host.registered.length) {
        err(`Copied the helper to ${host.hostDir}, but no browser profile folder took it (is Chrome installed?). Pair by hand: run "npx -y sap-ui-automation extension pair" and paste the code into the extension's side panel.`);
        return 1;
      }
      out(`Installed the extension's helper in ${host.hostDir} (for ${host.registered.length} browser profile folder(s)).`);
    } catch (e) {
      err(`Could not install the helper: ${(e as Error).message}. Pair by hand: run "npx -y sap-ui-automation extension pair" and paste the code into the extension's side panel.`);
      return 1;
    }
    out("");
    out(`Restart Chrome, then click the SAP UI MCP icon (under the puzzle piece in Chrome's toolbar; pin it there) and Pair in the side panel.`);
    return 0;
  }
  if (sub === "install" || sub === "unpack") {
    const from = bundledExtensionDir();
    if (!existsSync(join(from, "manifest.json"))) {
      err(`The extension is not in this package (looked in ${from}).`);
      return 1;
    }
    const to = resolve(args[1] ?? join(home, "sap-ui-automation-extension"));
    if (resolve(to) === resolve(from)) {
      err(`${to} is the package's own extension folder: pick another folder.`);
      return 1;
    }
    // A folder that holds something else is not ours to fill.
    if (inUse(to) && !hasOurManifest(to)) {
      err(`${to} is not empty and holds no copy of the extension: pick an empty or new folder.`);
      return 1;
    }
    // An older copy goes first, so that files this version no longer has do not stay behind.
    if (isOurCopy(to)) rmSync(to, { recursive: true, force: true });
    cpSync(from, to, { recursive: true, filter: (p) => !/STORE\.md$/i.test(p) });
    out(`Copied the extension to ${to}`);
    await rememberFolder(to, o);
    const { installNativeHost } = await import("../browser/extension/native.js");
    let paired = false;
    try {
      const host = installNativeHost({ home, env: o.env ?? process.env });
      paired = host.registered.length > 0;
      out(paired ? `Installed its helper in ${host.hostDir} (for ${host.registered.length} browser profile folder(s)).` : `Copied its helper to ${host.hostDir}, but no browser took it: pair by hand (see below).`);
    } catch (e) {
      err(`Could not install the helper: ${(e as Error).message}. Pair by hand (see below).`);
    }
    out("");
    out(`In Chrome: open chrome://extensions, turn on Developer mode, click "Load unpacked" and pick ${to}.`);
    out(`(In the folder dialog on a Mac, press Cmd+Shift+G and type ${to}.)`);
    out(paired ? `Then click the SAP UI MCP icon (under the puzzle piece in Chrome's toolbar; pin it there) and Pair in the side panel.` : `Then run "npx -y sap-ui-automation extension pair" and paste the code into the extension's side panel.`);
    out(`To update: run "npx -y sap-ui-automation@latest extension install" again, then click the reload arrow on the extension's card in chrome://extensions.`);
    return 0;
  }
  if (sub === "uninstall") {
    const { uninstallNativeHost } = await import("../browser/extension/native.js");
    const to = resolve(args[1] ?? (await rememberedFolder(o)) ?? join(home, "sap-ui-automation-extension"));
    const r = uninstallNativeHost({ home, env: o.env ?? process.env, ...(o.keychain === false ? { keychain: false } : {}) });
    for (const x of r.removed) out(`Removed ${x}`);
    if (r.keychainItems > 0) out(`Deleted ${r.keychainItems} saved SAP password(s) from the keychain.`);
    else if (r.keychainItems < 0) out("No SAP password saved by the extension is left in the keychain.");
    else out("No SAP password saved by the extension was found in the keychain.");
    if (isOurCopy(to)) {
      rmSync(to, { recursive: true, force: true });
      out(`Removed the extension's folder ${to}`);
    } else out(`No copy of the extension in ${to}. If you installed it elsewhere, run uninstall with that folder.`);
    out("");
    out(`Last step, in Chrome: open chrome://extensions and click Remove on "SAP UI MCP".`);
    return 0;
  }
  err(`Usage:\n${EXTENSION_HELP}`);
  return 2;
}
