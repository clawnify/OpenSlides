// Natural-language slide generation. The user describes what they want; we ask
// an LLM (via the org's injected OPENROUTER_API_KEY — the platform standard) to
// author slides in this app's format, grounded in the active brand so output is
// on-brand and layout-consistent.

import { generateText, tool, stepCountIs, type LanguageModel } from "ai";
import { z } from "zod";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import type { BrandTokens } from "./brand";
import type { SlideTemplate } from "./templates";
import type { PageFormat } from "./formats";

// Provider-agnostic via the Vercel AI SDK. Works with a direct Anthropic key
// (BYOK) or OpenRouter (platform standard); Anthropic wins when both are set.
const ANTHROPIC_MODEL = "claude-sonnet-4-6";
const OPENROUTER_MODEL = "anthropic/claude-sonnet-4.6";

export type AiEnv = { ANTHROPIC_API_KEY?: string; OPENROUTER_API_KEY?: string };
export const hasAiKey = (env: AiEnv) => !!(env.ANTHROPIC_API_KEY || env.OPENROUTER_API_KEY);

// OpenRouter attribution — always credit the platform, so usage rolls up under
// Clawnify rather than per-app.
const OPENROUTER_ATTRIBUTION = {
  "HTTP-Referer": "https://clawnify.com",
  "X-Title": "Clawnify",
};

function model(env: AiEnv): LanguageModel {
  if (env.ANTHROPIC_API_KEY) return createAnthropic({ apiKey: env.ANTHROPIC_API_KEY })(ANTHROPIC_MODEL);
  if (env.OPENROUTER_API_KEY) {
    return createOpenRouter({ apiKey: env.OPENROUTER_API_KEY, headers: OPENROUTER_ATTRIBUTION })(OPENROUTER_MODEL);
  }
  throw new Error("AI generation unavailable: set ANTHROPIC_API_KEY or OPENROUTER_API_KEY.");
}

// One authored slide: the slide markup plus its speaker notes (the per-slide
// store of intent/context — see docs). Both come from the model's tool calls;
// the deck-ops layer assembles them into a deck chunk.
export interface AuthoredSlide { content: string; notes: string }
export interface DeckSlide { index: number; notes: string; content: string }

// The deck the agent operates on. Each verb mutates + persists + streams the
// deck (implemented by the SSE endpoint); the agent just calls them in a loop.
// This is the whole "harness": small composable tools over a live deck.
export interface DeckOps {
  read(): Promise<DeckSlide[]>;
  add(slide: AuthoredSlide, afterIndex?: number): Promise<number>; // → new slide's index
  edit(index: number, slide: AuthoredSlide): Promise<void>;
  remove(index: number): Promise<void>;
  renderPng(index: number): Promise<string | null>; // base64 PNG of the rendered slide, or null
}

interface GenInput {
  prompt: string;
  tokens: BrandTokens;
  designMd: string; // the brand's full DESIGN.md (prose layout/voice guidance + tokens)
  format: PageFormat; // the deck's page format (16:9 slides / A4 document pages)
  // The brand's example slides for THIS format (already filtered) — embedded in
  // the prompt with copy-first semantics, and the examples of other formats as
  // visual-language reference when this format has none.
  brandExamples: string[];
  otherFormatExamples: string[];
  templates: SlideTemplate[];
  currentIndex?: number; // the slide the user is looking at
  deck: DeckSlide[]; // the deck's current slides (indexed) at the start of the turn
  instructions?: string; // deck-level agent.md: general guidance to always follow
}

function listDeck(deck: DeckSlide[], currentIndex?: number): string {
  if (!deck.length) return "(empty deck)";
  return deck
    .map((s) => {
      const mark = s.index === currentIndex ? "  ← CURRENT SLIDE (the user is looking at THIS one)" : "";
      return `[${s.index}]${mark}\n${s.notes || "(no notes)"}\n${s.content}`;
    })
    .join("\n---\n");
}

function systemPrompt(
  tokens: BrandTokens,
  templates: SlideTemplate[],
  format: PageFormat,
  brandExamples: string[] = [],
  otherFormatExamples: string[] = [],
): string {
  const cw = format.canvas.width;
  const ch = format.canvas.height;
  const isDoc = format.kind === "document";
  // The brand's own layouts are the strongest grounding there is — embed them
  // verbatim with copy-first semantics instead of hoping the model fishes them
  // out of the DESIGN.md prose.
  const examplesBlock = brandExamples.length
    ? `

## THE BRAND'S PAGE LAYOUTS FOR THIS FORMAT — copy-first, do not reinvent
The brand defines these exact ${format.id} layouts. When a requested slide/page
matches one of these types (a cover, a card/section page, a data page, a back
cover…), START FROM that example's markup VERBATIM and change ONLY the content
(text, numbers, image refs). Do not compose a different layout for a covered
type. For types not covered, compose new markup in the SAME visual language
(same spacing rhythm, same band/card/hairline motifs, same type usage).
${brandExamples.map((ex, i) => `### Brand layout ${i + 1}\n${ex}`).join("\n\n")}`
    : otherFormatExamples.length
      ? `

## BRAND LAYOUTS (authored for a DIFFERENT page format)
This brand's example layouts target another format, so don't paste them as-is —
but they define the brand's visual language (band heroes, card rows, hairlines,
type usage). ADAPT that language to this ${cw}x${ch} canvas rather than
inventing a generic look.
${otherFormatExamples.slice(0, 3).map((ex, i) => `### Reference layout ${i + 1}\n${ex}`).join("\n\n")}`
      : "";
  const docMode = isDoc
    ? `

## DOCUMENT MODE — this deck is an A4 PORTRAIT DOCUMENT, not a presentation
- Each "slide" is one A4 page (${cw}x${ch} canvas, exported as a true A4 PDF page).
- Pages read TOP-DOWN: use flex-start (not vertical centering) and ~7% top/bottom
  + ~9% side padding: \`<div style="position:absolute;inset:0;display:flex;flex-direction:column;padding:7% 9%;box-sizing:border-box">\`.
- Documents carry real content: paragraphs, card-row sections, data tables. Denser
  than a slide is fine — but a page is still a FIXED canvas: content that doesn't
  fit is clipped, never flowed to the next page. Split long sections across pages
  yourself, and view_slide any dense page to check nothing is cut off.
- Typical structure: a cover page, content pages (sections/tables/prose), a back
  cover with contact details. The brand logo overlays every page automatically.`
    : "";
  return `You are a ${isDoc ? "document designer" : "slide designer"} for "OpenSlides", a reveal.js ${isDoc ? "deck tool being used in A4 document mode" : "deck tool"}. You build and refine ${isDoc ? "documents" : "decks"} by calling small tools in a loop, and you ALWAYS match the brand.${docMode}${examplesBlock}

## How you work (a multi-step loop)
1. Call \`read_brand_design\` FIRST to study the brand's voice, layout, spacing and rules.
2. Then act on the deck with these verbs, ONE slide at a time — each call takes effect immediately, so the user watches the deck change live:
   - \`add_slide\` — append a new slide (or insert after a given index).
   - \`edit_slide\` — replace the slide at an index with new content (use this to refine/fix an existing slide).
   - \`delete_slide\` — remove the slide at an index.
   - \`read_deck\` — re-read the current slides with their indices and notes (indices shift after add/delete, so re-read if unsure).
   - \`view_slide\` — render a slide to an IMAGE and look at it to check it came out right. After writing a chart, an infographic or a dense/complex slide, view it; if text overflows, elements overlap, a chart/infographic is empty, or it looks off-brand, fix it with edit_slide. Don't view every trivial slide — use it where rendering can surprise you.
3. Stop when the deck satisfies the request and the slides you checked look right.

Match the work to the request:
- "edit/fix/refine/add X to this slide" → ONE edit_slide on the CURRENT slide (the one the user is looking at). Touch no other slide.
- "add a slide about…" → add_slide(s) after the current slide.
- "make a deck about…" / "start over" → turn the current slides INTO the new deck: edit the existing slides in place and add/delete as needed (don't leave leftover placeholder slides).

## SURGICAL EDITS — the most important rule for edit_slide
edit_slide REPLACES the whole slide, so you must rebuild it. Reproduce the
existing slide's content and markup EXACTLY (same headline, subheading, body,
styles, notes — verbatim) and change ONLY what the user asked. Concretely:
- "add a circle" → keep everything as-is and ADD the circle. Do NOT touch the
  headline, subheading, colors, or layout.
- NEVER reword, restyle, recolor, or re-lay-out parts the user didn't mention.
- NEVER "harmonize" or copy content from another slide. Two slides sharing a
  headline is fine — leave them as the author wrote them.
- Only the CURRENT slide changes. Do not edit any other slide for consistency.
When unsure of the exact current markup, call read_deck and copy it verbatim before editing.

## Each slide is designed HTML on a ${cw}x${ch} canvas
- Wrap the slide's content in:
  \`<div style="position:absolute;inset:0;display:flex;flex-direction:column;${isDoc ? "padding:7% 9%" : "justify-content:center;padding:0 9%"};box-sizing:border-box"> ... </div>\`
- ALIGNMENT: do NOT put text-align / align-items on the wrapper — the slide
  inherits the brand's alignment by default (a guideline, kept consistent across
  the deck). Override it on a single slide ONLY when the layout needs it — e.g.
  left-align a slide with a chart even if the brand default is centered: add
  \`align-items:flex-start;text-align:left\` to that one wrapper.
- Style with the BRAND CSS VARIABLES (never hardcode brand colors/fonts):
  --brand-bg, --brand-text, --brand-heading, --brand-accent, --brand-muted,
  --brand-heading-size, --brand-subheading-size, --brand-body-size, --brand-radius,
  --r-heading-font (display font), --r-main-font (body font).
- SIZES: the brand defines three sizes — heading (h1), subheading (h2) and body.
  Plain \`<h1>\`, \`<h2>\`, \`<h3>\` and \`<p>\`/\`<li>\` already inherit the brand
  scale, so OMIT font-size on them. If you do set one, use the matching variable
  (\`var(--brand-heading-size)\`, \`var(--brand-subheading-size)\`,
  \`var(--brand-body-size)\`) — the canvas is a fixed ${cw}x${ch}, so never use vw/clamp.
  Set an explicit px size only for a deliberately special element (a big stat, a small caption).
  Example title: \`<h1 style="font-weight:700;color:var(--brand-heading)">...</h1>\` (size inherited)
  Use \`class="kicker"\` for a small uppercase accent eyebrow.
- BACKGROUND: do NOT set a per-slide background. Every slide sits on the brand
  canvas (--brand-bg) automatically, and that keeps the deck on-brand. ONLY add a
  \`<!-- .slide: data-background-color="#xxxxxx" -->\` first line if the user
  EXPLICITLY asks for a specific slide background, and even then prefer the
  brand's own bg/accent colors (from the tokens) over an arbitrary color. You may
  use data-background-image="assets/<name>" for a full-bleed image the user provided.
- Charts: to show data, add \`<div class="chart" style="height:380px" data-chart='{"type":"bar","labels":["Q1","Q2"],"data":[12,19]}'></div>\` — type is bar | line | donut. It renders as on-brand SVG automatically; do NOT add your own colors or styling inside it. Give the chart div a height (or flex:1 with min-height:0 inside a flex column).
- Infographics: for a PROCESS, TIMELINE, FUNNEL, PYRAMID, COMPARISON, ROADMAP or
  a labelled GRID of items, use an infographic instead of plain bullets. Write its
  declarative DSL inside a marked script; it renders to an on-brand SVG automatically:
  \`<div class="infographic" style="flex:1;min-height:0;margin-top:18px"><script type="text/x-infographic">
infographic <template-id>
data
  title <optional short title>
  lists
    - label <short label>
      desc <one concise line>
    - label <short label>
      desc <one concise line>
  </script></div>\`
  Pick a <template-id> that fits the idea. IMPORTANT: prefer the card/badge/node
  variants below — they render real visual cards. AVOID the bare "…-simple" list/
  grid/steps templates: they are TEXT-ONLY (no cards or shapes) and look like plain
  text, which is not what you want.
  • Process / steps → sequence-steps-badge-card, sequence-snake-steps-compact-card
  • Timeline / roadmap → sequence-timeline-rounded-rect-node, sequence-roadmap-vertical-badge-card
  • Funnel → sequence-funnel-simple;  Pyramid / hierarchy → sequence-pyramid-simple (these are shaped)
  • Grid of items → list-grid-badge-card, list-grid-compact-card, list-grid-ribbon-card,
    or list-grid-progress-card (progress needs a numeric value per item)
  • 2x2 / SWOT comparison → compare-swot
  • Cycle / relationship → relation-circle-icon-badge, relation-network-icon-badge
  Rules: ONE infographic per slide; give its div a height (flex:1;min-height:0 in a flex
  column); keep 3-6 items with short labels; do NOT style it yourself — it inherits the
  brand colors. Use a chart (above) for quantitative series, an infographic for concepts.
- Entrance animations (optional): add \`class="fragment fade-up"\` to elements that should animate in on click. Effects: fade-up, fade-down, fade-left, fade-right, zoom-in, grow. They play only while presenting.
- Images: reference files the user provides as \`assets/<name>\`. For an image slot the
  user will fill LATER (a client photo, a product shot), use the built-in placeholder
  \`<img src="assets/placeholder.svg" style="...">\` — it renders as a neutral photo box and
  clicking it (or any overlay covering it) in the editor swaps in a real image. For a
  hero-with-overlay (photo behind a gradient + caption): absolutely-position the img to
  fill a relative container, then layer a gradient div and the text above it.

## Speaker notes — ALWAYS write them
add_slide and edit_slide take a \`notes\` field: 1-3 sentences of speaker notes for
that slide (what the presenter should say / the point of the slide). These show in
the presenter view, never on the slide or in the PDF, and they are the slide's
memory — when refining a deck later, the notes tell you what each slide is for.

(Brand tokens, also available as the CSS variables above: ${JSON.stringify(tokens, null, 0)})

## Available layout templates (reuse these shapes for consistency)
${templates.map((t) => `- ${t.name}`).join("\n")}

## Critical
- Keep ONE idea per slide. Short, punchy copy. No code fences, no commentary in the slide markup.`;
}

// The tool loop. The model reads the brand and the deck, then mutates the deck
// one slide at a time through the DeckOps verbs; each verb persists + streams the
// change before the model continues.
export async function generate(env: AiEnv, input: GenInput, ops: DeckOps): Promise<void> {
  const tools = {
    read_brand_design: tool({
      description: "Read the active brand's full DESIGN.md — its voice, layout system, spacing and guidelines. Call this before writing slides.",
      inputSchema: z.object({}),
      execute: async () => input.designMd,
    }),
    read_deck: tool({
      description: "List the deck's current slides with their indices and speaker notes. Indices are 0-based and shift after add/delete — re-read if unsure.",
      inputSchema: z.object({}),
      execute: async () => listDeck(await ops.read()),
    }),
    add_slide: tool({
      description: "Add ONE new slide. Appends to the end, or inserts right after `after_index` if given. The slide appears immediately.",
      inputSchema: z.object({
        content: z.string().describe("The slide's designed HTML (the wrapper div and its contents). No code fences."),
        notes: z.string().describe("1-3 sentences of speaker notes for this slide."),
        after_index: z.number().int().optional().describe("Insert after this 0-based index; omit to append at the end."),
      }),
      execute: async ({ content, notes, after_index }) => {
        try {
          const i = await ops.add({ content: stripFence(content.trim()), notes: notes.trim() }, after_index);
          return `added as slide ${i}.`;
        } catch (e) {
          return `error: ${e instanceof Error ? e.message : String(e)}`;
        }
      },
    }),
    edit_slide: tool({
      description: "Replace the slide at `index` with new content + notes. This OVERWRITES the whole slide, so reproduce its existing content/markup VERBATIM and change ONLY what the user asked — don't reword, recolor, restyle or copy from other slides. Edit only the slide the user is looking at unless they name another.",
      inputSchema: z.object({
        index: z.number().int().describe("0-based index of the slide to replace."),
        content: z.string().describe("The slide's new designed HTML. No code fences."),
        notes: z.string().describe("1-3 sentences of speaker notes for this slide."),
      }),
      execute: async ({ index, content, notes }) => {
        try {
          await ops.edit(index, { content: stripFence(content.trim()), notes: notes.trim() });
          return `edited slide ${index}.`;
        } catch (e) {
          return `error: ${e instanceof Error ? e.message : String(e)}`;
        }
      },
    }),
    delete_slide: tool({
      description: "Delete the slide at `index`. Remaining slides shift down by one.",
      inputSchema: z.object({ index: z.number().int().describe("0-based index of the slide to delete.") }),
      execute: async ({ index }) => {
        try {
          await ops.remove(index);
          return `deleted slide ${index}.`;
        } catch (e) {
          return `error: ${e instanceof Error ? e.message : String(e)}`;
        }
      },
    }),
    view_slide: tool({
      description: "Render the slide at `index` to an image and SEE it, exactly as it will look. Use this to verify a slide you just wrote actually rendered well — check for overflow/cut-off text, overlap, off-brand colors, an empty chart/infographic, or bad spacing — then fix it with edit_slide if needed. Worth doing for charts, infographics and dense layouts.",
      inputSchema: z.object({ index: z.number().int().describe("0-based index of the slide to look at.") }),
      execute: async ({ index }) => {
        const png = await ops.renderPng(index);
        return png ?? "PREVIEW_UNAVAILABLE";
      },
      // Hand the PNG to the model as an image it can actually look at.
      toModelOutput: ({ output }) =>
        typeof output === "string" && output !== "PREVIEW_UNAVAILABLE" && output.length > 100
          ? { type: "content", value: [{ type: "media", data: output, mediaType: "image/png" }] }
          : { type: "content", value: [{ type: "text", text: "Slide preview unavailable (rendering not configured here) — continue without it." }] },
    }),
  };

  const deckInstructions = input.instructions?.trim()
    ? `DECK INSTRUCTIONS (the deck's agent.md — general guidance to ALWAYS follow for this deck: audience, tone, must-say points, do/don'ts):
${input.instructions.trim()}

`
    : "";

  await generateText({
    model: model(env),
    system: systemPrompt(input.tokens, input.templates, input.format, input.brandExamples, input.otherFormatExamples),
    prompt: `The user is currently looking at slide ${input.currentIndex ?? 0} (marked "← CURRENT SLIDE" below). When the request says "this slide", "the slide", or doesn't name a specific slide, act on slide ${input.currentIndex ?? 0} and no other — even if another slide has similar or identical text.

${deckInstructions}CURRENT DECK (index, notes, then the slide HTML):
${listDeck(input.deck, input.currentIndex)}

REQUEST:
${input.prompt}`,
    tools,
    stopWhen: stepCountIs(40),
    maxOutputTokens: 8000,
    temperature: 0.6,
  });
}

// Models sometimes wrap output in ```; strip a single outer fence if present.
function stripFence(s: string): string {
  const m = s.match(/^```[a-zA-Z]*\n([\s\S]*?)\n```$/);
  return (m ? m[1] : s).trim();
}

// ── Brand editing (multi-step agent loop) ───────────────────────────
// A brand is one DESIGN.md: prose guidance + a fenced clawnify-brand tokens
// block. The agent edits it through composable verbs — adjust tokens (the
// visual system) and rewrite the guidelines prose — and each verb persists +
// streams the brand so the preview updates live, mirroring the deck loop.

// A subset of token fields to patch; the ops layer deep-merges into the current
// tokens. Mirrors BrandTokens (all optional).
export interface BrandTokensPatch {
  colors?: Partial<BrandTokens["colors"]>;
  fonts?: Partial<BrandTokens["fonts"]>;
  sizes?: Partial<BrandTokens["sizes"]>;
  radius?: string;
  logoPosition?: BrandTokens["logoPosition"];
  textAlign?: BrandTokens["textAlign"];
}

export interface BrandOps {
  read(): Promise<string>; // current DESIGN.md (prose + tokens)
  updateTokens(patch: BrandTokensPatch): Promise<void>; // merge + persist + stream
  editGuidelines(oldStr: string, newStr: string): Promise<void>; // surgical prose replace
  writeGuidelines(markdown: string): Promise<void>; // full prose rewrite, keep tokens
  // Render the brand's CURRENT example slides for one format to PNGs (base64,
  // capped), so the loop can SEE its output and compare it to the original.
  // null = rendering unavailable (no managed token off-platform).
  renderExamples(formatId: string): Promise<string[] | null>;
}

// A brand's original source file (a reference asset), attached to the model as
// an image or a PDF document so brand edits are grounded in the real original.
export interface BrandReference {
  name: string;
  contentType: string;
  data: string; // base64
}

export async function editBrand(
  env: AiEnv,
  input: {
    instruction: string;
    currentMd: string;
    references?: BrandReference[];
    // Exact colors parsed from the original PDF's vector content — authoritative
    // over anything read off the (possibly color-shifted) rasterized images.
    paletteNote?: string;
  },
  ops: BrandOps,
): Promise<void> {
  const system = `You edit a brand design system for "OpenSlides" by calling small tools in a loop. A brand is a DESIGN.md: written guidelines (prose) plus a machine-readable token set that drives every slide's colors, fonts, sizes, logo and alignment.

## How you work
1. Call \`read_brand\` to see the current guidelines + tokens.
2. Apply the user's instruction with these verbs — each takes effect immediately, so the user watches the brand update live:
   - \`update_tokens\` — change the visual system / UI (any subset of: colors, fonts, sizes, radius, logoPosition, textAlign).
   - \`edit_guidelines\` — SURGICALLY edit the written guidelines: replace an exact snippet of prose with new text. Prefer this for targeted wording/section changes — copy the exact text from read_brand. (Don't use it on token values; use update_tokens for those.)
   - \`write_guidelines\` — replace the WHOLE guidelines prose. Use only for a big restructure or when there's no prose yet.
3. Stop when the brand reflects the instruction.

Keep visuals and prose IN SYNC: when the instruction implies a visual change ("darker", "more playful", "serif display", "vibrant accent"), update_tokens AND write_guidelines — never change only the prose. "Darker" → lower bg/text lightness + note it in the voice; "playful" → rounder radius, brighter accent; "serif display" → fonts.heading + the matching google spec + mention it in Typography.

## Token rules
- colors are hex ("#1A1814"). The five roles: bg (canvas), text (body ink), heading, accent (one emphasis color), muted.
- fonts.heading/body/mono are family names. For a Google font, set the family AND add its spec to fonts.google (e.g. "Playfair+Display:wght@500;700"); for a system font use a stack like "Georgia, serif" and drop it from google.
- sizes.heading / sizes.subheading / sizes.body are px numbers from 12 to 100 (h1, h2 and body text scale).
- textAlign is "left" or "center" (applies deck-wide). radius is a CSS length ("14px").
- Keep the guidelines a real design system (sections + voice), not just a token dump. Always keep an "Example slides" section with AT LEAST THREE concrete example slides (HTML using the brand variables) — they show the system in practice and ground slide generation.
- Example slides may target a page format: a "### <name> (<format-id>)" sub-heading tags its examples — e.g. "### Cover (a4-portrait)" for A4 document pages (1240x1754 canvas, top-down, padding:7% 9%); untagged examples are 16:9 slides (1280x720, vertically centered). New decks seeded from the brand start from the examples matching their format, so when the brand replicates a DOCUMENT template, author its page layouts as (a4-portrait)-tagged examples.

## REPLICATION MODE — when original source files are attached
If the brand's ORIGINAL files are attached (images/PDF of the document this brand replicates) and the instruction asks to create/replicate the brand from them, this is a REPLICATION, and the bar is "a page from this brand is mistakable for a page of the original":
1. GROUND everything in the original: extract its real colors (sample the exact hexes you see), font roles (serif/sans display vs body), spacing and page structures. Do not invent a generic look.
2. REPLACE the ENTIRE "## Example slides" section (write_guidelines) — never keep the default/generic examples. Author ONE example per distinctive page type of the original (cover, content/card page, data page, back cover…), tagged with the format matching the original's page shape (an A4 portrait document → "(a4-portrait)").
2b. PHOTO AREAS: wherever the original has a photo or a photo placeholder (a hero image, a full-bleed back cover), author a REAL image slot — \`<img src="assets/placeholder.svg">\` absolutely filling a relative container, with the original's gradient/scrim and text layered above it — never a plain CSS-gradient div. The placeholder renders as a neutral photo box and the user clicks it to drop in the client's photo.
3. SIZE CONVERSION — the #1 replication mistake. Token sizes and example px are in CANVAS px, and the A4 canvas (1240 wide) is larger than a real A4 page: 1pt in the original ≈ 2.1 canvas px (1px at 96dpi ≈ 1.56 canvas px). So a 10pt body → sizes.body ≈ 21; a 24pt title → ≈ 50. NEVER set sizes.body below 18 for a document brand — 12-14 renders unreadably small.
4. MEASURE, don't eyeball, when authoring: the A4 canvas is 1240x1754 ≈ 210x297mm, so 1mm ≈ 5.9px and 1pt ≈ 2.1px. Read margins, band heights, gaps and type sizes off the original and convert.
5. VERIFY WITH YOUR EYES — the loop that gets you to pixel-perfect: after writing the examples, call view_examples for the format and COMPARE each render against the attached original page by page — layout, proportions, type scale, colors, weights, spacing. Fix every visible mismatch (edit_guidelines / update_tokens) and view again. Repeat until a rendered example is mistakable for the original page. Do not stop while anything is visibly off.`;

  const tools = {
    read_brand: tool({
      description: "Read the current brand DESIGN.md — its written guidelines and token values.",
      inputSchema: z.object({}),
      execute: async () => ops.read(),
    }),
    update_tokens: tool({
      description: "Change the visual tokens. Pass only the fields you want to change; the rest are kept. Applies immediately.",
      inputSchema: z.object({
        colors: z.object({
          bg: z.string().optional(), text: z.string().optional(), heading: z.string().optional(),
          accent: z.string().optional(), muted: z.string().optional(),
        }).optional(),
        fonts: z.object({
          heading: z.string().optional(), body: z.string().optional(), mono: z.string().optional(),
          google: z.array(z.string()).optional(),
        }).optional(),
        sizes: z.object({ heading: z.number().optional(), subheading: z.number().optional(), body: z.number().optional() }).optional(),
        radius: z.string().optional(),
        logoPosition: z.enum(["top-left", "top-right", "bottom-left", "bottom-right"]).optional(),
        textAlign: z.enum(["left", "center"]).optional(),
      }),
      execute: async (patch) => {
        try { await ops.updateTokens(patch); return "tokens updated."; }
        catch (e) { return `error: ${e instanceof Error ? e.message : String(e)}`; }
      },
    }),
    edit_guidelines: tool({
      description: "Surgically edit the written guidelines: replace one exact snippet of existing prose with new text. Copy old_str verbatim from read_brand (include enough context to be unique).",
      inputSchema: z.object({
        old_str: z.string().describe("The exact existing prose to replace (must match verbatim and be unique)."),
        new_str: z.string().describe("The replacement text."),
      }),
      execute: async ({ old_str, new_str }) => {
        try { await ops.editGuidelines(old_str, new_str); return "guidelines edited."; }
        catch (e) { return `error: ${e instanceof Error ? e.message : String(e)}`; }
      },
    }),
    write_guidelines: tool({
      description: "Replace the ENTIRE written guidelines prose (around the tokens). Use only for a big restructure or initial authoring; prefer edit_guidelines for targeted changes. Keep it a real design system: overview, type, color and layout guidance + voice.",
      inputSchema: z.object({ markdown: z.string().describe("The full guidelines markdown (no tokens block, no code fences).") }),
      execute: async ({ markdown }) => {
        try { await ops.writeGuidelines(stripFence(markdown.trim())); return "guidelines rewritten."; }
        catch (e) { return `error: ${e instanceof Error ? e.message : String(e)}`; }
      },
    }),
    view_examples: tool({
      description: "Render the brand's CURRENT example slides for a page format to images and SEE them exactly as they'll look. Use after writing/editing examples to compare against the attached original and catch wrong scale, spacing, colors or layout — then fix and view again.",
      inputSchema: z.object({
        format: z.string().describe("Page format id of the examples to render: '16:9' or 'a4-portrait'."),
      }),
      execute: async ({ format }) => {
        try {
          const pngs = await ops.renderExamples(format);
          if (pngs === null) return "PREVIEW_UNAVAILABLE";
          if (!pngs.length) return `no example slides tagged (${format}) — nothing to render.`;
          return JSON.stringify(pngs);
        } catch (e) {
          return `error: ${e instanceof Error ? e.message : String(e)}`;
        }
      },
      // Hand the PNGs to the model as images it can actually look at.
      toModelOutput: ({ output }) => {
        if (typeof output !== "string") return { type: "content", value: [{ type: "text", text: String(output) }] };
        if (output === "PREVIEW_UNAVAILABLE") {
          return { type: "content", value: [{ type: "text", text: "Example rendering unavailable here — continue without it." }] };
        }
        try {
          const pngs = JSON.parse(output) as string[];
          if (Array.isArray(pngs) && pngs.length && typeof pngs[0] === "string" && pngs[0].length > 100) {
            return {
              type: "content",
              value: pngs.map((p, i) => [
                { type: "text" as const, text: `Example ${i + 1}:` },
                { type: "media" as const, data: p, mediaType: "image/jpeg" },
              ]).flat(),
            };
          }
        } catch { /* not a PNG list — fall through to text */ }
        return { type: "content", value: [{ type: "text", text: output }] };
      },
    }),
  };

  // Attach the brand's original source files so the model can SEE what it is
  // replicating: images as vision parts, PDFs as document parts (Claude ingests
  // both natively).
  const parts: Array<
    | { type: "text"; text: string }
    | { type: "image"; image: string; mediaType?: string }
    | { type: "file"; data: string; mediaType: string; filename?: string }
  > = [];
  for (const r of input.references ?? []) {
    if (r.contentType.startsWith("image/")) parts.push({ type: "image", image: r.data, mediaType: r.contentType });
    else if (r.contentType === "application/pdf") parts.push({ type: "file", data: r.data, mediaType: r.contentType, filename: r.name });
  }
  const paletteNote = input.paletteNote
    ? `EXACT COLORS of the original, parsed from its PDF vector content (ranked by use — these are AUTHORITATIVE; the rasterized page images can color-shift gradients/photos, so when an image disagrees with this list, the list wins):\n${input.paletteNote}\n\n`
    : "";
  const refNote = parts.length
    ? `ATTACHED: ${parts.length} original source file(s)/page image(s) this brand replicates (${(input.references ?? []).map((r) => r.name).join(", ")}). Ground the design in them — use the images for LAYOUT, PROPORTION and TYPE SCALE; use the parsed color list (below, when present) for COLOR.\n\n${paletteNote}`
    : "";
  parts.push({ type: "text", text: `${refNote}CURRENT BRAND:\n${input.currentMd}\n\nINSTRUCTION:\n${input.instruction}` });

  await generateText({
    model: model(env),
    system,
    messages: [{ role: "user", content: parts }],
    tools,
    // Replication runs a write → view → fix loop over several examples, so give
    // it real room: enough steps to iterate and enough tokens for full-page HTML.
    stopWhen: stepCountIs(48),
    maxOutputTokens: 16000,
    temperature: 0.6,
  });
}
