import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Build a deduped backlink-candidate list from a competitor's Semrush backlinks
// export. For each referring domain NOT already in notes/projects/site-backlinks/backlink-master.csv,
// emit one row with the domain's authority score and a representative live link
// (Source url + follow status) as a worked example of how that domain hosts
// an outbound link. `difficulty` is left blank for the agent to triage
// (easy / hard) — see SKILL.md. Two dimensions: value is a *gate* (worthless
// rows never enter the CSV), difficulty is the *column* (easy vs hard).
//
// High-confidence junk (programmatic report/stat/share/listing pages keyed off
// an id) is auto-dropped by the value gate below and reported in `dropped_junk`;
// the agent removes any remaining worthless rows during triage.
//
// Usage:
//   npx tsx competitor-candidates.ts <competitor-substring>
//   e.g. npx tsx competitor-candidates.ts polybuzz
// Finds the newest "<sub>*-backlinks.csv" and "<sub>*refdomains.csv" in
// ~/Downloads (falls back to notes/projects/site-backlinks). Writes
// notes/projects/site-backlinks/backlink-candidates-<competitor>.csv, preserving any `difficulty`
// values already filled in a prior run.

const DOWNLOADS = path.join(os.homedir(), "Downloads");
const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../../..");
const MASTER = path.join(REPO, "notes/projects/site-backlinks/backlink-master.csv");
const SITE_BACKLINKS = path.join(REPO, "notes/projects/site-backlinks");

function fail(msg: string): never {
  console.error(msg);
  (globalThis as any).process.exit(1);
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else inQuotes = false;
      } else cell += c;
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ",") {
        row.push(cell);
        cell = "";
      } else if (c === "\n") {
        row.push(cell);
        rows.push(row);
        row = [];
        cell = "";
      } else if (c === "\r") {
        // skip
      } else cell += c;
    }
  }
  if (cell.length || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

function formatCsv(rows: string[][]): string {
  const esc = (v: string) => (/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return rows.map((r) => r.map(esc).join(",")).join("\n") + "\n";
}

function readCsv(file: string): { header: string[]; rows: string[][] } {
  const parsed = parseCsv(fs.readFileSync(file, "utf8")).filter((r) => r.some((c) => c !== ""));
  if (!parsed.length) fail(`Empty CSV: ${file}`);
  return { header: parsed[0], rows: parsed.slice(1) };
}

function col(header: string[], name: string): number {
  const i = header.indexOf(name);
  if (i === -1) fail(`Column "${name}" missing from header: ${header.join(", ")}`);
  return i;
}

function normDomain(host: string): string {
  return host.toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
}

// Value gate: high-confidence worthless targets that should never enter the CSV.
// Conservative on purpose — only mechanical, programmatically-generated link
// surfaces (nothing to submit) and blatant PBN/SEO-spam. Judgment calls
// (editorial blogs, off-topic-but-real sites) are left to the agent's triage.
function isJunk(domain: string, url: string): boolean {
  const d = domain.toLowerCase();
  const u = url.toLowerCase();
  // Programmatic report/stat/share/listing pages keyed off an opaque id.
  if (/\/(report|stats|share|view|domain)\/[\w%-]*\d/.test(u)) return true;
  if (/list\.php\?part=/.test(u)) return true;
  if (/\/all\/\d+\/\d+/.test(u)) return true;
  // Blatant PBN / paid-backlink / SEO-spam domains.
  if (/(^|[.-])(fiverr-|seo-|seogeko)|-seo-|links\.agency|buy.*backlink/.test(d)) return true;
  return false;
}

function hostOf(url: string): string {
  try {
    return normDomain(new URL(url).hostname);
  } catch {
    const m = url.replace(/^[a-z]+:\/\//i, "").split(/[/?#]/)[0];
    return normDomain(m);
  }
}

function newest(dir: string, includes: string[], excludes: string[] = []): string | null {
  if (!fs.existsSync(dir)) return null;
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith(".csv"))
    .filter((f) => includes.every((s) => f.toLowerCase().includes(s.toLowerCase())))
    .filter((f) => excludes.every((s) => !f.toLowerCase().includes(s.toLowerCase())))
    .map((f) => ({ f: path.join(dir, f), m: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.m - a.m);
  return files.length ? files[0].f : null;
}

function findInput(sub: string, includes: string[], excludes: string[] = []): string | null {
  return newest(DOWNLOADS, [sub, ...includes], excludes) ?? newest(SITE_BACKLINKS, [sub, ...includes], excludes);
}

type Rep = {
  example: string;
  dofollow: boolean;
  hasDofollow: boolean;
};

function main() {
  const argv = (globalThis as any).process.argv.slice(2) as string[];
  const sub = argv.find((a) => !a.startsWith("--"));
  if (!sub) fail("Usage: competitor-candidates.ts <competitor-substring>  (e.g. polybuzz)");

  const backlinksFile = findInput(sub, ["-backlinks"], ["refdomains"]);
  if (!backlinksFile) fail(`No "*${sub}*-backlinks.csv" found in Downloads or site-backlinks.`);
  const refdomainsFile = findInput(sub, ["refdomains"]);

  const base = path.basename(backlinksFile).toLowerCase();
  const competitor = base.replace(/-backlinks.*$/, "").replace(/\.csv$/, "") || sub;

  const master = readCsv(MASTER);
  const wIdx = col(master.header, "website");
  const masterSet = new Set(master.rows.map((r) => normDomain((r[wIdx] ?? "").trim())).filter(Boolean));

  const domainAscore = new Map<string, number>();
  const refOrder: string[] = [];
  if (refdomainsFile) {
    const ref = readCsv(refdomainsFile);
    const dIdx = col(ref.header, "Domain");
    const asIdx = col(ref.header, "Domain ascore");
    for (const r of ref.rows) {
      const d = normDomain((r[dIdx] ?? "").trim());
      if (!d) continue;
      if (!domainAscore.has(d)) {
        domainAscore.set(d, parseInt(r[asIdx]) || 0);
        refOrder.push(d);
      }
    }
  }

  const bl = readCsv(backlinksFile);
  const sUrl = col(bl.header, "Source url");
  const noffI = col(bl.header, "Nofollow");
  const ascoreI = col(bl.header, "Page ascore");
  const lastI = col(bl.header, "Last seen");

  const refSet = new Set(refOrder);
  function toRegistrable(host: string): string {
    if (refSet.has(host)) return host;
    const labels = host.split(".");
    for (let i = 1; i < labels.length - 1; i++) {
      const cand = labels.slice(i).join(".");
      if (refSet.has(cand)) return cand;
    }
    return host;
  }

  const reps = new Map<string, Rep>();
  for (const r of bl.rows) {
    const url = (r[sUrl] ?? "").trim();
    if (!url) continue;
    const domain = refOrder.length ? toRegistrable(hostOf(url)) : hostOf(url);
    if (!domain || masterSet.has(domain)) continue;

    const dofollow = (r[noffI] ?? "").trim().toLowerCase() !== "true";
    const ascore = parseInt(r[ascoreI]) || 0;
    const last = (r[lastI] ?? "").trim();
    const prev = reps.get(domain);
    if (!prev) {
      const rep: Rep = {
        example: url,
        dofollow,
        hasDofollow: dofollow,
      };
      (rep as any)._as = ascore;
      (rep as any)._last = last;
      reps.set(domain, rep);
      continue;
    }
    prev.hasDofollow = prev.hasDofollow || dofollow;
    const prevDofollow = prev.dofollow;
    const better =
      (dofollow && !prevDofollow) ||
      (dofollow === prevDofollow && ascore > (prev as any)._as) ||
      (dofollow === prevDofollow && ascore === (prev as any)._as && last > ((prev as any)._last ?? ""));
    if (better) {
      prev.example = url;
      prev.dofollow = dofollow;
    }
    (prev as any)._as = Math.max((prev as any)._as ?? 0, ascore);
    (prev as any)._last = last > ((prev as any)._last ?? "") ? last : (prev as any)._last;
  }

  const candidates = new Set<string>();
  const droppedJunk: string[] = [];
  for (const d of reps.keys()) {
    if (masterSet.has(d)) continue;
    if (isJunk(d, reps.get(d)!.example)) {
      droppedJunk.push(d);
      continue;
    }
    candidates.add(d);
  }
  const refOnlyNew = refOrder.filter((d) => !masterSet.has(d) && !reps.has(d)).length;

  const outFile = path.join(REPO, "notes/projects/site-backlinks", `backlink-candidates-${competitor}.csv`);
  // Preserve prior triage. Accept the legacy `doable` header too so old
  // candidate files migrate cleanly on re-run.
  const priorDifficulty = new Map<string, string>();
  if (fs.existsSync(outFile)) {
    const prior = readCsv(outFile);
    const pw = prior.header.indexOf("website");
    const pd = prior.header.indexOf("difficulty") !== -1 ? prior.header.indexOf("difficulty") : prior.header.indexOf("doable");
    if (pw !== -1 && pd !== -1) {
      for (const r of prior.rows) {
        const d = normDomain((r[pw] ?? "").trim());
        const v = (r[pd] ?? "").trim();
        if (d && v) priorDifficulty.set(d, v);
      }
    }
  }

  const header = ["website", "difficulty", "AS", "example_source", "dofollow"];
  const out: string[][] = [...candidates]
    .map((d) => {
      const rep = reps.get(d);
      const as = domainAscore.get(d) ?? (rep ? (rep as any)._as ?? 0 : 0);
      return {
        d,
        as: Number(as) || 0,
        row: [
          d,
          priorDifficulty.get(d) ?? "",
          String(Number(as) || 0),
          rep?.example ?? "",
          rep ? (rep.dofollow ? "true" : "false") : "",
        ],
      };
    })
    .sort((a, b) => b.as - a.as || a.d.localeCompare(b.d))
    .map((x) => x.row);

  fs.writeFileSync(outFile, formatCsv([header, ...out]));

  const dofollowCount = out.filter((r) => r[4] === "true").length;
  console.log(
    JSON.stringify(
      {
        competitor,
        backlinksFile,
        refdomainsFile: refdomainsFile ?? null,
        refdomains_total: refOrder.length || null,
        master_domains: masterSet.size,
        already_in_master: refOrder.length ? refOrder.filter((d) => masterSet.has(d)).length : null,
        new_candidates_with_example: out.length,
        dofollow_examples: dofollowCount,
        dropped_junk: droppedJunk.length,
        dropped_junk_domains: droppedJunk.length ? droppedJunk : null,
        refdomains_new_but_no_example_in_export: refOnlyNew || null,
        preserved_difficulty: priorDifficulty.size,
        written: outFile,
      },
      null,
      2,
    ),
  );
}

main();
