---
name: backlink-prospecting
description: Build and triage backlink targets from competitor exports before any live submission work starts. Use when the task is to parse Semrush exports, generate `backlink-candidates-<competitor>.csv`, dedup against the backlink master, triage candidates by value, or promote keepers into `backlink-master.json`. Not for registering on target sites, filling forms, posting content, or placing live backlinks; use `backlink-execution` for that.
---

This skill owns backlink target generation and triage after raw exports exist.

## Where The Data Lives

```
~/Downloads/<competitor>-backlinks.csv          raw Semrush export
  ↓  competitor-candidates.ts                   dedup + value gate
notes/projects/site-backlinks/backlink-candidates-<competitor>.csv   ← staging, you triage here
  ↓  promote-candidates.mjs                     append keepers
notes/projects/site-backlinks/backlink-master.json                   ← source of truth
  ↓  build-board.mjs
notes/projects/site-backlinks/backlink-board.html                    ← what the user opens
```

The master is **JSON**, not CSV (`backlink-master.export.csv` is a generated inspection view — never read it as truth, never write to it). The candidates file stays CSV on purpose: it is a disposable scratch sheet you triage row by row, then throw away.

## Prerequisite

- If you still need the Semrush page or CSV export, load `use-semrush` first.
- Prefer exporting both reports for the same competitor: `Backlinks` and `Referring Domains`.
- Keep the raw CSV exactly as downloaded. Do not trim columns before processing.
- Prefer the `Backlinks` report over `Referring Domains` when you need a worked example source page.

## Step 1 — Generate Candidates

```bash
npx tsx .opencode/skills/backlink-prospecting/scripts/competitor-candidates.ts <competitor-substring>
```

What it does:

- reads the newest `<sub>*-backlinks.csv` plus matching `*refdomains*.csv` from `~/Downloads` and falls back to `notes`
- drops every referring domain already in `backlink-master.json` (registrable-domain dedup; falls back to the export CSV only if the JSON is missing)
- picks one representative live link per new domain, preferring dofollow and then higher page authority
- writes `backlink-candidates-<competitor>.csv` sorted by `AS` descending
- preserves any existing `difficulty` values if the candidates file already exists
- auto-drops high-confidence junk (programmatic report/stat/share/listing pages, blatant PBN/SEO-spam) via a value gate and reports it as `dropped_junk`

Output columns: `website, difficulty, AS, example_source, dofollow`.

`dofollow` here is **the competitor's link, from Semrush** — a hint about the site, not a verified property of our future placement. It never becomes `link.rel` in the master; only `backlink-execution` writes that, after checking a real page in a browser.

## Step 2 — Triage: The Value Gate

Triage is now **one dimension: is this row worth keeping at all?**

A row is either worth keeping or it is not. **Worthless rows do not belong in the candidates file** — delete them outright; never keep a worthless row with a low rating. Everything that survives is, by definition, worth considering. The script already auto-drops the most mechanical junk; delete the rest by hand:

- auto-generated scraper/stat/report pages — nothing to submit. Tells: the example URL is a programmatic listing keyed off the competitor (`/report/<id>`, `/stats/<id>`, `/share/<id>`, `/domain/.../part/<id>`, `list.php?part=`, `/all/<n>/<n>`, recurring opaque hash slugs across many domains).
- PBN / SEO-spam / paid-backlink domains (`fiverr-*`, `*-seo-*.shop`, `*links.agency`, "buy backlinks" copy), junk TLDs used at scale for stat mirrors (`.top`, `.sbs`, `.cfd`, `.icu`).
- **downstream auto-mirrors** — a cluster of domains that are just copies of one upstream source (dozens of FMHY wiki mirrors, Homebrew-cask aggregators, GitHub-trending aggregators). These are not separately placeable: you act once upstream and the cluster propagates. Keep **one** representative of the upstream surface and drop the mirrors. Note the "place once → propagates" fact where it's a useful lesson, but don't list every mirror as a target.
- **free-blog farms** — sites handing out a free subdomain behind a SecureImg/KeyCAPTCHA-style signup (`*blog.com` / `*blogs.com` clusters sharing one WordPress stack). They look like ideal easy targets and are the single worst use of time in this pipeline: a 2026-07-19 audit found nine of them banned or wiped at once, destroying ~18 recorded placements. One shared stack across several domains is the tell — check `note` on any sibling already in the master.

A competitor export dominated by the above means few real targets — that is expected. Don't force keepers.

**The old `difficulty` column is gone from the master schema.** Leave it blank, or use it as a scratch note to yourself during triage (`easy` / `hard`) — `promote-candidates.mjs` folds whatever is there into the site's `note` prose and nothing more. Effort is no longer a structured field: `decision.status` answers do-we-do-it, and `type.primary` (`blog_comment`, `startup_directory`, `review_site`, …) already implies the effort. Do not try to reintroduce a difficulty field.

`rejected` entries in the master are the third thing you must respect but never assign: they mark sites already tried and ruled out. Dedup keeps them out of new candidate files — that is the whole reason rejected sites stay in the master instead of being deleted. Never resurrect one into a candidates file.

## Step 3 — Promote Keepers

```bash
node .opencode/skills/backlink-execution/scripts/promote-candidates.mjs <competitor> --dry   # preview
node .opencode/skills/backlink-execution/scripts/promote-candidates.mjs <competitor>         # write + rebuild board
```

Run it **only after triage** — it promotes every remaining row, so a un-triaged file dumps hundreds of junk domains into the master.

Each promoted domain lands as:

```jsonc
{ "website": "...", "decision": { "status": "needs_review", "reason": "From <competitor> backlink export; link value not verified yet.", "decided_at": "..." },
  "type": { "primary": "unknown" }, "pricing": { "model": "unknown" },
  "link": {}, "authority": { "as": 52 }, "gsc": {}, "placements": [],
  "example_source": "https://...", "note": "triage ...: hard · competitor link was dofollow (Semrush, unverified)" }
```

Note what is deliberately left **empty**, and why:

- `link.rel` / `link.robots` — these record an observed `rel` and robots meta on a real page. They can only be filled after execution checks one, never guessed at triage. An unverified `link.rel` would silently promote the domain into the user's 保底名单.
- `placements[]` — `backlink-execution` and the user's dashboard own this.
- `decision.status: needs_review` — not `active`. `active` means vetted, and nothing has been vetted yet.

The script skips domains already in the master and regenerates the board itself. If you ever add entries by hand instead, match its shape exactly and finish with `node .opencode/skills/backlink-execution/scripts/build-board.mjs` — the board never updates on its own.

## Handoff To Execution

- This skill stops at generation, dedup, value triage, and promotion into the master as `needs_review`.
- Once the user decides a target should be worked, load `backlink-execution` for the site-by-site submission flow, link verification, and the write-back.
- Never set `decision.status: "active"`, `link.*`, or any placement from this skill.

## Caveats

- The script expects the full Semrush export with columns such as `Source url`, `Nofollow`, `Page ascore`, and `Last seen`.
- Semrush caps large per-link exports, so some refdomains may exist in the domain-level export but never appear in the emitted candidates file.
- Semrush is a lead source, not a conclusion: a 2026-07-19 same-project comparison found it missed 6 domains GSC confirmed while inventing 35 spam ones GSC never saw.
