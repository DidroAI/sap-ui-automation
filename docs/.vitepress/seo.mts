// Structured data and llms.txt for the documentation site. Everything here is derived from the
// markdown pages and package.json at build time, so it stays in step with what the pages say.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DefaultTheme, SiteConfig } from "vitepress";

const REPO = "https://github.com/DidroAI/sap-ui-mcp";
const RAW = "https://raw.githubusercontent.com/DidroAI/sap-ui-mcp/main/docs";
const NPM = "https://www.npmjs.com/package/sap-ui-automation";
const STORE = "https://chromewebstore.google.com/detail/ui-automation-for-sap/geglpbkaklfpmnbidfcpflegmdkjodkn";
const PRODUCT_PAGE = "https://docs.didro.ai/sap-ui-automation/";
const DIDRO = { "@type": "Organization", name: "Didro", url: "https://didro.ai" };

/** JSON-LD for the home page: the package as a SoftwareApplication. */
export function softwareJsonLd(version: string, description: string) {
  return {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: "SAP UI MCP",
    alternateName: ["SAP GUI MCP server", "SAP Fiori MCP server", "sap-ui-automation"],
    description,
    url: PRODUCT_PAGE,
    applicationCategory: "DeveloperApplication",
    operatingSystem: "Windows, macOS, Linux",
    softwareVersion: version,
    softwareRequirements: "Node.js 22 or later; SAP GUI for Windows with scripting, or Google Chrome for Web GUI and Fiori",
    license: "https://opensource.org/licenses/MIT",
    downloadUrl: NPM,
    codeRepository: REPO,
    sameAs: [REPO, NPM, STORE],
    offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
    author: DIDRO,
    publisher: DIDRO,
  };
}

/** Markdown to the plain text a reader sees: no links, emphasis, code marks or list bullets. */
export function plainText(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, (block) => block.replace(/```[^\n]*\n?/g, ""))
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/(^|[^\w*])\*([^*\n]+)\*/g, "$1$2")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^\s*[-*]\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * JSON-LD for the FAQ: every question under "## Common questions" (a ### heading that ends with
 * "?"), with its answer as the page shows it. Undefined when the page has none.
 */
export function faqJsonLd(md: string) {
  const section = md.split(/^## Common questions\s*$/m)[1]?.split(/^## /m)[0];
  if (!section) return undefined;
  const entries = section
    .split(/^### /m)
    .slice(1)
    .map((part) => {
      const [heading = "", ...rest] = part.split("\n");
      return { q: plainText(heading), a: plainText(rest.join("\n")) };
    })
    .filter((e) => e.q.endsWith("?") && e.a);
  if (!entries.length) return undefined;
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: entries.map((e) => ({ "@type": "Question", name: e.q, acceptedAnswer: { "@type": "Answer", text: e.a } })),
  };
}

interface Page {
  path: string;
  title: string;
  description: string;
  body: string;
}

/** A page's frontmatter title and description (or its first heading), and its body without frontmatter. */
function readPage(srcDir: string, path: string): Page {
  const text = readFileSync(join(srcDir, path), "utf8");
  const fm = /^---\n([\s\S]*?)\n---\n/.exec(text);
  const field = (name: string) => {
    const m = fm && new RegExp(`^${name}:\\s*(.*)$`, "m").exec(fm[1] ?? "");
    const v = m?.[1]?.trim() ?? "";
    return v.startsWith('"') ? (JSON.parse(v) as string) : v;
  };
  const body = fm ? text.slice(fm[0].length) : text;
  return { path, title: field("title") || /^# (.+)$/m.exec(body)?.[1] || path, description: field("description"), body: body.trim() };
}

/** Sidebar links as page paths ("/guides/chrome" → "guides/chrome.md"), in sidebar order, by group. */
function sidebarGroups(sidebar: DefaultTheme.Sidebar | undefined): { text: string; paths: string[] }[] {
  if (!Array.isArray(sidebar)) return [];
  return sidebar.map((g) => ({
    text: g.text ?? "",
    paths: (g.items ?? []).flatMap((i) => (i.link ? [`${i.link.replace(/^\//, "").replace(/\/$/, "/index")}.md`] : [])),
  }));
}

/**
 * Writes llms.txt (an index of the pages, for agents: https://llmstxt.org) and llms-full.txt
 * (every page's markdown in one file) into the built site. Links go to the markdown on GitHub,
 * which an agent can read as it is.
 */
export function writeLlmsTxt(config: SiteConfig<DefaultTheme.Config>, o: { name: string; version: string; site?: string }) {
  const known = new Set(config.pages);
  const groups = sidebarGroups(config.site.themeConfig.sidebar).map((g) => ({ ...g, paths: g.paths.filter((p) => known.has(p)) }));
  const listed = new Set(groups.flatMap((g) => g.paths));
  const rest = config.pages.filter((p) => p !== "index.md" && !listed.has(p)).sort();
  if (rest.length) groups.push({ text: "Other pages", paths: rest });
  const page = (p: string) => readPage(config.srcDir, p);
  const link = (p: Page) => `${RAW}/${p.path}`;

  const intro = [
    `# ${o.name}`,
    "",
    `> sap-ui-automation (npm, MIT, version ${o.version}) is an MCP server, a CLI and an SDK that let an AI agent see and interact with the SAP screens open on the user's machine: SAP GUI for Windows (through SAP GUI scripting, or the experimental network reader), SAP GUI for HTML (Web GUI) and SAP Fiori in Chrome. Each action that may write to SAP waits for the user's yes (SAP_WRITE=confirm, the default); SAP_WRITE=off makes it read-only. The server never logs on and never sees a password. Not affiliated with SAP SE.`,
    "",
    "Ways to connect:",
    "",
    "- `npx -y sap-ui-automation setup` adds the server and its skills to the coding agents it finds (Claude Code, Codex, Cursor and more); `npx -y sap-ui-automation doctor` checks what it can reach.",
    "- Claude Code plugin: `/plugin marketplace add DidroAI/sap-ui-mcp`, then `/plugin install sap-ui-automation@sap-ui-automation`.",
    `- Claude Desktop: open ${REPO}/releases/latest/download/sap-ui-automation.mcpb`,
    `- Chrome extension "SAP UI MCP", to work in your everyday Chrome: ${STORE}`,
    "- MCP Registry: io.github.DidroAI/sap-ui-automation",
    `- Set up with an agent: ${RAW}/getting-started/setup-prompt.md (instructions for the agent: ${RAW}/agent-setup.md)`,
    "",
  ];
  const index = [...intro];
  const full = [...intro];
  for (const g of groups) {
    if (!g.paths.length) continue;
    index.push(`## ${g.text}`, "");
    for (const p of g.paths.map(page)) {
      index.push(`- [${p.title}](${link(p)})${p.description ? `: ${p.description}` : ""}`);
      full.push("---", "", `Source: ${link(p)}`, "", p.body, "");
    }
    index.push("");
  }
  index.push("## Source", "", `- [GitHub](${REPO}): code, issues, releases`, `- [npm](${NPM})`, `- [Product page](${PRODUCT_PAGE})`, "");
  if (o.site) index.push(`Site: ${o.site}/`, "");
  writeFileSync(join(config.outDir, "llms.txt"), index.join("\n"));
  writeFileSync(join(config.outDir, "llms-full.txt"), full.join("\n"));
}
