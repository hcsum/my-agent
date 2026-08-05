#!/usr/bin/env node
/**
 * Render a markdown resume (or any markdown doc) to a print-quality PDF.
 *
 * Pipeline: markdown --marked--> HTML + print CSS --weasyprint--> PDF
 *
 * WeasyPrint is required rather than headless Chrome: Chrome's --print-to-pdf
 * embeds macOS CJK fonts as Type 3 with blank glyphs, so Chinese text silently
 * disappears from the PDF while still rendering fine on screen.
 *
 * Usage:
 *   node md2pdf.mjs <input.md> [output.pdf] [--css <file.css>] [--density tight|normal|loose]
 */

import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

// ---------------------------------------------------------------- args

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : fallback;
};
const positional = argv.filter((a, i) => {
  if (a.startsWith("--")) return false;
  return !argv[i - 1]?.startsWith("--");
});

const input = positional[0];
if (!input) {
  console.error("usage: node md2pdf.mjs <input.md> [output.pdf] [--css file] [--density tight|normal|loose]");
  process.exit(1);
}
if (!fs.existsSync(input)) {
  console.error(`input not found: ${input}`);
  process.exit(1);
}

const output =
  positional[1] || path.join(path.dirname(input), path.basename(input, path.extname(input)) + ".pdf");
const cssOverride = flag("css");
const density = flag("density", "normal");

// ---------------------------------------------------------------- marked

async function loadMarked() {
  try {
    return (await import("marked")).marked;
  } catch {}
  // Fall back to any globally installed copy, including one nested inside
  // another global package.
  try {
    const root = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
    const candidates = [path.join(root, "marked")];
    for (const pkg of fs.readdirSync(root, { withFileTypes: true })) {
      if (!pkg.isDirectory()) continue;
      candidates.push(path.join(root, pkg.name, "node_modules", "marked"));
    }
    for (const dir of candidates) {
      const esm = path.join(dir, "lib", "marked.esm.js");
      if (fs.existsSync(esm)) return (await import(esm)).marked;
      if (fs.existsSync(path.join(dir, "package.json"))) return require(dir).marked;
    }
  } catch {}
  console.error("marked not found. Install it:  npm i -D marked   (or  npm i -g marked)");
  process.exit(1);
}

// ---------------------------------------------------------------- css

const DENSITY = {
  tight: { page: "10mm 12mm", body: 9.2, line: 1.25, h1: 17, h2: 11, h3: 10, meta: 8.3, gap: 9 },
  normal: { page: "12mm 15mm", body: 9.6, line: 1.3, h1: 18, h2: 11.5, h3: 10.4, meta: 8.6, gap: 11 },
  loose: { page: "13mm 15mm", body: 10.2, line: 1.4, h1: 19, h2: 12, h3: 11, meta: 9.2, gap: 14 },
};
const d = DENSITY[density] || DENSITY.normal;

const defaultCss = `
  @page { size: A4; margin: ${d.page}; }
  * { box-sizing: border-box; }
  body {
    font-family: "Helvetica Neue", "Arial", "PingFang SC", "Hiragino Sans GB", sans-serif;
    font-size: ${d.body}pt; line-height: ${d.line}; color: #000; margin: 0;
  }
  h1 { font-size: ${d.h1}pt; margin: 0 0 1px; }
  h2 { font-size: ${d.h2}pt; border-bottom: 1.4px solid #333; padding-bottom: 2px;
       margin: ${d.gap}px 0 5px; }
  h3 { font-size: ${d.h3}pt; margin: 8px 0 0; }
  p { margin: 2px 0; }
  em { color: #666; font-style: normal; font-size: ${d.meta}pt; }
  ul { margin: 3px 0; padding-left: 16px; }
  li { margin: 1.5px 0; }
  a { color: #1a4f8b; text-decoration: none; }
  hr { border: none; border-top: 1px solid #ccc; margin: 8px 0; }
  strong { color: #000; }
  code { font-family: "SF Mono", Menlo, monospace; font-size: ${(d.body - 1.2).toFixed(1)}pt;
         background: #f4f4f4; padding: 0 2px; border-radius: 3px; }
  /* explicit page break marker */
  .pb { page-break-after: always; }
  /* never orphan a section or job heading at the foot of a page */
  h2, h3 { page-break-after: avoid; }
`;

const css = cssOverride ? fs.readFileSync(cssOverride, "utf8") : defaultCss;

// ---------------------------------------------------------------- render

const marked = await loadMarked();

let src = fs.readFileSync(input, "utf8");
// Accept the inline-style page break some editors produce and normalise it.
src = src.replace(/<div style="page-break-after:\s*always;?"><\/div>/g, '\n\n<div class="pb"></div>\n\n');

const html = `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body>${marked.parse(src)}</body></html>`;

const htmlPath = path.join(
  fs.mkdtempSync(path.join(process.env.TMPDIR || "/tmp", "md2pdf-")),
  "doc.html",
);
fs.writeFileSync(htmlPath, html);

const wp = spawnSync("weasyprint", [htmlPath, output], { encoding: "utf8" });
if (wp.error || wp.status !== 0) {
  console.error("weasyprint failed. Install it:  brew install weasyprint");
  if (wp.stderr) console.error(wp.stderr.trim());
  process.exit(1);
}

// ---------------------------------------------------------------- report

let pages = "?";
const info = spawnSync("pdfinfo", [output], { encoding: "utf8" });
if (info.status === 0) pages = (info.stdout.match(/Pages:\s+(\d+)/) || [])[1] || "?";

console.log(`${output}  (${pages} pages)`);
