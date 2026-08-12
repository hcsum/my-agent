#!/usr/bin/env -S node --no-warnings
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

process.env.NODE_NO_WARNINGS = "1";
const { EnvHttpProxyAgent, setGlobalDispatcher } = await import("undici");
setGlobalDispatcher(new EnvHttpProxyAgent());

const root = process.cwd();
const credentialIndexPath = path.join(root, "notes/credentials/google-analytics-data-api.md");

function parseArgs(argv) {
  const args = {
    days: 28,
    dimensions: ["page", "query"],
    searchType: "web",
    rowLimit: 100,
    json: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") {
      args.json = true;
      continue;
    }
    if (!arg.startsWith("--")) {
      throw new Error(`Unexpected argument: ${arg}`);
    }

    const key = arg.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for ${arg}`);
    }
    i += 1;

    if (key === "days" || key === "rowLimit") {
      args[key] = Number(value);
    } else if (key === "dimensions") {
      args.dimensions = value.split(",").map((dimension) => dimension.trim()).filter(Boolean);
    } else {
      args[key] = value;
    }
  }

  if (!args.site && !args.siteUrl) {
    throw new Error("Pass --site <domain> or --site-url <GSC property>.");
  }
  if (!Number.isInteger(args.days) || args.days <= 0) {
    throw new Error("--days must be a positive integer.");
  }
  if (!Number.isInteger(args.rowLimit) || args.rowLimit <= 0) {
    throw new Error("--row-limit must be a positive integer.");
  }

  return args;
}

function readCredentialIndex() {
  return fs.readFileSync(credentialIndexPath, "utf8");
}

function resolveKeyPath(rawPath) {
  return path.isAbsolute(rawPath) ? rawPath : path.join(root, rawPath);
}

function parseKeyPaths(markdown) {
  return Array.from(markdown.matchAll(/key file: `([^`]+\.json)`/gi), (match) => resolveKeyPath(match[1]));
}

function normalizeSite(site) {
  return site.replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/$/, "");
}

function siteUrl(args) {
  if (args.siteUrl) return args.siteUrl;
  return `sc-domain:${normalizeSite(args.site)}`;
}

function b64url(input) {
  return Buffer.from(input).toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

async function getToken(keyPath) {
  const key = JSON.parse(fs.readFileSync(keyPath, "utf8"));
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const claim = {
    iss: key.client_email,
    scope: "https://www.googleapis.com/auth/webmasters.readonly",
    aud: "https://oauth2.googleapis.com/token",
    exp: now + 3600,
    iat: now,
  };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claim))}`;
  const signature = crypto.createSign("RSA-SHA256").update(signingInput).sign(key.private_key);
  const jwt = `${signingInput}.${b64url(signature)}`;
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: jwt }),
  });

  if (!res.ok) {
    throw new Error(`token ${res.status} ${await res.text()}`);
  }

  return { accessToken: (await res.json()).access_token, clientEmail: key.client_email };
}

function isoDate(daysAgo) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - daysAgo);
  return date.toISOString().slice(0, 10);
}

function dimensionFilter(args) {
  const filters = [];
  if (args.page) {
    filters.push({ dimension: "page", operator: "contains", expression: args.page });
  }
  if (args.query) {
    filters.push({ dimension: "query", operator: "contains", expression: args.query });
  }
  if (!filters.length) return undefined;
  return { groupType: "and", filters };
}

async function searchAnalytics(accessToken, property, args) {
  const body = {
    startDate: args.startDate ?? isoDate(args.days),
    endDate: args.endDate ?? isoDate(1),
    dimensions: args.dimensions,
    searchType: args.searchType,
    rowLimit: args.rowLimit,
    ...(dimensionFilter(args) ? { dimensionFilterGroups: [dimensionFilter(args)] } : {}),
  };
  const encoded = encodeURIComponent(property);
  const res = await fetch(`https://searchconsole.googleapis.com/webmasters/v3/sites/${encoded}/searchAnalytics/query`, {
    method: "POST",
    headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`gsc ${res.status} ${text}`);
  }

  return { request: body, rows: (JSON.parse(text).rows ?? []).map((row) => ({
    keys: row.keys ?? [],
    clicks: row.clicks ?? 0,
    impressions: row.impressions ?? 0,
    ctr: row.ctr ?? 0,
    position: row.position ?? 0,
  })) };
}

function summarize(result) {
  const { args, property, credential, report } = result;
  const lines = [];
  lines.push(`GSC property ${property}`);
  lines.push(`Credential: ${credential.clientEmail}`);
  lines.push(`Window: ${report.request.startDate} to ${report.request.endDate}; searchType: ${args.searchType}; dimensions: ${args.dimensions.join(",")}`);
  lines.push(`Filters: page=${args.page ?? "none"}; query=${args.query ?? "none"}`);
  lines.push("");
  lines.push(JSON.stringify(report.rows, null, 2));
  return lines.join("\n");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const markdown = readCredentialIndex();
  const property = siteUrl(args);
  const keyPaths = args.keyFile ? [resolveKeyPath(args.keyFile)] : parseKeyPaths(markdown);
  const errors = [];

  for (const keyPath of keyPaths) {
    try {
      const credential = await getToken(keyPath);
      const report = await searchAnalytics(credential.accessToken, property, args);
      const result = { args, property, credential: { clientEmail: credential.clientEmail }, report };
      console.log(args.json ? JSON.stringify(result, null, 2) : summarize(result));
      return;
    } catch (error) {
      errors.push(`${keyPath}: ${error.message}`);
    }
  }

  throw new Error(`No credential succeeded.\n${errors.join("\n")}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
