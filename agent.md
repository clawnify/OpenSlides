# OpenSlides — agent guide

This app turns **designed HTML slides into reveal.js decks — and A4 documents**.
You author each slide as a small block of HTML that fills a fixed canvas and is
styled with the active brand's CSS variables, the user drops in logos/images,
presents fullscreen in the browser, and exports to PDF on the managed Clawnify
render service. You never touch a browser or a PDF toolchain — you write HTML
and call this app's API. **Markdown is not supported.**

A document can also be a **template**: mark the parts that change with
`{{variables}}`, then render finished PDFs from data with one API call per
document (quotes, contracts, offer letters). See "Template variables" below.

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
fine (paragraphs, card-row sections, data tables). A designed page is a fixed
canvas: content that doesn't fit is **clipped**. Verify dense pages with the
slide-PNG endpoint. For long text or a table that can grow, use a
**continuing page** instead (below).

## Continuing pages

A page whose first line is `<!-- .slide: data-flow -->` is not a fixed canvas:
in the PDF it runs onto as many A4 pages as its content needs. Use it for terms
and conditions, appendices and line-item tables of any length.

```html
<!-- .slide: data-flow -->
<div style="padding:0 9%;box-sizing:border-box">
  <h2>Terms and conditions</h2>
  <p>…as much text as you need…</p>
</div>
```

- Markup is **normal flow**: no `position:absolute;inset:0` wrapper, no fixed
  heights. Side padding is yours (`0 9%`); the PDF adds the top and bottom
  whitespace on every page it spans.
- In the PDF, table header rows (`<thead>`) repeat on each page, and table rows,
  list items, images and charts are never split across pages.
- A continuing page carries no brand logo and no per-page background (it sits on
  the brand background). A deck that has one prints no page numbers.
- In the editor it scrolls, with a faint line roughly where each PDF page ends.
  `GET /api/decks/{id}/slide/{n}` shows only its first page's worth, so check a
  continuing page by rendering the PDF.

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
brand logo, or a deck's sample values) references it. Remove the reference and
the file is garbage-collected from storage, so don't upload media you aren't
going to place on a slide. The exception is an upload passed as an image value
to `POST /api/decks/{id}/render`: render with it within a couple of minutes of
uploading, and it is then kept for 30 days after each render that uses it.

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

## Template variables: generate documents from data

A deck or document becomes a **template** when its pages mark what changes per
copy. One template (a quote, a contract, an offer letter, a deck per prospect)
then renders any number of finished PDFs from data, without editing the deck.

| Mark | Means |
|------|-------|
| `{{client.name}}` | a value, in text or inside an attribute (`<img src="{{client.logo}}">`). Dots group related values. |
| `<tr data-each="line_items">` | repeat this element once per item of the list `line_items`. Inside it, names refer to **the item only**. |
| `{{@root.currency}}` | a top-level value, read from anywhere, including inside a `data-each` row. |
| `<p data-if="discount_note">` | keep this element only when `discount_note` is set. Absent, `null`, empty, `false`, `0`, `[]` and the strings `"false"` and `"0"` hide it. |
| `<p data-unless="discount_note">` | the opposite: keep this element only when `discount_note` is **not** set. |
| `<img data-logo="client.website">` | the company logo for the website in `client.website`, looked up when the document is made. No website, no image. |

```html
<table>
  <thead><tr><th>Item</th><th>Total</th></tr></thead>
  <tbody>
    <tr data-each="line_items">
      <td>{{name}}<div data-if="note">{{note}}</div></td>
      <td>{{total}}</td>
    </tr>
  </tbody>
</table>
<p>Total {{total}}</p>
<ul><li data-each="includes">{{.}}</li></ul>
```

Rules:

- **Structure goes in `data-each` / `data-if`, never in `{{#section}}` tags.** The
  editor re-parses a page as HTML on every edit, and a bare section tag inside a
  table gets moved out of it.
- **Inside a `data-each` element, names never fall back to outer values.** The
  row's `{{total}}` above is the line total; the grand `{{total}}` sits outside the
  row. A row without its own `total` is an error, not the grand total. To show an
  outer value in a row, say so: `{{@root.currency}}`.
  `{{.}}` is the item itself, for a list of plain strings.
- **Values arrive formatted.** The template does no maths and no formatting: send
  `"€1,500.00 / month"`, not `1500`. Totals are computed by whoever calls render.
- `data-if` and `data-each` on one element: `data-if` decides whether it appears
  at all, then `data-each` repeats it, which is how an **optional list** works.
- Values are HTML-escaped, and a line break in a value prints as a line break
  (an address on several lines).
- **Images.** A variable used as a whole image source,
  `<img src="{{client.logo}}" alt="">` or `style="background:url('{{hero}}')"`,
  is listed by `/fields` with type `image`. Its value is an `https://` image URL,
  a `data:image/…` URI, or an upload of this app (`assets/<key>` from
  `POST /api/assets`). The render fetches each image itself and embeds it in the
  PDF; one it can't use (a 404, a web page instead of an image, too large) is a
  `422` naming it: `client.logo: image could not be loaded (HTTP 404)`. Limits:
  2 MB per image, 4 MB of images per document. Put `data-if="client.logo"` on an
  optional image so the slot disappears when no logo is sent.
- **Company logos.** When you have a client's website but not its logo, use
  `<img data-logo="client.website" alt="">` and send the website
  (`"acme.com"`, `"https://www.acme.com"` or even `"jane@acme.com"`). `/fields`
  lists it with type `website`. Two optional attributes pick the version:
  `data-logo-theme="light"` (the default) or `"dark"` for a logo that sits on a
  dark background, and `data-logo-shape="square"` (the brand's symbol, the
  default) or `"full"` (the wide logo with the name). The logo comes from
  logo.dev when the org has saved its key as the environment variable
  `LOGO_DEV_SECRET_KEY`; otherwise from a built-in library of brand logos (the
  brand's main logo, so `data-logo-shape` has no effect) and then the site's
  own icon. When nothing is found the image is left out and the render still
  succeeds, with the reason in `warnings`. A value that is not a website
  (`"Acme Inc"`) is a `422`. Style the slot with a fixed height and
  `object-fit:contain`, since logos come in every shape.
- Send values nested (`{ "client": { "name": … } }`) or as flat dotted keys
  (`{ "client.name": … }`); both fill `{{client.name}}`.
- An explicit `null` prints nothing (and a `null` list renders no rows). A key
  you leave out is still a missing value.
- Text that never changes (the terms) stays literal in the page.
- When you edit a page that holds `{{tokens}}`, keep every token **verbatim**.

**Generate a document:**

1. `GET /api/decks/{id}/fields` returns every variable with its type (`text`,
   `image`, `website` for a company logo, `list` with its item `fields`, or
   `flag` for a `data-if`-only switch), whether
   it is `optional`, and an `example`: a complete `values` object built from the
   deck's sample values. Start from it and replace the sample data with the real
   values; a required value with no sample shows as a `<name>` placeholder, and
   optional values without a sample are left out.
2. `POST /api/decks/{id}/render` with `{ "values": { … } }` (optional
   `"filename"`, and `"expires_in"` in seconds: default 86400, max 604800) returns
   `{ url, expires_at, size, filename, unused, warnings }`: a link to the
   finished PDF. Download it or hand the URL on (an email attachment, a CRM
   record). The link expires, so render again for a fresh one. The stored deck
   never changes. `warnings` lists what was left out without failing, such as
   `client.website: no logo found for acme.com, so the image is left out`.
3. Rendering is **strict**: if any value the pages reach is missing or of the
   wrong kind, nothing renders and you get `422` with `missing` (exact paths such
   as `line_items[1].total`), `invalid`, and `unused` (keys no page uses). A key
   in `unused` next to a similar name in `missing` is a typo. Fix and retry. A
   gap is never filled from the sample values.

```json
POST /api/decks/{id}/render
{
  "values": {
    "client": { "company": "Harbor & Pine Bakery", "email": "ana@harborpine.example" },
    "line_items": [
      { "name": "Website care plan", "total": "€1,500.00 / month", "note": "for 1 year" },
      { "name": "Implementation fee", "total": "€0.00" }
    ],
    "total": "€1,500.00"
  },
  "filename": "Quote Q-2026-0142"
}
```

**Sample values** (`sample_values` on the deck, a JSON object) are example data:
they fill the editor's Preview, the PDF button (`GET /api/decks/{id}/pdf`) and
`GET /api/decks/{id}/slide/{n}?sample=1`. Set them with
`PUT /api/decks/{id} { "sample_values": { … } }` when you build a template, so the
user sees it filled. They are never used by `render`.

**Making a template** from an existing document: replace each changing piece of
text with a `{{name}}` (keep the old text as the sample value), put `data-each`
on the row that repeats, put `data-if` on optional parts, and make any page that
can grow a continuing page. In the editor, a person can select an element and
use **Make variable**, or type `{{name}}` into any text.

## API

| Method | Path | Purpose |
|--------|------|---------|
| GET  | `/api/decks` | List decks |
| GET  | `/api/decks/{id}` | Get one (includes `content`, `format`, `sample_values`) |
| POST | `/api/decks` | Create `{ title, content?, theme?, brand_id?, format?, sample_values? }` |
| PUT  | `/api/decks/{id}` | Update any of `title/content/theme/brand_id/sample_values` (not `format`) |
| DELETE | `/api/decks/{id}` | Delete |
| GET  | `/api/decks/{id}/view` | Interactive reveal.js deck (HTML). `?sample=1` fills it with the sample values |
| GET  | `/api/decks/{id}/fields` | The template's variables, their types, and a complete `example` values object |
| POST | `/api/decks/{id}/render` | Fill the template with `{ values }` and render a PDF → `{ url, expires_at, size, filename, unused, warnings }`. Strict: `422` lists `missing`/`invalid` paths |
| GET  | `/api/decks/{id}/pdf` | Export to PDF (one slide/page per PDF page, continuing pages as long as they need), filled with the sample values |
| GET  | `/api/decks/{id}/slide/{n}` | Render slide `n` (0-based) to a **PNG** — fetch it to SEE how your HTML actually rendered and confirm it looks right. Add `?output=url` → `{ url, expires_at }` (presigned link) — use this when calling through an API proxy that can't return binary bodies. Add `?sample=1` to see it filled with the sample values |
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

`GET /api/decks/{id}/pdf` and `POST /api/decks/{id}/render` build one print
page per slide (a continuing page spans as many as it needs) and send it to
Clawnify's managed PDF service, which returns a PDF with real, selectable text.
The app does no rendering itself. A `503` means PDF export isn't configured (no
managed token, which only happens in local dev). A `502` means the render
service rejected the deck; the `detail` field explains why. A `413` means the
filled document is too large (send fewer or shorter items).
