---
name: check-keyword
description: Check the SEO potential of a keyword by gathering data from various tools and sources, and write the findings into a keyword research file under notes/projects/research/.
---

## Objective

Research the SEO potential of a given keyword (or a tight cluster of closely related keywords — same core intent, would share one landing page/strategy) and write the findings into a markdown file under `notes/projects/research/` in the `notes` repo.

Reuse the existing file for a keyword or cluster if one already exists; otherwise create a new one, named `<keyword-or-cluster-slug>-research.md` (e.g. `ai-life-coach-research.md` for a single keyword, `visual-novel-story-game-research.md` for a cluster). Only group keywords that genuinely belong together; when in doubt, use separate files. NEVER delete or modify the research file for a different keyword or cluster — only create a new file or update the one for the current keyword(s).

## Tools to use

- Semrush: see search volume, keyword difficulty, CPC, related keywords etc.
- Ahrefs: check keyword difficulty for cross-checking with Semrush
- Google trends: see trends and related queries
- Search on X: sentiment analysis and community insights, pain points, use cases, etc.
- Search on Reddit: sentiment analysis and community insights, pain points, use cases, etc.
- Inspect SERP: understand search intent and competition

## Required fields

For each keyword, research and record:

- Semrush KD
- Ahrefs KD
- Ahrefs backlinks required (for top 10)
- Search volume (global)
- Search volume (region, e.g. US)
- CPC
- KD ROI, if computable
- KGR, if computable
- SERP summary — what's ranking, page types, competition characterization
- Rising queries
- Top / related queries
- Sentiment & verdict — community signal plus a clear recommendation (attractive / beatable / niche-only / avoid) and why

If a field can't be found (e.g. not exposed by a free tier), leave it blank rather than fabricating a number.

## Output format

Match the format already established in `notes/projects/research/` (see `ai-life-coach-research.md` for a single keyword, or `visual-novel-story-game-research.md` / `is-the-one-relationship-research.md` for a cluster). Each file should include:

- a short header naming the keyword(s) and when/why the data was gathered
- a data table covering the required fields above, one row per keyword
- a SERP summary/notes section per keyword when the SERP was inspected
- a top/rising queries line
- a closing verdict section with a clear recommendation
