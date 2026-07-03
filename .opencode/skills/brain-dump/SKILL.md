---
name: brain-dump
description: Save content verbatim to notes/brain-dump/ for the user to reread later — not a summary, not agent-facing memory. Use when the user says mark down / 存下来 / 记一下 / jot, especially to save a reply you just gave, an article excerpt, or a snippet exactly as-is. This is user-facing: the reader is the user coming back to it later. For a fact the *agent itself* needs to carry into future sessions, use the `remember` skill instead, not this one.
---

Save content verbatim to `notes/brain-dump/` — one note per file, no paraphrase, no restructuring, no summarizing.

## Goal

- Preserve exactly what the user wants kept, in its original words.
- Keep this destination distinct from `notes/memory/` (the `remember` skill): brain-dump is for the user to reread; memory is for the agent's own operational context.

## Instructions

- Save the source text **verbatim** — copy, don't regenerate. No paraphrase, condense, or restructure.
- One note per file under `notes/brain-dump/`, unless the user names a different destination file.
- Pick a short, descriptive kebab-case filename if none is given.
- A bare "save" with no further transform verb defaults here.
- If the user also asked to summarize or analyze first ("summarize this and save it"), run the `summarization` skill first, then copy *that* output verbatim here — don't summarize inside this skill.

## Output

- Report the file path saved to.
