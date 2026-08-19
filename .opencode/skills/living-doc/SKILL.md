---
name: living-doc
description: Answer an evolving line of questions by maintaining ONE markdown file that gets rewritten each turn, instead of emitting new explanation into the chat. Use when the user wants a codebase, system, or topic explained across many follow-up questions, says things like 边问边更新文档 / keep the doc updated / don't repeat yourself in chat / 把讲解写进文件, or when a chat explanation is already drifting through corrections and re-explanations and the answer should live somewhere stable instead of scrolling away.
---

Understanding something takes many turns. Chat is append-only, so each turn buries
the last and the user loses the stable reference. Move the answer into a file the
agent keeps rewriting, and keep the terminal for change summaries only.

## Goal

- One file holds the current best understanding. It is always complete and self-consistent.
- Corrections overwrite the wrong section — they never appear as a chat erratum.
- The terminal shows only what changed and where, never the content itself.

## Instructions

### Starting

1. Confirm or pick the doc path. Default `./NOTES-<topic>.md` in the working
   directory, or ask if the user has a place for it.
2. Investigate, then write the first full version.
3. Tell the user the path and suggest opening it with live preview beside the terminal.

### Every following turn

1. **Read the doc first.** Never answer from conversation memory alone — the doc is
   the state, the chat is not.
2. Investigate what the question needs.
3. **Edit the doc.** New facts go into the section they belong to. A correction
   replaces the wrong text — delete it, don't annotate it. Remove anything
   superseded; the doc must not accumulate an audit trail of its own edits.
4. **Reply in the terminal with a change summary only** — which sections changed and
   in one line what changed. No re-explanation, no restating the content. Two to four
   lines total.

If a question turns out not to belong in the doc (a one-off shell command, a
side tangent), answer it inline and say you left the doc alone.

## Doc structure

Structure for repeated overwriting, not for reading top to bottom once:

- Stable `##` section headings so a section can be replaced wholesale and referenced
  by name in the change summary. Keep headings stable across turns; renaming one
  breaks the user's scroll position and your own summaries.
- Lead with a short **Overview** — what this thing is, in a few sentences.
- Then one section per subsystem/concern, each independently rewritable.
- An **Open questions** section for things not yet verified. Move items out of it as
  they get resolved rather than leaving them answered-in-place.
- Cite `file.ts:42` style references for anything drawn from code, so claims stay
  checkable and stale ones are easy to spot.

Only add sections the material actually needs; an empty scaffold is worse than none.

## Output

Terminal reply shape:

```text
更新: ## Auth flow（改正 token 刷新时机）、## Open questions（去掉 2 条）
```

Nothing else unless the user asks a direct question that has no place in the doc.

## Notes

- If the doc is in a git repo, the user can read each turn's delta with `git diff` —
  mention it once, then leave it alone.
- Do not create sibling files, changelogs, or version history. One file.
