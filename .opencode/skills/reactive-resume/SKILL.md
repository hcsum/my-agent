---
name: reactive-resume
description: Render Haochen's full-stack resume to a styled PDF via the local Reactive Resume repo (structured JSON + template library), for template/style variety that the markdown-based resume-pdf skill can't do easily. Use when the user wants a differently-styled or two-column/sidebar/colored resume, wants to switch or compare Reactive Resume templates (onyx, pikachu, gengar, azurill, …), tweak colors/fonts/margins/section-to-column layout, or re-export the fullstack JSON/PDF. For plain markdown resumes, bilingual EN+CN, or CJK-heavy output, use resume-pdf instead.
---

Render the full-stack resume through the local Reactive Resume renderer. The resume content and all styling live as a structured `ResumeData` object built inside a Vitest runner; the renderer turns it into a PDF. Styling is data-driven — switching template or colors is a metadata change, not a code rewrite.

## When to use vs resume-pdf

- **reactive-resume (this skill):** styled/two-column/sidebar/colored layouts, template switching, design experiments. Input is structured JSON; hard to hand-edit, trivial to restyle.
- **resume-pdf:** markdown source of truth, easy content edits, bilingual EN+CN, reliable CJK glyph embedding. Reactive Resume's CJK font embedding is unverified — do not use it for Chinese resumes.

The two pipelines are independent. Editing the markdown resume never updates the Reactive Resume JSON/PDF, and vice versa.

## Layout of the pipeline

- Repo: `~/Codes/reactive-resume` (clone of Reactive Resume).
- Canonical runner: `packages/pdf/src/gen-resume.test.tsx` — builds `data` (basics, summary, experience, projects, education, skills, languages, metadata), validates with `resumeDataSchema.parse(data)`, renders via `createResumePdfFile(...)` from `./server.tsx`.
- Output constants at the bottom of the runner (`OUT_JSON` / `OUT_PDF`):
  - `notes/my-files/resume/haochen-xu-resume-fullstack.json`
  - `notes/my-files/resume/haochen-xu-resume-fullstack.pdf`
- Vitest config: `gen.vitest.config.ts` (required — adds the JSX/oxc override; the default config errors on `document.tsx`).

## Run

```bash
export PATH="$HOME/.nvm/versions/node/v22.13.1/bin:$PATH"   # Node ≥ 22.13; system 22.12 fails pnpm engine check
cd ~/Codes/reactive-resume/packages/pdf
node ../../node_modules/vitest/vitest.mjs run --config gen.vitest.config.ts src/gen-resume.test.tsx
```

The runner prints the JSON and PDF paths plus byte size.

## Editing content

Edit the `data.*` blocks in `gen-resume.test.tsx`:

- `data.basics` — name, headline, email, phone, location, website, `customFields` (LinkedIn/GitHub with `icon` + `link`).
- `data.summary.content` — HTML string (`<p>…</p>`).
- `data.sections.experience.items` — each `{ id: id(), company, position, date, location, website:{url,label}, summary: "<ul>…</ul>" }`.
- `data.sections.projects.items` / `education.items` / `skills.items` / `languages.items` — same pattern; skills carry `keywords[]`, languages carry `fluency`/`level`.
- `id()` is `randomUUID()`; give every item a fresh id.

## Restyling (data-driven — no template code changes)

All styling is fields under `data.metadata`:

- `data.metadata.template` — pick one of the 15 built-in templates: `azurill, bronzor, chikorita, ditgar, ditto, gengar, glalie, kakuna, lapras, leafish, meowth, onyx, pikachu, rhyhorn, scizor`. Current: `onyx`.
- `data.metadata.layout.pages[].main` / `.sidebar` — which sections go in the main column vs the sidebar; `sidebarWidth` sets the split.
- `data.metadata.design.colors.primary` / `.text` / `.background`.
- `data.metadata.typography.body` / `.heading` — `fontFamily`, `fontSize`, `fontWeights`, `lineHeight`. `Helvetica` is the safe built-in; other fonts must be available to the renderer or glyphs fall back/drop (CJK especially).
- `data.metadata.page` — `format` (A4), `marginX/Y`, `gapX/Y`, `hideIcons`, `hideSectionIcons`.

To switch the canonical output to a template, change the single `data.metadata.template` line and re-run.

## Comparing templates (throwaway variants)

To render several templates without touching the canonical runner, add a sibling test that reads the already-generated JSON, overrides `metadata.template`, and writes to a temp dir:

```tsx
// packages/pdf/src/gen-resume-compare.test.tsx
import { readFile, writeFile } from "node:fs/promises";
import { it } from "vitest";
import { resumeDataSchema } from "@reactive-resume/schema/resume/data";
import { createResumePdfFile } from "./server.tsx";

const SRC = "/Users/sum/Codes/opencode-agent/notes/my-files/resume/haochen-xu-resume-fullstack.json";
const OUT = "<scratchpad dir>";
const TEMPLATES = ["pikachu", "gengar", "azurill"] as const;

it("compare templates", async () => {
  const base = JSON.parse(await readFile(SRC, "utf8"));
  for (const template of TEMPLATES) {
    const data = structuredClone(base); data.metadata.template = template;
    const file = await createResumePdfFile({ data: resumeDataSchema.parse(data), filename: `resume-${template}.pdf` });
    await writeFile(`${OUT}/resume-${template}.pdf`, Buffer.from(await file.arrayBuffer()));
  }
});
```

Run it the same way (swap the filename in the command). Delete it when done — keep only the canonical runner committed.

## Verify before delivering

Always look at the rendered pages, don't trust a green test:

```bash
pdftoppm -png -r 90 <output.pdf> /tmp/pg   # then read /tmp/pg-N.png
```

Check page count (target 2 pages for the fullstack resume), clean breaks, and that colored/sidebar templates still read well. Large-color-block templates (e.g. gengar) can parse worse in ATS and print heavier than clean ones (onyx, azurill) — prefer clean templates for real applications, flashy ones for display.
