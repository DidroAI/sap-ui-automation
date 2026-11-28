import { readFileSync } from "node:fs";
import { defineConfig } from "vitepress";
import { faqJsonLd, softwareJsonLd, writeLlmsTxt } from "./seo.mts";

// A static site: no analytics, no hosted search, no external fonts or scripts.
// The same markdown files ship in the npm package (docs/**/*.md) for agents to read offline.
//
// For search engines and agents: each page has a title and description (frontmatter), Open Graph
// and Twitter tags, JSON-LD on the home page (SoftwareApplication) and the FAQ (FAQPage), and the
// build writes llms.txt and llms-full.txt. Canonical links and sitemap.xml need the address the
// site is served at: set DOCS_SITE_URL (for example https://example.com/sap-ui-automation) to get them.
const SITE = process.env.DOCS_SITE_URL?.replace(/\/+$/, "");
const NAME = "SAP UI MCP";
const DESCRIPTION = "Let an AI agent see and interact with the SAP screens you have open: SAP GUI for Windows, Web GUI and Fiori. Each write waits for your yes.";
const VERSION: string = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version;

/** The page's address under SITE, as VitePress serves it with cleanUrls. */
const pageUrl = (relativePath: string) => `${SITE}/${relativePath.replace(/(^|\/)index\.md$/, "$1").replace(/\.md$/, "")}`;

export default defineConfig({
  title: NAME,
  description: DESCRIPTION,
  lang: "en",
  cleanUrls: true,
  lastUpdated: false,
  srcExclude: ["README.md", "node_modules/**"],
  // Links to repository files (src/, CONTRIBUTING.md, ...) use full GitHub URLs, so every relative link must resolve.
  ignoreDeadLinks: false,
  ...(SITE ? { sitemap: { hostname: `${SITE}/` } } : {}),
  head: [
    ["meta", { name: "robots", content: "index,follow" }],
    ["link", { rel: "icon", type: "image/png", href: "/icon.png" }],
    ["meta", { property: "og:site_name", content: NAME }],
    ["meta", { name: "twitter:card", content: "summary" }],
  ],
  transformHead({ pageData, title, description }) {
    const home = pageData.relativePath === "index.md";
    const head: [string, Record<string, string>, string?][] = [
      ["meta", { property: "og:type", content: home ? "website" : "article" }],
      ["meta", { property: "og:title", content: title }],
      ["meta", { property: "og:description", content: description }],
      ["meta", { name: "twitter:title", content: title }],
      ["meta", { name: "twitter:description", content: description }],
    ];
    if (SITE) {
      const url = pageUrl(pageData.relativePath);
      head.push(["link", { rel: "canonical", href: url }], ["meta", { property: "og:url", content: url }], ["meta", { property: "og:image", content: `${SITE}/icon.png` }]);
    }
    if (home) head.push(["script", { type: "application/ld+json" }, JSON.stringify(softwareJsonLd(VERSION, DESCRIPTION))]);
    if (pageData.relativePath === "faq.md") {
      const faq = faqJsonLd(readFileSync(new URL("../faq.md", import.meta.url), "utf8"));
      if (faq) head.push(["script", { type: "application/ld+json" }, JSON.stringify(faq)]);
    }
    return head;
  },
  async buildEnd(siteConfig) {
    writeLlmsTxt(siteConfig, { name: NAME, version: VERSION, site: SITE });
  },
  themeConfig: {
    search: { provider: "local" },
    nav: [
      { text: "Get started", link: "/getting-started/choose" },
      { text: "Concepts", link: "/concepts/surfaces" },
      { text: "Guides", link: "/guides/chrome" },
      { text: "Reference", link: "/reference/tools" },
      { text: "Security", link: "/security" },
    ],
    sidebar: [
      {
        text: "Getting started",
        items: [
          { text: "Introduction", link: "/getting-started/" },
          { text: "Choose your setup", link: "/getting-started/choose" },
          { text: "Install in your client", link: "/getting-started/installation" },
          { text: "Set up with your agent", link: "/getting-started/setup-prompt" },
          { text: "Setup steps for agents", link: "/agent-setup" },
          { text: "Your first session", link: "/getting-started/first-session" },
        ],
      },
      {
        text: "Concepts",
        items: [
          { text: "Surfaces", link: "/concepts/surfaces" },
          { text: "The screen view", link: "/concepts/screen-view" },
          { text: "Ids and handles", link: "/concepts/ids" },
          { text: "Actions", link: "/concepts/actions" },
          { text: "Safety model", link: "/concepts/safety" },
          { text: "Confirm mode", link: "/concepts/confirm-mode" },
        ],
      },
      {
        text: "Guides",
        items: [
          { text: "Chrome: Web GUI and Fiori", link: "/guides/chrome" },
          { text: "SAP GUI for Windows (scripting)", link: "/guides/sap-gui-windows" },
          { text: "SAP GUI for Windows: network reader (experimental)", link: "/guides/network-reader" },
          { text: "CLI for coding agents", link: "/guides/cli-for-agents" },
          { text: "Writing tests with the SDK", link: "/guides/sdk-tests" },
          { text: "Recording and replay", link: "/guides/record-replay" },
          { text: "Trace viewer", link: "/guides/trace-viewer" },
        ],
      },
      {
        text: "Reference",
        items: [
          { text: "MCP tools", link: "/reference/tools" },
          { text: "Actions", link: "/reference/actions" },
          { text: "Configuration", link: "/reference/configuration" },
          { text: "CLI commands", link: "/reference/cli" },
        ],
      },
      {
        text: "More",
        items: [
          { text: "Security and data handling", link: "/security" },
          { text: "Benchmarks", link: "/benchmarks" },
          { text: "Comparison", link: "/comparison" },
          { text: "FAQ and troubleshooting", link: "/faq" },
        ],
      },
    ],
    socialLinks: [{ icon: "github", link: "https://github.com/DidroAI/sap-ui-mcp" }],
    editLink: { pattern: "https://github.com/DidroAI/sap-ui-mcp/edit/main/docs/:path" },
    footer: {
      message: "MIT licence. Not affiliated with, endorsed by or sponsored by SAP SE. SAP and other SAP products are trademarks of SAP SE.",
    },
  },
});
