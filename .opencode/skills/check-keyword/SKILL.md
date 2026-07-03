---
name: check-keyword
description: Check the SEO potential of a keyword by gathering data from various tools and sources, and record the findings in the notes repo.
---

## Objective

Research the SEO potential of a given keyword (or a tight cluster of closely related keywords — same core intent, would share one landing page/strategy) and record the findings in the `notes` repo.

Look at how existing keyword/SEO research is organized there and follow the same convention: reuse the existing file for a keyword or cluster if one already exists, otherwise create a new one in a sensible location alongside it. Only group keywords into one file when they genuinely belong together; when in doubt, use separate files. NEVER delete or modify the research for a different keyword or cluster — only create a new file or update the one for the current keyword(s).

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

Match the format of existing keyword research files you find in the notes repo. Each file should include:

- a short header naming the keyword(s) and when/why the data was gathered
- a data table covering the required fields above, one row per keyword
- a SERP summary/notes section per keyword when the SERP was inspected
- a top/rising queries line
- a closing verdict section with a clear recommendation
