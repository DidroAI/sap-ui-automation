/**
 * `install --skills`: copies the skills shipped in this package (`skills/<name>/SKILL.md`
 * and whatever else is in that folder) to where agents read them:
 *
 * - Claude Code: `.claude/skills/<name>/` in the project, or `~/.claude/skills/<name>/` (--global);
 * - Codex: `.agents/skills/<name>/` in the project, or `~/.agents/skills/<name>/` (--global),
 *   where Codex reads a user's skills;
 * - Cursor: `.cursor/rules/<name>.mdc` in the project (Cursor has no user rule files,
 *   so --global skips it); the SKILL.md frontmatter becomes a rule's
 *   `description` with `alwaysApply: false`, so Cursor picks it by description.
 *
 * It is idempotent: a file with the same content is left alone and reported unchanged.
 * A file that differs is replaced, unless `overwrite` is false (init without
 * --force): then it is kept, as the user may have edited it.
 */
import { createHash } from "node:crypto";
import { closeSync, constants, cpSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const SKILL_TARGETS = ["claude", "codex", "cursor"] as const;
export type SkillTarget = (typeof SKILL_TARGETS)[number];

/** The package root: two levels up from src/cli/ (bun) or dist/cli/ (node). */
export function packageRoot(from: string = import.meta.url): string {
  return join(dirname(fileURLToPath(from)), "..", "..");
}

export interface Skill {
  name: string;
  dir: string;
  /** Paths relative to `dir`, SKILL.md included. */
  files: string[];
}

function walk(dir: string, base = dir): string[] {
  return readdirSync(dir)
    .sort()
    .flatMap((f) => {
      const p = join(dir, f);
      return statSync(p).isDirectory() ? walk(p, base) : [relative(base, p)];
    });
}

/** Every `skills/<name>/` folder that has a SKILL.md. */
export function shippedSkills(root: string = packageRoot()): Skill[] {
  const dir = join(root, "skills");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .sort()
    .filter((n) => existsSync(join(dir, n, "SKILL.md")))
    .map((name) => ({ name, dir: join(dir, name), files: walk(join(dir, name)) }));
}

/** SKILL.md (frontmatter `name`, `description`) as a Cursor rule. */
export function cursorRule(skillMd: string): string {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(skillMd);
  const front = m?.[1] ?? "";
  const body = m ? skillMd.slice(m[0].length) : skillMd;
  const description = /^description:[ \t]*(.*)$/m.exec(front)?.[1]?.trim() ?? "";
  return `---\ndescription: ${description}\nglobs:\nalwaysApply: false\n---\n${body}`;
}

export type FileState = "created" | "updated" | "unchanged" | "kept";

export interface InstallResult {
  lines: string[];
  files: { path: string; state: FileState }[];
}

export interface InstallOptions {
  targets: SkillTarget[];
  global?: boolean;
  dryRun?: boolean;
  cwd?: string | undefined;
  home?: string;
  env?: Record<string, string | undefined>;
  /** Where the skills come from (tests). Default: this package. */
  root?: string | undefined;
  /** Replace a file that differs from the shipped one. Default: true. */
  overwrite?: boolean;
}

/** The file's content, or undefined when there is no such file. Read once, with no check before. */
export function readIfThere(path: string): Buffer | undefined;
export function readIfThere(path: string, encoding: "utf8"): string | undefined;
export function readIfThere(path: string, encoding?: "utf8"): Buffer | string | undefined {
  try {
    return encoding ? readFileSync(path, encoding) : readFileSync(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
}

function put(path: string, content: string | Buffer, dryRun: boolean, overwrite: boolean): FileState {
  const old = readIfThere(path);
  if (old?.equals(Buffer.from(content))) return "unchanged";
  if (old !== undefined && !overwrite) return "kept";
  if (!dryRun) {
    mkdirSync(dirname(path), { recursive: true });
    // A file that was not there is only created: one made meanwhile is not overwritten.
    writeFileSync(path, content, { flag: old === undefined ? "wx" : "w" });
  }
  return old === undefined ? "created" : "updated";
}

const LABEL: Record<SkillTarget, string> = { claude: "Claude Code", codex: "Codex", cursor: "Cursor" };

/** Where a target's skills go; undefined when the target has no such scope. */
export function skillsDir(target: SkillTarget, global: boolean, cwd: string, home: string, env: Record<string, string | undefined>): string | undefined {
  if (target === "claude") return global ? join(env.CLAUDE_CONFIG_DIR || join(home, ".claude"), "skills") : join(cwd, ".claude", "skills");
  if (target === "codex") return join(global ? home : cwd, ".agents", "skills");
  return global ? undefined : join(cwd, ".cursor", "rules");
}

export function installSkills(opts: InstallOptions): InstallResult {
  const cwd = opts.cwd ?? process.cwd();
  const home = opts.home ?? homedir();
  const env = opts.env ?? process.env;
  const dryRun = !!opts.dryRun;
  const overwrite = opts.overwrite ?? true;
  const skills = shippedSkills(opts.root);
  const lines: string[] = [];
  const files: InstallResult["files"] = [];
  if (!skills.length) return { lines: [`✗ Skills: none found in ${join(opts.root ?? packageRoot(), "skills")}.`], files };
  const show = (p: string) => (p.startsWith(cwd + sep) ? relative(cwd, p) : p.startsWith(home + sep) ? join("~", relative(home, p)) : p);
  const verb = (s: FileState) => (s === "kept" ? "differs, kept (--force replaces it)" : dryRun && s !== "unchanged" ? `would be ${s}` : s);

  for (const target of opts.targets) {
    const dir = skillsDir(target, !!opts.global, cwd, home, env);
    if (!dir) {
      lines.push(`– ${LABEL[target]} skills: Cursor has no user-level rule files; run without --global in the project.`);
      continue;
    }
    for (const old of Object.keys(OLD_SKILL_NAMES)) {
      // Only exact released content identifies an unmarked old installation.
      const path = target === "cursor" ? join(dir, `${old}.mdc`) : join(dir, old);
      const ours = target === "cursor" ? releasedFile(path, `${old}.mdc`) : ownSkill(path);
      if (!ours) continue;
      if (!overwrite) {
        lines.push(`– ${LABEL[target]} skill ${old}: the old name of ${OLD_SKILL_NAMES[old]}, kept (--force removes it) (${show(path)})`);
        continue;
      }
      if (!dryRun) rmSync(path, { recursive: true, force: true });
      lines.push(`• ${LABEL[target]} skill ${old}: ${dryRun ? "would be removed" : "removed"}, now ${OLD_SKILL_NAMES[old]} (${show(path)})`);
    }
    for (const skill of skills) {
      let state: FileState;
      let shown: string;
      if (target === "cursor") {
        shown = join(dir, `${skill.name}.mdc`);
        state = put(shown, cursorRule(readFileSync(join(skill.dir, "SKILL.md"), "utf8")), dryRun, overwrite);
        files.push({ path: shown, state });
      } else {
        shown = join(dir, skill.name);
        const states = skill.files.map((f) => {
          const path = join(shown, f);
          const s = put(path, readFileSync(join(skill.dir, f)), dryRun, overwrite);
          files.push({ path, state: s });
          return s;
        });
        // The skill is new when its SKILL.md is; a file left as the user had it makes it kept; any other change is an update.
        const main = states[skill.files.indexOf("SKILL.md")];
        state = main === "created" ? "created" : states.includes("kept") ? "kept" : states.every((s) => s === "unchanged") ? "unchanged" : "updated";
      }
      lines.push(`${state === "unchanged" ? "✓" : state === "kept" ? "–" : "•"} ${LABEL[target]} skill ${skill.name}: ${verb(state)} (${show(shown)})`);
    }
  }
  return { lines, files };
}

// ---------------------------------------------------------------- setup: the skills, for the user, with the MCP server

/**
 * The skills' names before 0.2 (renamed 2026-11-25 to carry the product's name). A copy left under an
 * old name would give the agent the same skill twice, so setup and install remove the ones this package wrote.
 */
export const OLD_SKILL_NAMES: Record<string, string> = { "sap-gui-drive": "sap-ui-automation", "sap-gui-cli": "sap-ui-automation-cli" };

/** Left in each skill folder setup writes, so that only those are replaced later. */
export const SKILL_MARKER = ".sap-ui-automation";

// SHA-256 of the SKILL.md files shipped in v0.1.0 through v0.5.1 and the
// two Cursor rules generated under the v0.1.0 names. Each skill in these
// releases contained only SKILL.md.
const releasedFiles: Record<string, readonly string[]> = {
  "sap-gui-cli": ["00075332e4c16a753c45170fa4bf6a3b4d6e0eae665517ec824af1d4d34e6e5b"],
  "sap-gui-cli.mdc": ["742c2048e886e7715a598832df19928018da3ab9dcbf86d925e6c22bb6b9bce3"],
  "sap-gui-drive": ["5d893e47048c5f7142baf93999c2d65542562672544a2da16edc8f15402595ad"],
  "sap-gui-drive.mdc": ["6c8cef9f86694529fddf1e9ec50bbe863cf52869f29fb98e29277db7a516d2fc"],
  "sap-ui-automation": ["1540fd97a95591af24d8172b340dc786b4c58d063d43f5723939ba8464865e50", "d1c782310d9c27d6613b3b647f700f460a3ab2fb8e8d36285e561d5781acd54c", "76dd1ef884ee11b763c6ab3d1e1f59822b7d097996541b1c9b76b62bd6f59080"],
  "sap-ui-automation-cli": ["946fba483b3a535ebb0dac860df77032ffe4b34626ad8ea77c11167fb03ce44f", "b330a1f7430faaef60d5d3470d46e89f765c6544ba17a20ac86f39694b3afd0f", "42eff1eec873d0e2071a90d9bc91c9348bbc21033c2505937ba52251c2be46e7"],
};

/** Read one regular file by its opened handle; a link or a changed entry cannot establish ownership. */
function skillFile(path: string): Buffer | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const file = fstatSync(fd, { bigint: true });
    const entry = lstatSync(path, { bigint: true });
    if (file.isFile() && entry.isFile() && entry.dev === file.dev && entry.ino === file.ino) return readFileSync(fd);
  } catch {
    // A missing, inaccessible or concurrently replaced file is not an ownership match.
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  return undefined;
}

function releasedFile(path: string, key: string): boolean {
  const hashes = releasedFiles[key];
  const bytes = hashes && skillFile(path);
  return !!bytes && hashes.includes(createHash("sha256").update(bytes).digest("hex"));
}

export function ownSkill(target: string, skill?: Skill): boolean {
  if (!lstat(target)?.isDirectory()) return false;
  const marker = lstat(join(target, SKILL_MARKER));
  if (marker) return marker.isFile();
  if (skill && sameSkill(skill, target)) return true;
  const entries = readdirSync(target);
  return entries.length === 1 && entries[0] === "SKILL.md" && releasedFile(join(target, "SKILL.md"), basename(target));
}

/** What setup did with one skill in one folder. */
export type SkillState = "installed" | "updated" | "unchanged" | "linked" | "copied" | "left";

export interface FolderResult {
  dir: string;
  /** The canonical folder itself, or one whose entries link to it. */
  canonical: boolean;
  states: Record<string, SkillState>;
  /** Old-named copies of this package's skills taken out. */
  removed: string[];
}

export interface SharedSkillsOptions {
  /** The one real copy: ~/.agents/skills. */
  canonical: string;
  dryRun: boolean;
  platform: NodeJS.Platform;
  /** Where the skills come from (tests). Default: this package. */
  root?: string | undefined;
  /** Makes the link (tests make it fail, as on a Windows that refuses links). */
  link?: ((target: string, path: string) => void) | undefined;
}

const lstat = (p: string) => {
  try {
    return lstatSync(p);
  } catch {
    return undefined;
  }
};
const real = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    // A folder not made yet: its parent may still be a link.
    const parent = dirname(p);
    return parent === p ? p : join(real(parent), p.slice(parent.length + 1));
  }
};
/** Removes a link without touching what it points to, or a folder with its content. */
const remove = (p: string) => (lstat(p)?.isSymbolicLink() ? unlinkSync(p) : rmSync(p, { recursive: true, force: true }));

/** Whether the folder holds exactly the shipped files (the marker aside). */
function sameSkill(skill: Skill, target: string): boolean {
  try {
    const matches = (source: string, dest: string): boolean => {
      const entries = readdirSync(source, { withFileTypes: true });
      const installed = readdirSync(dest).filter((name) => dest !== target || name !== SKILL_MARKER);
      if (entries.length !== installed.length) return false;
      return entries.every((entry) => {
        const a = join(source, entry.name);
        const b = join(dest, entry.name);
        if (entry.isDirectory()) return !!lstat(b)?.isDirectory() && matches(a, b);
        return skillFile(b)?.equals(readFileSync(a)) === true;
      });
    };
    return matches(skill.dir, target);
  } catch {
    return false;
  }
}

function copySkill(skill: Skill, target: string): void {
  remove(target);
  mkdirSync(dirname(target), { recursive: true });
  cpSync(skill.dir, target, { recursive: true });
  writeFileSync(join(target, SKILL_MARKER), "Installed by sap-ui-automation setup; replaced on the next setup.\n");
}

/** Puts a real copy at `target`, unless a folder there is not ours. */
function placeCopy(skill: Skill, target: string, dryRun: boolean): SkillState {
  const l = lstat(target);
  if (l && !ownSkill(target, skill)) return "left";
  if (l && !l.isSymbolicLink() && sameSkill(skill, target)) return "unchanged";
  if (!dryRun) copySkill(skill, target);
  return l ? "updated" : "installed";
}

/** Whether the link at `p` leads to `target` (read without following, so it works before `target` exists). */
function pointsTo(p: string, target: string): boolean {
  try {
    return resolve(dirname(p), readlinkSync(p)) === resolve(target) || realpathSync(p) === realpathSync(target);
  } catch {
    return false;
  }
}

function defaultLink(platform: NodeJS.Platform) {
  return (target: string, path: string) => {
    // A junction on Windows needs no privilege; elsewhere a relative link survives a moved home.
    if (platform === "win32") symlinkSync(target, path, "junction");
    else symlinkSync(relative(real(dirname(path)), target), path, "dir");
  };
}

/**
 * Installs the shipped skills the way `npx skills` does: one real copy in `canonical`
 * (~/.agents/skills), and in every other folder a link to it; where a link cannot be made,
 * a copy. A folder of the same name that is not this package's stays as it is, and old-named
 * copies are removed only when they are ours. Folders that are the same place (a link
 * between them, or the same path) are written once.
 */
export function setupSharedSkills(dirs: string[], opts: SharedSkillsOptions): FolderResult[] {
  const skills = shippedSkills(opts.root);
  const link = opts.link ?? defaultLink(opts.platform);
  const results: FolderResult[] = [];
  const dropOld = (dir: string) => {
    const removed: string[] = [];
    for (const old of Object.keys(OLD_SKILL_NAMES)) {
      const p = join(dir, old);
      if (!lstat(p) || !ownSkill(p)) continue;
      removed.push(old);
      if (!opts.dryRun) remove(p);
    }
    return removed;
  };
  const home = real(opts.canonical);
  const top: FolderResult = { dir: opts.canonical, canonical: true, states: {}, removed: dropOld(opts.canonical) };
  for (const skill of skills) top.states[skill.name] = placeCopy(skill, join(opts.canonical, skill.name), opts.dryRun);
  results.push(top);
  const seen = new Map([[home, top]]);
  for (const dir of dirs) {
    const where = real(dir);
    const same = seen.get(where);
    if (same) {
      // The same place under another name (a link between them): reported as that one, written once.
      if (dir !== same.dir) results.push({ ...same, dir });
      continue;
    }
    const r: FolderResult = { dir, canonical: false, states: {}, removed: dropOld(dir) };
    for (const skill of skills) {
      const p = join(dir, skill.name);
      const target = join(opts.canonical, skill.name);
      const shared = top.states[skill.name];
      // The canonical name is someone else's: this folder gets a copy of its own.
      if (shared === "left") {
        r.states[skill.name] = placeCopy(skill, p, opts.dryRun);
        continue;
      }
      const l = lstat(p);
      if (l?.isSymbolicLink() && pointsTo(p, target)) {
        r.states[skill.name] = shared === "unchanged" ? "unchanged" : "updated";
        continue;
      }
      if (l && !ownSkill(p, skill)) {
        r.states[skill.name] = "left";
        continue;
      }
      if (opts.dryRun) {
        r.states[skill.name] = "linked";
        continue;
      }
      remove(p);
      mkdirSync(dir, { recursive: true });
      try {
        link(target, p);
        r.states[skill.name] = "linked";
      } catch {
        copySkill(skill, p);
        r.states[skill.name] = "copied";
      }
    }
    results.push(r);
    seen.set(where, r);
  }
  return results;
}
