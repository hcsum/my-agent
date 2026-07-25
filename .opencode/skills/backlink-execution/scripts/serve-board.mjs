#!/usr/bin/env node
// Serve the backlink board with a small local write API.
// Usage: node serve-board.mjs [--port 8787]

import { createServer } from "node:http";
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../../..");
const JSON_PATH = resolve(repo, "notes/projects/site-backlinks/backlink-master.json");
const BOARD_PATH = resolve(repo, "notes/projects/site-backlinks/backlink-board.html");
const BUILD = resolve(here, "build-board.mjs");
const portArg = process.argv.find((arg) => arg.startsWith("--port="));
const port = Number(portArg?.split("=")[1] || process.env.PORT || 8787);

function readMaster() {
  return JSON.parse(readFileSync(JSON_PATH, "utf8"));
}

function writeMaster(master) {
  writeFileSync(JSON_PATH, `${JSON.stringify(master, null, 2)}\n`);
}

function activeCampaignId(master, project) {
  const campaign = (master.campaigns || []).find((c) => c.project === project && c.status === "active");
  return campaign?.id || "";
}

function localDate(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function savePlacement({ website, project, url = "", submitted }) {
  if (!website || typeof website !== "string") throw new Error("missing website");
  if (!project || typeof project !== "string") throw new Error("missing project");
  if (typeof url !== "string") throw new Error("url must be a string");
  const placementUrl = url.trim();
  if (!submitted && !placementUrl) throw new Error("mark submitted or provide a url");

  const master = readMaster();
  if (!Array.isArray(master.websites)) throw new Error("master.websites is missing");
  const site = master.websites.find((entry) => entry.website === website);
  if (!site) throw new Error(`unknown website: ${website}`);
  if (master.projects && !master.projects.includes(project)) throw new Error(`unknown project: ${project}`);

  site.placements ||= [];
  let placement = site.placements.find((entry) => entry.project === project);
  if (!placement) {
    placement = { project, index: {} };
    site.placements.push(placement);
  }
  placement.status = "submitted";
  if (placementUrl) placement.url = placementUrl;
  else delete placement.url;
  const campaignId = activeCampaignId(master, project);
  if (campaignId) placement.campaign_id = campaignId;
  placement.index = { status: "unverified" };
  placement.submitted_at = localDate();
  delete placement.follow_up_at;

  writeMaster(master);
  execFileSync(process.execPath, [BUILD], { cwd: repo, stdio: "pipe" });
  return { ok: true, website, project, url: placement.url, status: placement.status };
}

// "发不了" — the user tried and the target didn't work. Three scopes, because
// "why" splits three ways and collapsing them loses real targets:
//   project — mismatch for this project only; other projects still see it
//   defer   — a site-wide price/threshold, not a dead site. Out of the worklist
//             but kept in its own visible bucket, because "要钱" is a decision
//             deferred until there's budget, not a verdict.
//   site    — the site is genuinely unusable; drop it for every project
function blockPlacement({ website, project, reason = "", scope = "project", clear = false }) {
  if (!website || typeof website !== "string") throw new Error("missing website");
  if (!project || typeof project !== "string") throw new Error("missing project");
  const text = String(reason).trim();
  if (!clear && !text) throw new Error("写一句理由，不然过两周你不知道当初为什么放弃");

  const master = readMaster();
  if (!Array.isArray(master.websites)) throw new Error("master.websites is missing");
  const site = master.websites.find((entry) => entry.website === website);
  if (!site) throw new Error(`unknown website: ${website}`);

  site.placements ||= [];
  let placement = site.placements.find((entry) => entry.project === project);

  if (clear) {
    // Undo: drop the parked marker, and un-reject the domain if it was rejected
    // from the board. Anything with a real URL is a placement, not a block.
    if (placement && placement.status === "parked" && !placement.url) {
      site.placements = site.placements.filter((entry) => entry !== placement);
    }
    if (site.decision?.status === "rejected" || site.decision?.status === "deferred") {
      // Restore whatever it was before the block, so undoing an accidental
      // reject doesn't silently drop a vetted target out of the baseline.
      site.decision.status = site.decision.was || "needs_review";
      site.decision.reason = site.decision.was_reason || "";
      site.decision.decided_at = localDate();
      delete site.decision.was;
      delete site.decision.was_reason;
    }
    writeMaster(master);
    execFileSync(process.execPath, [BUILD], { cwd: repo, stdio: "pipe" });
    return { ok: true, website, project, cleared: true };
  }

  if (scope === "site" || scope === "defer") {
    const next = scope === "site" ? "rejected" : "deferred";
    const was = site.decision?.status;
    site.decision = {
      ...(site.decision || {}),
      status: next,
      reason: text,
      decided_at: localDate(),
      // Only stash a *real* prior status, so flipping 暂缓 → 排除 doesn't
      // overwrite the "active" we still want to come back to.
      ...(was && was !== "rejected" && was !== "deferred"
        ? { was, was_reason: site.decision?.reason || "" }
        : {}),
    };
  } else {
    if (!placement) {
      placement = { project, index: {} };
      site.placements.push(placement);
    }
    placement.status = "parked";
    placement.reason = text;
    placement.blocked_at = localDate();
  }

  writeMaster(master);
  execFileSync(process.execPath, [BUILD], { cwd: repo, stdio: "pipe" });
  return { ok: true, website, project, scope };
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, headers);
  res.end(body);
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://127.0.0.1:${port}`);
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/backlink-board.html")) {
      send(res, 200, readFileSync(BOARD_PATH), {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/placements") {
      const result = savePlacement(await readJson(req));
      send(res, 200, JSON.stringify(result), {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/blocked") {
      const result = blockPlacement(await readJson(req));
      send(res, 200, JSON.stringify(result), {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      });
      return;
    }

    send(res, 404, "not found\n", { "content-type": "text/plain; charset=utf-8" });
  } catch (error) {
    send(res, 400, JSON.stringify({ error: error.message || String(error) }), {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    });
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Backlink board: http://127.0.0.1:${port}/`);
});
