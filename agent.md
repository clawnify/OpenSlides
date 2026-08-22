# OpenSlides — agent guide

This app turns **designed HTML slides into reveal.js decks — and A4 documents**.
You author each slide as a small block of HTML that fills a fixed canvas and is
styled with the active brand's CSS variables, the user drops in logos/images,
presents fullscreen in the browser, and exports to PDF on the managed Clawnify
render service. You never touch a browser or a PDF toolchain — you write HTML
and call this app's API. **Markdown is not supported.**

Base URL: this app's own origin. All endpoints are under `/api`.

## Page formats

Every deck has a `format`, set at creation (`POST /api/decks { format }`) and
fixed for its lifetime (`GET /api/formats` lists them):

| `format` | Canvas | Exports as | Use for |
|---|---|---|---|
| `16:9` (default) | 1280×720 | one 16:9 page per slide | presentations |
| `a4-portrait` | 1240×1754 | true A4 pages (210×297mm) | documents: info memos, one-pagers, branded reports |

Both share the same brand variables and ~same canvas width, so one brand's type
scale reads the same in both. **A4 pages read top-down**: use
`padding:7% 9%` and `flex-start` (not vertical centering), denser layouts are
fine (paragraphs, card-row sections, data tables) — but a page is still a fixed
canvas: content that doesn't fit is **clipped, never flowed** to the next page.
Split long sections across pages yourself and verify dense pages with the
slide-PNG endpoint.

## Deck format

A deck is one document. Slides are separated by a line containing only `---`.
Every slide is HTML laid out on the full canvas of the deck's format
(1280×720 for `16:9`, 1240×1754 for `a4-portrait`). Style with the brand CSS
variables (never hardcode brand colors/fonts) so the deck stays on-brand:
`--brand-bg`, `--brand-text`, `--brand-heading`, `--brand-accent`,
`--brand-muted`, `--brand-heading-size`, `--brand-subheading-size`,
`--brand-body-size`, `--brand-radius`, `--r-heading-font` (display font),
`--r-main-font` (body font). The three sizes (heading/subheading/body, 12–100px)
are the brand's type scale; plain `h1`/`h2`/`p` inherit them, so usually omit
font-size and only set one (using the matching variable) for a special element.

```html
<div style="position:absolute;inset:0;display:flex;flex-direction:column;justify-content:center;padding:0 9%;box-sizing:border-box">
  <div class="kicker" style="font-size:24px">Your kicker</div>
  <h1 style="font-weight:700;color:var(--brand-heading)">Title slide</h1>
  <p style="color:var(--brand-muted);max-width:72%;margin-top:18px">A supporting subtitle.</p>
</div>

---

<div style="position:absolute;inset:0;display:flex;flex-direction:column;justify-content:center;padding:0 9%;box-sizing:border-box">
  <h2 style="font:700 60px/1.05 var(--r-heading-font);margin:0;color:var(--brand-heading)">Second slide</h2>
  <div class="chart" style="flex:1;min-height:0;max-height:400px;margin-top:18px" data-chart='{"type":"bar","labels":["Q1","Q2","Q3"],"data":[12,19,27]}'></div>
  <aside class="notes">Only shows in the presenter view.</aside>
</div>
```

- **Background — leave it to the brand.** Every slide sits on the brand canvas
  (`--brand-bg`) automatically; that's what keeps the deck on-brand, so do NOT set
  a per-slide background by default. Only when the user explicitly asks for a
  specific slide background, add a `<!-- .slide: ATTRS -->` first line
  (`data-background-color`, `data-background-gradient`, or
  `data-background-image="assets/<key>"`), preferring the brand's own colours.
- **Charts:** a `<div class="chart" data-chart='{"type":"bar|line|donut","labels":[…],"data":[…]}'></div>`
  renders as on-brand SVG automatically (give it a height). Don't style it yourself.
- **Infographics:** for a process, timeline, funnel, pyramid, comparison, roadmap
  or labelled grid, embed the [@antv/infographic](https://github.com/antvis/Infographic)
  DSL in a marked script — it renders to a brand-themed SVG at serve time:
  ```html
  <div class="infographic" style="flex:1;min-height:0"><script type="text/x-infographic">
  infographic sequence-steps-badge-card
  data
    title Our rollout
    lists
      - label Discover
        desc Research and scope
      - label Build
        desc Ship the core
  </script></div>
  ```
  Prefer the **card/badge/node** variants (real visual cards) over the bare
  `…-simple` ones (which are TEXT-ONLY): `sequence-steps-badge-card`,
  `list-grid-badge-card`, `list-grid-compact-card`, `list-grid-ribbon-card`,
  `sequence-funnel-simple`, `sequence-pyramid-simple`, `compare-swot`,
  `relation-circle-icon-badge`. One per slide; don't style it yourself.
- **Animations:** `class="fragment fade-up"` makes an element animate in — these
  play only while presenting, never in the editor or the PDF. Effects: fade-up,
  fade-down, fade-left, fade-right, zoom-in, grow.
- **Speaker notes:** `<aside class="notes">…</aside>` inside a slide — the
  per-slide store of intent (what to say / the point of the slide). Hidden on the
  slide and in the PDF, shown in the presenter view. Write one per slide.
- **Code:** `<pre><code class="language-ts">…</code></pre>` is syntax-highlighted.

## Embedding media

Upload an image or video with `POST /api/assets` (multipart `file`) → `{ key }`,
then reference it by path `assets/<key>`: `<img src="assets/<key>">` or
`<video controls src="assets/<key>"></video>`. On PDF export the app inlines
referenced images automatically — you don't attach them.

There is no media library to list: an asset exists only while a slide (or a
brand logo) references it. Remove the reference and the file is garbage-collected
from storage, so don't upload media you aren't going to place on a slide.

**Image placeholders.** `assets/placeholder.svg` is a built-in virtual asset (no
upload needed, never garbage-collected): use it for image slots the user fills
later — it renders as a neutral "Click to add image" box in the editor, the
present view and the PDF, and clicking it (even under a gradient/caption
overlay) opens the picker and swaps in a real upload. Hero-with-overlay pattern:
absolutely-position the img in a relative container, layer the gradient div and
text above it.

## Brand reference originals

When you replicate an existing template (a client's PDF, a branded document),
store the original with the brand as **provenance + a fidelity oracle**:
`POST /api/assets` with multipart fields `file`, `role=reference`,
`brand_id=<id>`. Reference assets are never garbage-collected — they live until
their brand is deleted (or `DELETE /api/assets/{id}`). `GET /api/brands/{id}`
returns them under `references`; fetch one at `/api/uploads/{key}`.

Replication loop: study the original → author the brand's DESIGN.md (tokens +
guidelines + example pages) → build the deck/document → compare each rendered
page (`GET /api/decks/{id}/slide/{n}`) against the original's pages and iterate.

Attached references are also **seen by the in-app brand AI**: every reference
(images + PDFs) is attached to `POST /api/brands/{id}/generate`, so an
instruction like "based on the original file, create the brand" is grounded in
the actual file.

**Format-tagged example slides.** In a brand's `## Example slides`, a
`### <name> (<format-id>)` sub-heading tags its fenced examples with a page
format — e.g. `### Cover (a4-portrait)`; untagged examples are 16:9. One brand
can carry both slide and document layouts. `POST /api/decks` with
`seed_from_brand: true` seeds the new deck from the examples matching its
`format`, so author a replicated document template's page layouts as
`(a4-portrait)`-tagged examples and every new document from that brand starts
as the replicated template.

## API

| Method | Path | Purpose |
|--------|------|---------|
| GET  | `/api/decks` | List decks |
| GET  | `/api/decks/{id}` | Get one (includes `content`, `format`) |
| POST | `/api/decks` | Create `{ title, content?, theme?, brand_id?, format? }` |
| PUT  | `/api/decks/{id}` | Update any of `title/content/theme/brand_id` (not `format`) |
| DELETE | `/api/decks/{id}` | Delete |
| GET  | `/api/decks/{id}/view` | Interactive reveal.js deck (HTML) |
| GET  | `/api/decks/{id}/pdf` | Export to PDF (one slide/page per PDF page) |
| GET  | `/api/decks/{id}/slide/{n}` | Render slide `n` (0-based) to a **PNG** — fetch it to SEE how your HTML actually rendered and confirm it looks right. Add `?output=url` → `{ url, expires_at }` (presigned link) — use this when calling through an API proxy that can't return binary bodies |
| GET  | `/api/formats` | List page formats (id, label, kind, canvas) |
| GET  | `/api/templates?format={id}` | Designed starter slides/pages for a format |
| GET  | `/api/brands` | List brands (id, name, tokens) |
| GET  | `/api/brands/{id}` | One brand incl. `design_md` + `references` (original files) |
| POST | `/api/assets` | Upload an image/video (multipart `file`) → `{ key }`; add `role=reference&brand_id=…` to store a brand original instead |
| DELETE | `/api/assets/{id}` | Remove a brand reference original (media is GC-managed) |

`theme` is a reveal.js theme name (the base under the brand's token overrides):
`white`, `black`, `league`, `beige`, `sky`, `night`, `serif`, `simple`,
`solarized`, `moon`, `dracula`, `blood`.

## Authoring ON-BRAND — read this before writing any slide

A deck or document is only on-brand if it is built FROM the brand. Never
hand-invent generic layouts ("Welcome to…", title + bullets, big stat) when a
brand exists — that produces off-brand output even with the right colors.

1. **Read the brand first.** `GET /api/brands/{id}` → `design_md` IS the design
   system: tokens, written guidelines, and **Example slides** — the brand's real
   page layouts, possibly format-tagged (e.g. `### Cover (a4-portrait)`).
2. **Match the format to the brand's examples.** A brand replicating an A4
   document carries `(a4-portrait)` examples — create
   `POST /api/decks { format: "a4-portrait", … }`, not a 16:9 deck. A 16:9 deck
   from such a brand gets colors only and NO layouts.
3. **Preferred: seed from the brand.** `POST /api/decks { brand_id, format,
   seed_from_brand: true }` — the deck starts as the brand's example pages for
   that format. Then edit CONTENT surgically (swap placeholder text, keep the
   markup/layout) via `PUT`.
4. **Or let the built-in AI author it:** `POST /api/decks/{id}/generate`
   (`sync: true`) — it grounds in the brand's DESIGN.md + the format's examples
   automatically and can look at rendered slides while working.
5. **Verify like a designer:** render pages with `GET /api/decks/{id}/slide/{n}`
   and compare against the brand's examples before handing over.

**Selecting the brand for generation.** The generate endpoint always uses the
DECK's brand — there is no per-request brand. Set it at creation
(`POST /api/decks { brand_id, … }`) or switch it any time with
`PUT /api/decks/{id} { "brand_id": "…" }`, then generate.

**Editing an existing slide via API.** Two ways:
- *Surgical:* `GET /api/decks/{id}` → `content` is one document, slides split by
  a line containing only `---`. Edit exactly the chunk you mean (keep its
  markup/layout, change the content) and `PUT` the full `content` back.
- *AI:* `POST /api/decks/{id}/generate { "prompt": "…", "current_index": N }` —
  the agent loop treats slide `N` as "the slide the user is looking at", so
  "fix the headline on this slide" edits slide `N` and nothing else.

## Authoring flow

1. Read the brief. Pick the brand (`GET /api/brands`) and pass its `brand_id`.
2. If the deck needs images/video, `POST /api/assets` each file and place it
   with `assets/<key>`. Upload only what you'll actually reference.
3. Write the deck as HTML slides — one idea per slide, slides split by `---`,
   styled with the brand variables — and `POST /api/decks` (or `PUT` to revise).
4. **Verify rendering**: for any chart, infographic or dense slide, fetch
   `GET /api/decks/{id}/slide/{n}` and look at the PNG — your HTML is rendered
   exactly as the audience sees it, so you can catch overflow, overlap, an empty
   chart or off-brand colors and fix the slide before handing it over.
5. The user presents it in-app (fullscreen) or you can hand them
   `GET /api/decks/{id}/pdf` for a shareable PDF.

## How export works (so you can reason about failures)

`GET /api/decks/{id}/pdf` builds a print-mode reveal.js page (reveal's own
`?print-pdf` layout, one `.pdf-page` per slide) and sends it to Clawnify's
managed PDF service, which returns one PDF page per slide. The app does no
rendering itself. A `503` means PDF export isn't configured (no managed token —
only happens in local dev). A `502` means the render service rejected the deck;
the `detail` field explains why.
