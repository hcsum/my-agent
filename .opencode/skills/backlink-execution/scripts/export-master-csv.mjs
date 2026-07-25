#!/usr/bin/env node
// Export the JSON backlink master to a wide CSV for human inspection.
// Usage: node export-master-csv.mjs

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../../..");
const JSON_PATH = resolve(repo, "notes/projects/site-backlinks/backlink-master.json");
const OUT = resolve(repo, "notes/projects/site-backlinks/backlink-master.export.csv");

const META = [
  "website",
  "decision_status",
  "decision_reason",
  "decision_decided_at",
  "type_primary",
  "type_surface",
  "pricing_model",
  "pricing_requires_payment",
  "pricing_note",
  "link_rel",
  "link_rel_checked_at",
  "link_robots",
  "link_robots_checked_at",
  "gsc",
  "AS",
  "DR",
  "note",
  "example_source",
];

function readMaster() {
  const parsed = JSON.parse(readFileSync(JSON_PATH, "utf8"));
  if (Array.isArray(parsed)) return { projects: inferProjects(parsed), websites: parsed };
  return parsed;
}

function inferProjects(websites) {
  return [...new Set(websites.flatMap((site) => (site.placements || []).map((p) => p.project)))];
}

function csvField(value) {
  const s = value == null ? "" : String(value);
  return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

const master = readMaster();
const projects = master.projects || inferProjects(master.websites || []);
const header = META.concat(projects.flatMap((project) => [
  project,
  `${project}_detail`,
  `${project}_index_status`,
  `${project}_index_checked`,
  `${project}_index_source`,
]));

const rows = (master.websites || []).map((site) => {
  const placements = new Map((site.placements || []).map((p) => [p.project, p]));
  const row = {
    website: site.website || "",
    decision_status: site.decision?.status || "",
    decision_reason: site.decision?.reason || "",
    decision_decided_at: site.decision?.decided_at || "",
    type_primary: site.type?.primary || "",
    type_surface: site.type?.surface || "",
    pricing_model: site.pricing?.model || "",
    pricing_requires_payment: site.pricing?.requires_payment ?? "",
    pricing_note: site.pricing?.note || "",
    link_rel: site.link?.rel || "",
    link_rel_checked_at: site.link?.rel_checked_at || "",
    link_robots: site.link?.robots || "",
    link_robots_checked_at: site.link?.robots_checked_at || "",
    gsc: site.gsc?.seen_at || "",
    AS: site.authority?.as ?? "",
    DR: site.authority?.dr ?? "",
    note: site.note || "",
    example_source: site.example_source || "",
  };
  for (const project of projects) {
    const placement = placements.get(project) || {};
    row[project] = placement.status || "";
    row[`${project}_detail`] = placement.url || placement.detail || "";
    row[`${project}_index_status`] = placement.index?.status || "";
    row[`${project}_index_checked`] = placement.index?.checked_at || "";
    row[`${project}_index_source`] = placement.index?.source || "";
  }
  return header.map((field) => csvField(row[field])).join(",");
});

writeFileSync(OUT, `${header.map(csvField).join(",")}\n${rows.join("\n")}\n`);
console.log(`wrote ${OUT} (${rows.length} websites, ${projects.length} projects)`);
