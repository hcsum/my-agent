---
name: backlink-prospecting
description: Build and triage backlink targets from competitor exports before any live submission work starts. Use when the task is to parse Semrush exports, generate `backlink-candidates-<competitor>.csv`, dedup against `backlink-master.csv`, rate `difficulty`, or maintain target CSVs. Not for registering on target sites, filling forms, posting content, or placing live backlinks; use `backlink-execution` for that.
---

This skill owns backlink target generation and triage after raw exports exist.

## Prerequisite

- If you still need the Semrush page or CSV export, load `use-semrush` first.
- Prefer exporting both reports for the same competitor: `Backlinks` and `Referring Domains`.
- Keep the raw CSV exactly as downloaded. Do not trim columns before processing.
- Prefer the `Backlinks` report over `Referring Domains` when you need a worked example source page.

## Generate Candidates

Run:

```bash
npx tsx .opencode/skills/backlink-prospecting/scripts/competitor-candidates.ts <competitor-substring>
```

What it does:

- reads the newest `<sub>*-backlinks.csv` plus matching `*refdomains*.csv` from `~/Downloads` and falls back to `notes`
- drops every referring domain already present in `notes/projects/site-backlinks/backlink-master.csv` using registrable-domain dedup
- picks one representative live link per new domain, preferring dofollow and then higher page authority
- writes `notes/projects/site-backlinks/backlink-candidates-<competitor>.csv` sorted by `AS` descending
- preserves any existing `difficulty` values if the candidates file already exists
- auto-drops high-confidence junk (programmatic report/stat/share/listing pages, blatant PBN/SEO-spam) via a value gate and reports it as `dropped_junk`

Output columns:

- `website, difficulty, AS, example_source, dofollow`

## Triage Rules

Triage runs on **two orthogonal dimensions**. Don't collapse them:

### 1. Value — an entry *gate*, not a column

A row is either worth keeping or it is not. **Worthless rows do not belong in the CSV** — delete them outright; never keep a worthless row with some low rating. Everything that stays in the CSV is, by definition, valuable enough to consider. The script already auto-drops the most mechanical junk; during triage, delete any remaining worthless rows:

- auto-generated scraper/stat/report pages — nothing to submit. Tells: example URL is a programmatic listing keyed off the competitor (`/report/<id>`, `/stats/<id>`, `/share/<id>`, `/domain/.../part/<id>`, `list.php?part=`, `/all/<n>/<n>`, recurring opaque hash slugs across many domains).
- PBN / SEO-spam / paid-backlink domains (`fiverr-*`, `*-seo-*.shop`, `*links.agency`, "buy backlinks" copy), junk TLDs used at scale for stat mirrors (`.top`, `.sbs`, `.cfd`, `.icu`).
- **downstream auto-mirrors** — a whole cluster of domains that are just copies of one upstream source (e.g. dozens of FMHY wiki mirrors, Homebrew-cask mirror/aggregators, GitHub-trending aggregators). These are not separately placeable: you act once upstream and the cluster propagates. Keep **one** representative of the upstream surface (e.g. `fmhy.net`, the Homebrew cask PR, the awesome-list) and drop the mirrors. Note the "place once → propagates" fact where it's a useful lesson, but don't list every mirror as a target.

A competitor export dominated by the above means few real targets — that is expected. Don't force keepers.

### 2. Difficulty — the `difficulty` column, on kept rows

`difficulty` is **site-level and project-agnostic**: how hard it is to actually get a link out of this site. It never holds a per-project outcome like `done` / `reviewing` / `parked` — those live in the per-project columns owned by `backlink-execution`. Allowed values:

- `easy` — low-friction, largely self-serve: blog comments, directory / navigation-site submissions, GitBook/docs-style PR links, guestbooks, open profile fields — the kind of surface the agent can usually place on its own.
- `hard` — **the default** for any valuable-but-non-trivial target: editorial pitch, registration + moderation, captcha/interaction on submit, an outreach email. Example: `free.com.tw` (an editorial free-software blog — real link, but you have to pitch a human).

When unsure, default to `hard`. Difficulty rates effort, not link quality — do not downgrade a keeper because the link is nofollow or off-topic.

**Free-blog farms are a value-gate rejection, not an `easy` keeper.** Sites handing out a free subdomain behind a SecureImg/KeyCAPTCHA-style signup (`*blog.com`, `*blogs.com` clusters sharing one WordPress stack) look like ideal `easy` targets and are the single worst use of time in this pipeline: a 2026-07-19 audit found nine of them banned or wiped at once, destroying ~18 recorded placements. Drop them at triage. One shared stack across several domains is the tell — check `note` on any sibling already in the master file.

`dead` is a third value you never assign but must respect: it marks a site already tried and ruled out (no link surface, or the user judged it not worth the money). Dedup keeps those rows out of new candidate lists — that is the whole reason rejected sites stay in `backlink-master.csv` instead of being deleted. Never resurrect a `dead` row into a candidates file.

## Handoff To Execution

- This skill stops at target generation, dedup, and value/difficulty triage.
- Once you decide a target should be worked, load `backlink-execution` for the site-by-site submission flow.
- Keep `difficulty` focused on how hard the placement is, not whether you have already completed it.

## Promote Keepers

- Triage row by row in `backlink-candidates-<competitor>.csv`: delete worthless rows (value gate), then set `difficulty` (`easy` / `hard`) on the rest.
- Promote only the keepers into `backlink-master.csv` so future runs dedup correctly. Each project there owns a **status + `_detail` column pair**; leave both empty on a newly promoted row — `backlink-execution` fills them. Also leave `follow` empty: it records an observed `rel` on a live page, so it can only be filled after execution, never guessed at triage.
- After promoting, regenerate the user's view: `node .opencode/skills/backlink-execution/scripts/build-board.mjs`.
- Re-running the script is safe; it preserves prior `difficulty` decisions already written in the candidates file (and migrates a legacy `doable` column).

## Caveats

- The script expects the full Semrush export with columns such as `Source url`, `Nofollow`, `Page ascore`, and `Last seen`.
- Semrush caps large per-link exports, so some refdomains may exist in the domain-level export but never appear in the emitted candidates file.
