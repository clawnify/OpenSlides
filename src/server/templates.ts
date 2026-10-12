// Branded slide templates. Each `body` is a ready-to-insert deck chunk: the
// `<!-- html -->` marker tells the renderer it's a designed HTML slide, and the
// markup uses the brand CSS variables (var(--brand-*), var(--r-*)) so every
// template is on-brand automatically. The client inserts these into the deck.
// TEMPLATES are 16:9 presentation slides; DOC_TEMPLATES are A4 document pages
// (top-down reading order, denser layouts) — `templatesFor` picks by format.

import type { PageFormat } from "./formats";

export interface SlideTemplate {
  id: string;
  name: string;
  body: string;
}

// No text-align / align-items here: slides inherit the brand's alignment by
// default (overridable per slide). Sizes come from the brand vars in `inner`.
const wrap = (inner: string) =>
  `<!-- html -->
<div style="position:absolute;inset:0;display:flex;flex-direction:column;justify-content:center;padding:0 9%;box-sizing:border-box">
${inner}
</div>`;

export const TEMPLATES: SlideTemplate[] = [
  {
    id: "title",
    name: "Title",
    body: wrap(`  <div class="kicker" style="font-size:24px">Your kicker</div>
  <h1 style="font:700 var(--brand-heading-size)/1.02 var(--r-heading-font);margin:14px 0 0;color:var(--brand-heading)">Big bold title</h1>
  <p style="font:400 var(--brand-body-size)/1.4 var(--r-main-font);color:var(--brand-muted);max-width:72%;margin-top:18px">A supporting subtitle that sets the scene in one clear line.</p>`),
  },
  {
    id: "section",
    name: "Section divider",
    body: wrap(`  <div class="kicker" style="font-size:22px">Part 01</div>
  <h2 style="font:700 var(--brand-heading-size)/1.05 var(--r-heading-font);margin:10px 0 0;color:var(--brand-heading)">Section title</h2>`),
  },
  {
    id: "stat",
    name: "Big stat",
    body: wrap(`  <div style="font:700 200px/1 var(--r-heading-font);color:var(--brand-accent)">98%</div>
  <p style="font:400 var(--brand-body-size)/1.35 var(--r-main-font);color:var(--brand-text);max-width:70%;margin-top:6px">What the number means, in one sentence.</p>`),
  },
  {
    id: "quote",
    name: "Quote",
    body: wrap(`  <blockquote style="border:0;box-shadow:none;background:none;margin:0;padding:0">
    <p style="font:500 52px/1.25 var(--r-heading-font);color:var(--brand-heading)">“A short, punchy quote that lands the point.”</p>
  </blockquote>
  <div style="font:600 26px/1 var(--r-main-font);color:var(--brand-muted);margin-top:28px">— Name, Title</div>`),
  },
  {
    id: "bullets",
    name: "Title + bullets",
    body: wrap(`  <h2 style="font:700 var(--brand-subheading-size)/1.05 var(--r-heading-font);margin:0;color:var(--brand-heading)">Slide title</h2>
  <ul style="font:400 var(--brand-body-size)/1.7 var(--r-main-font);color:var(--brand-text);margin-top:28px;padding-left:1.1em;max-width:80%">
    <li>First point worth making</li>
    <li>Second point worth making</li>
    <li>Third point worth making</li>
  </ul>`),
  },
  {
    id: "chart",
    name: "Chart",
    body: `<!-- html -->
<div style="position:absolute;inset:0;display:flex;flex-direction:column;justify-content:center;padding:0 9%;box-sizing:border-box">
  <div class="kicker" style="font-size:22px">Metric</div>
  <h2 style="font:700 var(--brand-subheading-size)/1.06 var(--r-heading-font);margin:8px 0 0;color:var(--brand-heading)">Growth by quarter</h2>
  <div class="chart" style="flex:1;min-height:0;max-height:400px;margin-top:18px" data-chart='{"type":"bar","labels":["Q1","Q2","Q3","Q4"],"data":[12,19,15,27]}'></div>
</div>`,
  },
  {
    id: "two-col",
    name: "Two columns",
    body: `<!-- html -->
<div style="position:absolute;inset:0;display:grid;grid-template-columns:1fr 1fr;gap:6%;align-items:center;padding:0 9%;box-sizing:border-box">
  <div>
    <h2 style="font:700 var(--brand-subheading-size)/1.06 var(--r-heading-font);margin:0;color:var(--brand-heading)">Left column</h2>
    <p style="font:400 var(--brand-body-size)/1.5 var(--r-main-font);color:var(--brand-text);margin-top:18px">A paragraph of context that fills the left side.</p>
  </div>
  <div>
    <h2 style="font:700 var(--brand-subheading-size)/1.06 var(--r-heading-font);margin:0;color:var(--brand-heading)">Right column</h2>
    <p style="font:400 var(--brand-body-size)/1.5 var(--r-main-font);color:var(--brand-text);margin-top:18px">A matching paragraph on the right side.</p>
  </div>
</div>`,
  },
  {
    id: "image-left",
    name: "Image + text",
    body: `<!-- html -->
<div style="position:absolute;inset:0;display:grid;grid-template-columns:1fr 1fr;align-items:center;box-sizing:border-box">
  <img src="assets/placeholder.svg" alt="" style="width:100%;height:100%;object-fit:cover" />
  <div style="padding:0 8%">
    <div class="kicker" style="font-size:20px">Feature</div>
    <h2 style="font:700 var(--brand-subheading-size)/1.06 var(--r-heading-font);margin:8px 0 0;color:var(--brand-heading)">Show, then tell</h2>
    <p style="font:400 var(--brand-body-size)/1.5 var(--r-main-font);color:var(--brand-text);margin-top:18px">Describe what's on the left. Replace the image with one from your library.</p>
  </div>
</div>`,
  },
  {
    id: "full-bleed",
    name: "Full-bleed image",
    body: `<!-- html -->
<!-- .slide: data-background-image="assets/placeholder.svg" data-background-size="cover" -->
<div style="position:absolute;left:9%;bottom:9%;max-width:70%">
  <h2 style="font:700 var(--brand-heading-size)/1.05 var(--r-heading-font);margin:0;color:#fff;text-shadow:0 2px 24px rgba(0,0,0,.5)">Caption over a full-bleed photo</h2>
</div>`,
  },
];

// A4 document pages (1240×1754 canvas). Documents read top-down, so pages use
// flex-start instead of vertical centering, with ~7% top/bottom margins. Same
// brand variables as slides — one brand styles decks and documents alike.
const docWrap = (inner: string) =>
  `<!-- html -->
<div style="position:absolute;inset:0;display:flex;flex-direction:column;padding:7% 9%;box-sizing:border-box">
${inner}
</div>`;

const hairline = "1px solid color-mix(in srgb, var(--brand-muted) 25%, transparent)";

const docRow = (n: string, title: string, desc: string, last = false) => `    <div style="display:flex;gap:28px;align-items:flex-start;padding:30px 34px;${last ? "" : `border-bottom:${hairline}`}">
      <div style="flex-shrink:0;width:44px;height:44px;border-radius:999px;display:grid;place-items:center;background:color-mix(in srgb, var(--brand-accent) 12%, transparent);color:var(--brand-accent);font:700 20px/1 var(--r-heading-font)">${n}</div>
      <div>
        <h3 style="margin:0;color:var(--brand-heading)">${title}</h3>
        <p style="margin:8px 0 0;color:var(--brand-text)">${desc}</p>
      </div>
    </div>`;

export const DOC_TEMPLATES: SlideTemplate[] = [
  {
    id: "doc-cover",
    name: "Cover",
    body: docWrap(`  <div style="position:relative;width:100%;height:34%;border-radius:var(--brand-radius);overflow:hidden">
    <img src="assets/placeholder.svg" alt="" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover" />
    <div style="position:absolute;inset:0;background:linear-gradient(180deg, rgba(0,0,0,0) 30%, rgba(0,0,0,0.65) 100%)"></div>
    <div style="position:absolute;left:4%;right:4%;bottom:7%">
      <div class="kicker" style="font-size:20px;color:rgba(255,255,255,0.85)">Document type · Confidential</div>
      <h1 style="margin:12px 0 0;color:#fff;font-size:calc(var(--brand-heading-size) * 0.72);line-height:1.1">One-line positioning statement</h1>
    </div>
  </div>
  <p style="color:var(--brand-text);max-width:90%;margin-top:48px">A short introductory paragraph that frames the document — who it is for, what it covers, and why it matters.</p>`),
  },
  {
    id: "doc-sections",
    name: "Card sections",
    body: docWrap(`  <h2 style="margin:0;color:var(--brand-heading)">Section title</h2>
  <div style="margin-top:40px;border:${hairline};border-radius:var(--brand-radius);overflow:hidden">
${docRow("1", "First topic", "Two or three sentences that develop this point with at least one concrete figure.")}
${docRow("2", "Second topic", "Two or three sentences that develop this point with at least one concrete figure.")}
${docRow("3", "Third topic", "Two or three sentences that develop this point with at least one concrete figure.", true)}
  </div>`),
  },
  {
    id: "doc-table",
    name: "Data table",
    body: docWrap(`  <h2 style="margin:0;color:var(--brand-heading)">Key figures</h2>
  <table style="width:100%;margin-top:36px;border-collapse:collapse">
    <thead>
      <tr>
        <th style="text-align:left;padding:14px 4px;border-bottom:${hairline};font:600 16px/1 var(--r-main-font);letter-spacing:.12em;text-transform:uppercase;color:var(--brand-muted)">Metric</th>
        <th style="text-align:left;padding:14px 4px;border-bottom:${hairline};font:600 16px/1 var(--r-main-font);letter-spacing:.12em;text-transform:uppercase;color:var(--brand-muted)">Value</th>
      </tr>
    </thead>
    <tbody>
      <tr><td style="padding:16px 4px;border-bottom:${hairline};color:var(--brand-text)">First metric</td><td style="padding:16px 4px;border-bottom:${hairline};color:var(--brand-heading);font-weight:600">$X,000</td></tr>
      <tr><td style="padding:16px 4px;border-bottom:${hairline};color:var(--brand-text)">Second metric</td><td style="padding:16px 4px;border-bottom:${hairline};color:var(--brand-heading);font-weight:600">XX%</td></tr>
      <tr><td style="padding:16px 4px;color:var(--brand-text)">Third metric</td><td style="padding:16px 4px;color:var(--brand-heading);font-weight:600">$X00,000</td></tr>
    </tbody>
  </table>`),
  },
  {
    id: "doc-text",
    name: "Text page",
    body: docWrap(`  <div class="kicker" style="font-size:20px">Section</div>
  <h2 style="margin:12px 0 0;color:var(--brand-heading)">Page heading</h2>
  <p style="color:var(--brand-text);margin-top:28px">A first paragraph of running text. Documents can carry real prose — a few sentences per paragraph, set in the body size on the brand canvas.</p>
  <p style="color:var(--brand-text);margin-top:18px">A second paragraph that continues the argument. Keep paragraphs short and scannable; use a new Card sections or Data table page when structure helps.</p>`),
  },
  {
    id: "doc-back",
    name: "Back cover",
    body: `<!-- html -->
<div style="position:absolute;inset:0;display:flex;flex-direction:column">
  <img src="assets/placeholder.svg" alt="" style="width:100%;flex:1;min-height:0;object-fit:cover" />
  <div style="background:var(--brand-heading);padding:6% 9%">
    <h3 style="margin:0;color:#fff">Company name</h3>
    <p style="margin:14px 0 0;color:rgba(255,255,255,.8)">Street address · City · Country</p>
    <p style="margin:8px 0 0;color:rgba(255,255,255,.8)">name@company.com · +00 0 00 00 00 00 · www.company.com</p>
  </div>
</div>`,
  },
];

// Continuing pages (`<!-- .slide: data-flow -->`): normal-flow content that runs
// onto as many A4 pages as it needs in the PDF. These are the template pages of
// a quote or contract: {{variables}} for what changes per document, a
// data-each row per line item, data-if for the parts some documents leave out.
const flowWrap = (inner: string) =>
  `<!-- html -->
<!-- .slide: data-flow -->
<div style="padding:0 9%;box-sizing:border-box">
${inner}
</div>`;

const band = "padding:44px;border-radius:var(--brand-radius);background:color-mix(in srgb, var(--brand-muted) 9%, transparent)";
const th = `padding:14px 4px;border-bottom:${hairline};font:600 18px/1.2 var(--r-main-font);color:var(--brand-heading)`;
const td = `padding:20px 4px;border-bottom:${hairline};vertical-align:top;color:var(--brand-text)`;
const note = "margin-top:6px;font-size:18px;color:var(--brand-muted)";
const label = "margin:0;font-weight:600;color:var(--brand-heading)";

export const QUOTE_TEMPLATES: SlideTemplate[] = [
  {
    id: "doc-quote",
    name: "Quote with line items",
    body: flowWrap(`  <div style="display:flex;justify-content:space-between;align-items:center">
    <h1 style="margin:0;color:var(--brand-heading);font-size:var(--brand-subheading-size)">Quote</h1>
    <div style="font:700 40px/1 var(--r-heading-font);color:var(--brand-accent)">Your company</div>
  </div>
  <div style="display:flex;justify-content:space-between;gap:48px;margin-top:36px;break-inside:avoid;${band}">
    <div>
      <p style="${label}">{{client.company}}</p>
      <p style="margin:6px 0 0">{{client.address}}</p>
      <p style="margin:6px 0 0" data-if="client.vat">VAT {{client.vat}}</p>
      <p style="margin:28px 0 0;font-weight:600;color:var(--brand-heading)">{{client.contact}}</p>
      <p style="margin:6px 0 0">{{client.email}}</p>
    </div>
    <div style="text-align:right">
      <p style="${label}">Quote details</p>
      <p style="margin:6px 0 0">Reference: {{quote.reference}}</p>
      <p style="margin:6px 0 0">Created: {{quote.date}}</p>
      <p style="margin:6px 0 0">Valid until: {{quote.valid_until}}</p>
      <p style="margin:28px 0 0;font-weight:600;color:var(--brand-heading)">Prepared by</p>
      <p style="margin:6px 0 0">{{quote.author}}</p>
      <p style="margin:6px 0 0">{{quote.author_email}}</p>
    </div>
  </div>
  <h2 style="margin:64px 0 0;color:var(--brand-heading)">Products &amp; services</h2>
  <table style="width:100%;margin-top:24px;border-collapse:collapse">
    <thead>
      <tr>
        <th style="${th};text-align:left;width:44%">Item &amp; description</th>
        <th style="${th};text-align:right;width:8%">Qty</th>
        <th style="${th};text-align:right;width:24%">Unit price</th>
        <th style="${th};text-align:right;width:24%">Total</th>
      </tr>
    </thead>
    <tbody>
      <tr data-each="line_items">
        <td style="${td}">{{name}}<div data-if="description" style="${note}">{{description}}</div></td>
        <td style="${td};text-align:right">{{quantity}}</td>
        <td style="${td};text-align:right">{{unit_price}}</td>
        <td style="${td};text-align:right">{{total}}<div data-if="total_note" style="${note}">{{total_note}}</div></td>
      </tr>
    </tbody>
  </table>
  <table style="width:50%;margin:8px 0 0 auto;border-collapse:collapse;break-inside:avoid">
    <tbody>
      <tr data-each="subtotals">
        <td style="${td}">{{label}}</td>
        <td style="${td};text-align:right">{{amount}}<div data-if="note" style="${note}">{{note}}</div></td>
      </tr>
      <tr>
        <td style="${td};font-weight:600;color:var(--brand-heading)">Total</td>
        <td style="${td};text-align:right;font-weight:600;color:var(--brand-heading)">{{total}}</td>
      </tr>
    </tbody>
  </table>`),
  },
  {
    id: "doc-terms-signature",
    name: "Purchase terms + signature",
    body: flowWrap(`  <div style="${band}">
    <h2 style="margin:0;color:var(--brand-heading)">Purchase terms</h2>
    <p style="margin:24px 0 0;font-weight:600;color:var(--brand-heading)">{{plan.name}} includes:</p>
    <ul style="margin:12px 0 0;padding-left:1.2em;line-height:1.6">
      <li data-each="plan.includes">{{.}}</li>
    </ul>
    <p style="margin:24px 0 0;font-weight:600;color:var(--brand-heading)">Our terms and conditions apply:</p>
    <ul style="margin:12px 0 0;padding-left:1.2em;line-height:1.6">
      <li>Payment within 14 days of the invoice date.</li>
      <li>Start date: {{quote.start_date}}.</li>
      <li data-if="special_terms" data-each="special_terms">{{.}}</li>
    </ul>
  </div>
  <div style="margin-top:72px;break-inside:avoid">
    <h2 style="margin:0;color:var(--brand-heading)">Signature</h2>
    <div style="display:flex;gap:64px;margin-top:110px">
      <div style="flex:1;border-top:2px solid var(--brand-text);padding-top:10px">Signature</div>
      <div style="flex:1;border-top:2px solid var(--brand-text);padding-top:10px">Date</div>
    </div>
    <div style="width:calc(50% - 32px);margin-top:110px;border-top:2px solid var(--brand-text);padding-top:10px">Name</div>
  </div>`),
  },
  {
    id: "doc-flow-text",
    name: "Continuing text (terms, appendix)",
    body: flowWrap(`  <h2 style="margin:0;color:var(--brand-heading)">Terms and conditions</h2>
  <p style="margin:28px 0 0;color:var(--brand-text)">Paste long text here. In the PDF this page continues onto as many pages as the text needs.</p>`),
  },
];

/** The starter/template set for a deck's format. */
export function templatesFor(format: PageFormat): SlideTemplate[] {
  return format.kind === "document" ? [...DOC_TEMPLATES, ...QUOTE_TEMPLATES] : TEMPLATES;
}
