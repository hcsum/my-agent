#!/usr/bin/env node
// One-shot migration: split each project's single column into `<project>` (status)
// + `<project>_detail` (live URL, or the reason it's parked).
//
// The old schema had one cell per project holding four different kinds of thing —
// a live URL, "parked, <reason>", "reviewing", or a bare "done" — which is why
// never-placed targets were being counted as placements.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../../..");
const CSV = resolve(repo, "notes/projects/site-backlinks/backlink-master.csv");
const META = ["website", "difficulty", "AS", "DR", "note", "example_source"];

function parseCsv(text) {
  const rows = []; let row = []; let field = ""; let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false; }
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (c !== "\r") field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((x) => x.trim()));
}

const q = (s) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

const raw = parseCsv(readFileSync(CSV, "utf8"));
const header = raw[0];
const projects = header.filter((h) => !META.includes(h));
const records = raw.slice(1).map((r) => Object.fromEntries(header.map((h, i) => [h, (r[i] ?? "").trim()])));

const log = [];

// --- targeted repairs of the two structurally broken rows -------------------
for (const r of records) {
  if (r.website === "cal.com") {
    // note held magic.ly's live URL, copy-pasted from that row by mistake.
    log.push(`cal.com: dropped bogus note ${r.note}`);
    r.note = "";
    // User checked 2026-07-19: only the declutter link exists on the profile.
    r["everland.cc"] = "";
    log.push("cal.com: cleared everland.cc (verified absent 2026-07-19)");
  }
  if (r.website === "lovestrategies.com") {
    // A comma-separated how-to sentence had spilled across the three project columns.
    const frag = projects.map((p) => r[p]).filter(Boolean).join(", ").replace(/\s+/g, " ").trim();
    r.note = r.note ? `${r.note} ${frag}` : frag;
    for (const p of projects) r[p] = "";
    log.push(`lovestrategies.com: recovered spilled note "${frag}", cleared 3 status cells`);
  }
}

// --- classify every remaining cell -----------------------------------------
function classify(v) {
  if (!v) return ["", ""];
  const m = v.match(/https?:\/\/\S+/);
  if (/^parked/i.test(v)) return ["parked", v.replace(/^parked,?\s*/i, "")];
  if (/^reviewing/i.test(v)) return ["reviewing", m ? m[0] : ""];
  if (/^done,\s*no link/i.test(v)) return ["nolink", m ? m[0] : ""];
  if (v === "done") return ["unverified", ""];
  if (m && v.startsWith("http")) return ["live", m[0]];
  return ["unverified", v];
}

const stats = {};
for (const r of records) {
  for (const p of projects) {
    const [status, detail] = classify(r[p]);
    r[`${p}__status`] = status;
    r[`${p}__detail`] = detail;
    if (status) stats[status] = (stats[status] || 0) + 1;
  }
}

const newHeader = [...META, ...projects.flatMap((p) => [p, `${p}_detail`])];
const out = [newHeader.map(q).join(",")];
for (const r of records) {
  out.push(newHeader.map((h) => {
    if (META.includes(h)) return q(r[h] || "");
    if (h.endsWith("_detail")) return q(r[`${h.slice(0, -7)}__detail`] || "");
    return q(r[`${h}__status`] || "");
  }).join(","));
}
writeFileSync(CSV, out.join("\n") + "\n");

console.log("repairs:");
for (const l of log) console.log("  -", l);
console.log("\nplacement statuses:", stats);
console.log(`\n${records.length} rows, ${newHeader.length} columns`);
