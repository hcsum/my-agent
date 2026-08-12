---
name: brain-dump
description: Save user-facing notes to notes/brain-dump/ for the user to reread later — not agent-facing memory. Use when the user says mark down / 存下来 / 记一下 / jot, especially to save a reply, decision, itinerary, research trail, snippet, or current-context note. Preserve verbatim only when the user explicitly asks for exact text; otherwise include enough surrounding context for future rereading. For facts the agent itself needs across sessions, use `remember` instead.
---

Save user-facing notes to `notes/brain-dump/` — one note per file, written so the user can understand it later without the current chat.

## Goal

- Preserve what the user wants kept in a form that will be useful when reread later.
- Include necessary context from the current conversation when the saved item is a decision, plan, itinerary, recommendation, or researched result.
- Keep this destination distinct from `notes/memory/` (the `remember` skill): brain-dump is for the user to reread; memory is for the agent's own operational context.

## Instructions

- If the user explicitly asks to save exact wording, quoted text, pasted material, a snippet, or says "verbatim / 原文 / 逐字", save the source text exactly.
- If the user asks to save a plan, decision, itinerary, answer, research result, or "this" from the surrounding conversation, create a self-contained note with the relevant context, conclusions, constraints, sources/links if available, and follow-up cautions.
- Do not invent details. Use only information already present in the conversation or source material.
- Keep the note concise but complete enough that the user can reconstruct the intent later.
- One note per file under `notes/brain-dump/`, unless the user names a different destination file.
- Pick a short, descriptive kebab-case filename if none is given.
- A bare "save" with no further transform verb defaults here; decide between exact save and contextual note from what the user is pointing at.
- If the user also asked to summarize or analyze first ("summarize this and save it"), run the `summarization` skill first, then save that output as the note.

## Output

- Report the file path saved to.
