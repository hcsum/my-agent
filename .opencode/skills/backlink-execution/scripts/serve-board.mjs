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

function addDays(date, days) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function savePlacement({ website, project, url, status = "reviewing", reviewAfterDays = 14 }) {
  if (!website || typeof website !== "string") throw new Error("missing website");
  if (!project || typeof project !== "string") throw new Error("missing project");
  if (!url || typeof url !== "string") throw new Error("missing url");
  if (!["reviewing", "live"].includes(status)) throw new Error("status must be reviewing or live");
  const days = Number(reviewAfterDays);
  if (![14, 30].includes(days)) throw new Error("reviewAfterDays must be 14 or 30");
  const parsedUrl = new URL(url);
  if (!["http:", "https:"].includes(parsedUrl.protocol)) throw new Error("url must be http(s)");

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
  placement.status = status;
  placement.url = parsedUrl.toString();
  const campaignId = activeCampaignId(master, project);
  if (campaignId) placement.campaign_id = campaignId;
  placement.index = { status: "unverified" };
  if (status === "reviewing") {
    const now = new Date();
    placement.submitted_at = localDate(now);
    placement.follow_up_at = localDate(addDays(now, days));
  } else {
    placement.live_at = localDate();
    delete placement.follow_up_at;
  }

  writeMaster(master);
  execFileSync(process.execPath, [BUILD], { cwd: repo, stdio: "pipe" });
  return { ok: true, website, project, url: placement.url, status: placement.status };
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
