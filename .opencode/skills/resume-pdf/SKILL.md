---
name: resume-pdf
description: Author a resume as markdown and render it to a print-quality, ATS-parseable PDF via WeasyPrint. Use whenever the user wants a resume built, tailored to a job, updated, or exported/re-exported to PDF, or says 导出简历 / 简历转 PDF / 重新导出 / 生成 PDF. Also use for any markdown document that must become a paginated PDF with correct Chinese/CJK text, since headless Chrome silently drops CJK glyphs. Covers bilingual (EN + CN) layouts, page-count control, and post-export verification.
---

Keep the resume in markdown as the single source of truth, and render it to PDF with one command. The markdown is what gets edited and reviewed; the PDF is a build artifact that is regenerated, never hand-edited.

## Goal

- One markdown file per resume variant; PDF regenerated from it on demand.
- Text-based PDF (real embedded fonts), so ATS parsers can extract the content.
- Correct CJK rendering in bilingual resumes.
- Predictable page count and clean page breaks.

## Render

```bash
node .opencode/skills/resume-pdf/scripts/md2pdf.mjs <input.md> [output.pdf] [--density tight|normal|loose]
```

Defaults to `<input>.pdf` next to the source. The script prints the output path and page count.

Dependencies (check once, install if missing):

- `weasyprint` — `brew install weasyprint`
- `poppler` — `brew install poppler` (provides `pdfinfo` / `pdftoppm`, used for verification)
- `marked` — resolved from local or global `node_modules`; `npm i -D marked` if the script reports it missing

## Hard rules

**Always render with WeasyPrint. Never use headless Chrome `--print-to-pdf` for anything containing Chinese.** Chrome on macOS embeds CJK fonts as Type 3 with blank glyphs: the text renders correctly on screen and in screenshots, then comes out invisible in the PDF while still reporting the font as embedded. `--headless=new` does not fix it. WeasyPrint embeds the same fonts as CID Type 0C and renders correctly.

**Never produce an image-only PDF.** Screenshotting pages and stitching them into a PDF makes CJK look right but strips all extractable text, so ATS screening reads an empty document. If CJK looks wrong, fix the renderer — do not fall back to images.

**Never hand-edit the PDF.** Edit the markdown and re-render, so the source and artifact cannot drift.

## Markdown conventions

- One `# Title` at the top. Do not add a second wrapper title or a meta note ("English version first…") — they print as duplicate headings.
- Job/section entries use `### Employer — Role`, then an `_italic_ meta line_` for dates and stack, then bullets. The italic line renders small and grey.
- Force a page break with `<div class="pb"></div>`. The script also accepts `<div style="page-break-after: always;"></div>`.
- For a bilingual resume, put the full English resume first, a page break, then the full Chinese resume. Each language starts on a fresh page.

## Page-count control

Check the printed page count after each render. If it overflows by a little, try in this order:

1. `--density tight` — reduces margins, font size, and section spacing globally.
2. Cut content — trim the weakest bullet rather than shrinking type below ~9pt.
3. `--css <file>` — supply a full replacement stylesheet for a bespoke layout.

Targets: a single-language resume should be 1–2 pages; a bilingual one 2 pages per language. Headings never orphan at the foot of a page — the stylesheet already sets `page-break-after: avoid` on `h2`/`h3`.

## Verify before delivering

Do not trust that a successful render means a correct page. After exporting, rasterize and actually look at it:

```bash
pdftoppm -png -r 68 <output.pdf> /tmp/page   # then read /tmp/page-N.png
```

Confirm: page count is as intended, no duplicate title, CJK pages show characters (not blank gaps where text should be), and each language starts on its own page. Checking `pdffonts <output.pdf>` shows whether CJK fonts came through as CID (good) or Type 3 (broken).

## Bilingual maintenance

When only one language is edited, the two halves drift. After any content change, diff the halves and sync: summary wording, years of experience, tech stacks, contact-block formatting, section headings, and punctuation style. Report which specific fields drifted rather than silently rewriting the other half.

## Content accuracy

A resume makes claims about a real person, so verify before writing. When a bullet describes a repo or project, read that repo — check `package.json`, the README, and the relevant source — and describe what is actually there. Flag anything the user cannot back up in an interview and let them decide, rather than quietly keeping impressive-sounding but unverified wording.
