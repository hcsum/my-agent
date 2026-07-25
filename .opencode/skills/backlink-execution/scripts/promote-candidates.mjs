#!/usr/bin/env node
// Promote triaged rows from a candidates CSV into backlink-master.json.
// Usage: node promote-candidates.mjs <competitor-substring> [--dry]
//
// Reads notes/projects/site-backlinks/backlink-candidates-<sub>*.csv, appends every
// kept row as a new website object, skips domains already in the master, and
// regenerates the board. Rows deleted during triage are simply never seen here —
// the value gate is "not in the CSV anymore".

import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../../..");
const DIR = resolve(repo, "notes/projects/site-backlinks");
const JSON_PATH = resolve(DIR, "backlink-master.json");
const BUILD = resolve(here, "build-board.mjs");

const args = process.argv.slice(2);
const dry = args.includes("--dry");
const sub = args.find((a) => !a.startsWith("--"));
if (!sub) fail("Usage: promote-candidates.mjs <competitor-substring> [--dry]");

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

function findCandidates(sub) {
  const hits = readdirSync(DIR)
    .filter((f) => f.startsWith("backlink-candidates-") && f.endsWith(".csv") && f.toLowerCase().includes(sub.toLowerCase()));
  if (!hits.length) fail(`No backlink-candidates-*${sub}*.csv in ${DIR}`);
  if (hits.length > 1) fail(`Ambiguous, matched: ${hits.join(", ")}`);
  return resolve(DIR, hits[0]);
}

// Minimal RFC4180 reader; candidate files carry quoted URLs and commas in notes.
function readCsv(file) {
  const text = readFileSync(file, "utf8");
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (c !== "\r") field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const header = rows.shift().map((h) => h.trim());
  return { header, rows: rows.filter((r) => r.some((v) => v.trim())) };
}

const normDomain = (h) => h.toLowerCase().trim().replace(/^www\./, "").replace(/\.$/, "");
const today = () => new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
}).format(new Date());

const file = findCandidates(sub);
const competitor = basename(file).replace(/^backlink-candidates-/, "").replace(/\.csv$/, "");
const { header, rows } = readCsv(file);
const idx = (name) => header.indexOf(name);
const iWebsite = idx("website");
if (iWebsite < 0) fail(`${file} has no "website" column`);
const iDifficulty = idx("difficulty");
const iAs = idx("AS");
const iExample = idx("example_source");
const iDofollow = idx("dofollow");
const iNote = idx("note");

const master = JSON.parse(readFileSync(JSON_PATH, "utf8"));
if (!Array.isArray(master.websites)) fail("master.websites is missing");
const known = new Set(master.websites.map((s) => normDomain(String(s.website || ""))));

const added = [];
const skipped = [];
for (const r of rows) {
  const website = normDomain(r[iWebsite] || "");
  if (!website) continue;
  if (known.has(website)) { skipped.push(website); continue; }
  known.add(website);

  const difficulty = (iDifficulty >= 0 ? r[iDifficulty] : "").trim().toLowerCase();
  const as = iAs >= 0 ? parseInt(r[iAs], 10) : NaN;
  const example = (iExample >= 0 ? r[iExample] : "").trim();
  // Semrush's per-link dofollow flag is a hint about the competitor's link, not a
  // verified property of our future placement. It seeds `note`, never `link.rel` —
  // link.rel is only ever written after we check the real placement page ourselves.
  const semrushDofollow = (iDofollow >= 0 ? r[iDofollow] : "").trim().toLowerCase();
  const csvNote = (iNote >= 0 ? r[iNote] : "").trim();

  // `difficulty` has no home in the JSON schema (decision.status covers do/don't,
  // type.primary implies the effort). It survives as prose in `note`.
  const notes = [];
  if (difficulty && difficulty !== "dead") notes.push(`triage ${today()}: ${difficulty}`);
  if (semrushDofollow === "true") notes.push("competitor link was dofollow (Semrush, unverified)");
  if (csvNote) notes.push(csvNote);

  const site = {
    website,
    decision: difficulty === "dead"
      ? { status: "rejected", reason: "Ruled out at triage.", decided_at: today() }
      : { status: "needs_review", reason: `From ${competitor} backlink export; link value not verified yet.`, decided_at: today() },
    type: { primary: "unknown" },
    pricing: { model: "unknown" },
    link: {},
    authority: {},
    gsc: {},
    placements: [],
  };
  if (Number.isFinite(as) && as > 0) site.authority.as = as;
  if (example) site.example_source = example;
  if (notes.length) site.note = notes.join(" · ");
  master.websites.push(site);
  added.push(website);
}

console.log(`${file}\n  ${added.length} promoted, ${skipped.length} already in master`);
if (added.length) console.log(`  + ${added.join("\n  + ")}`);
if (dry) { console.log("(dry run, nothing written)"); process.exit(0); }
if (!added.length) process.exit(0);

master.updated_at = today();
writeFileSync(JSON_PATH, `${JSON.stringify(master, null, 2)}\n`);
execFileSync(process.execPath, [BUILD], { cwd: repo, stdio: "inherit" });
