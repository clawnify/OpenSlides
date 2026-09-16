import { createApp } from "@clawnify/app";
import { query, get, run } from "./db";
import {
  initUploads,
  putUpload,
  getUpload,
  getUploadBytes,
  deleteUpload,
  makeKey,
  PLACEHOLDER_KEY,
} from "./uploads";
import { revealDoc, revealViewScript } from "./reveal";
import { renderDeckPdf, renderSlidePng, renderSlidePngLink, PdfRenderError } from "./pdf";
import { parseTokens, brandHead, brandLogoTag, brandGuideHtml, extractExampleSlides, extractBrandExamples, setTokensInMd, DEFAULT_BRAND_MD, type BrandTokens } from "./brand";
import { TEMPLATES, templatesFor } from "./templates";
import { FORMATS, DEFAULT_FORMAT_ID, safeFormat, type PageFormat } from "./formats";
import { generate, editBrand, hasAiKey, type DeckOps, type DeckSlide, type AuthoredSlide, type BrandOps, type BrandTokensPatch } from "./ai";
import { bakeInfographics } from "./infographic";

type Bindings = {
  DB: D1Database;
  UPLOADS: R2Bucket;
  // Injected into every WfP app at deploy time; authorizes managed services
  // (here: the PDF render service). Absent in local dev unless set in .dev.vars.
  CLAWNIFY_TOKEN?: string;
  // LLM keys for natural-language generation. OPENROUTER_API_KEY is the platform
  // standard (injected in prod); ANTHROPIC_API_KEY is supported as BYOK and wins
  // when both are present.
  OPENROUTER_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
};

// createApp bakes in OpenAPIHono construction, the per-request initDB
// middleware and /api/openapi.json + /llms.txt discovery. Uploads (R2) init is
// app-specific, so that middleware stays ours.
const app = createApp<{ Bindings: Bindings }>({
  title: "OpenSlides",
  version: "1.0.0",
  description:
    "Agent-friendly slide decks and A4 documents: designed HTML pages styled by a shared brand, presented in the browser and exported to PDF.",
});

app.use("/api/*", async (c, next) => {
  initUploads(c.env.UPLOADS);
  await next();
});

app.onError((err, c) => {
  console.error(err);
  return c.json({ error: err.message || String(err) }, 500);
});

// ── Decks ────────────────────────────────────────────────────────────

interface Deck {
  id: string;
  title: string;
  content: string;
  theme: string;
  nav: string;
  brand_id: string | null;
  format: string; // page format id ('16:9' | 'a4-portrait') — see formats.ts
  instructions: string; // deck-level agent.md (general guidance the AI follows)
  created_at: string;
  updated_at: string;
}

// Pagination is a single mutually-exclusive choice.
type NavMode = "dots" | "arrows" | "numbers" | "none";
interface Nav { mode: NavMode }
const DEFAULT_NAV: Nav = { mode: "dots" }; // centered dots by default
const NAV_MODES: NavMode[] = ["dots", "arrows", "numbers", "none"];

// Tolerate the legacy {arrows,progress,slideNumber,dots} shape by collapsing it
// to a single mode (decks created before pagination became one choice).
function parseNav(s: string | undefined): Nav {
  try {
    const o = s ? JSON.parse(s) : {};
    if (typeof o.mode === "string" && NAV_MODES.includes(o.mode)) return { mode: o.mode };
    if (o.dots) return { mode: "dots" };
    if (o.arrows || o.progress) return { mode: "arrows" };
    if (o.slideNumber) return { mode: "numbers" };
    if (Object.keys(o).length) return { mode: "none" };
    return { ...DEFAULT_NAV };
  } catch {
    return { ...DEFAULT_NAV };
  }
}

app.get("/api/decks", async (c) => {
  const rows = await query<Deck>("SELECT * FROM decks ORDER BY updated_at DESC");
  return c.json(rows);
});

app.get("/api/decks/:id", async (c) => {
  const row = await get<Deck>("SELECT * FROM decks WHERE id = ?", [c.req.param("id")]);
  if (!row) return c.json({ error: "Not found" }, 404);
  return c.json(row);
});

app.post("/api/decks", async (c) => {
  const b = await c.req.json<Partial<Deck> & { seed_from_brand?: boolean }>();
  if (!b.title?.trim()) return c.json({ error: "title is required" }, 400);
  const format = b.format && FORMATS[b.format] ? b.format : DEFAULT_FORMAT_ID;
  // "Use for new slides" seeds the deck from the brand's own example slides — the
  // ones tagged for THIS deck's format (untagged = 16:9) — so it starts on-brand
  // with real layouts; falls back to whatever content was sent.
  let content = b.content ?? "";
  if (b.seed_from_brand && b.brand_id) {
    const examples = extractExampleSlides(await brandMdFor(b.brand_id), format);
    if (examples.length) content = examples.join("\n\n---\n\n");
  }
  const res = await run(
    "INSERT INTO decks (title, content, theme, brand_id, format, nav, instructions) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [b.title.trim(), content, b.theme ?? "black", b.brand_id ?? null, format, JSON.stringify(DEFAULT_NAV), b.instructions ?? ""],
  );
  const row = await get<Deck>("SELECT * FROM decks WHERE rowid = ?", [res.lastInsertRowid]);
  return c.json(row, 201);
});

app.put("/api/decks/:id", async (c) => {
  const id = c.req.param("id");
  const existing = await get<Deck>("SELECT * FROM decks WHERE id = ?", [id]);
  if (!existing) return c.json({ error: "Not found" }, 404);
  const b = await c.req.json<Partial<Deck>>();
  await run(
    `UPDATE decks SET title = ?, content = ?, theme = ?, nav = ?, brand_id = ?, instructions = ?, updated_at = datetime('now') WHERE id = ?`,
    [b.title ?? existing.title, b.content ?? existing.content, b.theme ?? existing.theme, b.nav ?? existing.nav, b.brand_id ?? existing.brand_id, b.instructions ?? existing.instructions, id],
  );
  const row = await get<Deck>("SELECT * FROM decks WHERE id = ?", [id]);
  scheduleSweep(c); // a media reference may have just been removed
  return c.json(row);
});

app.delete("/api/decks/:id", async (c) => {
  await run("DELETE FROM decks WHERE id = ?", [c.req.param("id")]);
  scheduleSweep(c);
  return c.json({ ok: true });
});

// Only validated renderer options enter this script; authored slide HTML never does.
app.get("/api/view-script.js", (c) => c.body(revealViewScript({
  format: safeFormat(c.req.query("format")),
  thumb: c.req.query("thumb") === "1",
  nav: parseNav(JSON.stringify({ mode: c.req.query("nav") })),
}), 200, { "Content-Type": "application/javascript; charset=utf-8" }));

// Interactive reveal.js deck — loaded by the editor's preview iframe and
// fullscreened for in-app presenting. ?h=&v= restores the current slide.
app.get("/api/decks/:id/view", async (c) => {
  const row = await get<Deck>("SELECT content, theme, nav, brand_id, format FROM decks WHERE id = ?", [c.req.param("id")]);
  if (!row) return c.text("Not found", 404);
  const h = parseInt(c.req.query("h") || "0", 10) || 0;
  const v = parseInt(c.req.query("v") || "0", 10) || 0;
  const onlyRaw = c.req.query("only");
  const only = onlyRaw != null ? parseInt(onlyRaw, 10) : undefined;
  const thumb = c.req.query("thumb") === "1";
  const tokens = parseTokens(await brandMdFor(row.brand_id));
  // Render any infographic DSL → brand-themed SVG before serving.
  const baked = await bakeInfographics(row.content, { colorPrimary: tokens.colors.accent, colorBg: tokens.colors.bg });
  return c.html(
    revealDoc({
      mode: "view",
      content: rewriteAssetsForView(baked),
      theme: row.theme,
      format: safeFormat(row.format),
      brandHeadHtml: brandHead(tokens),
      brandLogoHtml: thumb ? "" : brandLogoTag(resolveLogoForView(tokens.logo)),
      h,
      v,
      only: Number.isFinite(only) ? only : undefined,
      thumb,
      nav: thumb ? { mode: "none" } : parseNav(row.nav),
    }),
  );
});

// Natural-language slide generation as a live agent loop. The model drives the
// deck through composable verbs (add/edit/delete slide); each verb persists the
// deck and streams the change to the client over Server-Sent Events, so slides
// appear one at a time while the agent keeps working.
//
// SSE events (one JSON object per `data:` frame):
//   { type: "slide", sel, total, content }  — deck changed; `sel` = focus index
//   { type: "done",  total, content }
//   { type: "error", error }
app.post("/api/decks/:id/generate", async (c) => {
  const id = c.req.param("id");
  const deck = await get<Deck>("SELECT * FROM decks WHERE id = ?", [id]);
  if (!deck) return c.json({ error: "Not found" }, 404);
  const b = await c.req.json<{ prompt?: string; current_index?: number }>();
  if (!b.prompt?.trim()) return c.json({ error: "prompt is required" }, 400);
  if (!hasAiKey(c.env)) {
    return c.json({ error: "AI generation isn't configured (set ANTHROPIC_API_KEY or OPENROUTER_API_KEY)." }, 503);
  }

  const designMd = await brandMdFor(deck.brand_id);
  const format = safeFormat(deck.format);
  const chunks = splitDeck(deck.content);
  const snapshot = (): DeckSlide[] => chunks.map((ch, i) => ({ index: i, ...extractNotes(ch) }));

  const enc = new TextEncoder();
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  // Best-effort: if the SSE client disconnects (tab closed, proxy timeout),
  // write() rejects — swallow it so the agent loop keeps running and persisting;
  // the deck/brand is the durable output, the stream is just a live view.
  const send = (obj: unknown) => writer.write(enc.encode(`data: ${JSON.stringify(obj)}\n\n`)).catch(() => {});

  const persist = async (sel: number) => {
    const content = joinDeck(chunks);
    await run("UPDATE decks SET content = ?, updated_at = datetime('now') WHERE id = ?", [content, id]);
    await send({ type: "slide", sel, total: chunks.length, content });
  };

  const ops: DeckOps = {
    read: async () => snapshot(),
    add: async (slide, afterIndex) => {
      const at = afterIndex == null || afterIndex < 0 || afterIndex >= chunks.length ? chunks.length : afterIndex + 1;
      chunks.splice(at, 0, assembleChunk(slide));
      await persist(at);
      return at;
    },
    edit: async (index, slide) => {
      if (index < 0 || index >= chunks.length) throw new Error(`no slide at index ${index} (deck has ${chunks.length})`);
      chunks[index] = assembleChunk(slide);
      await persist(index);
    },
    remove: async (index) => {
      if (index < 0 || index >= chunks.length) throw new Error(`no slide at index ${index} (deck has ${chunks.length})`);
      chunks.splice(index, 1);
      await persist(Math.max(0, index - 1));
    },
    renderPng: async (index) => {
      if (!c.env.CLAWNIFY_TOKEN) return null; // no managed render off-platform
      if (index < 0 || index >= chunks.length) return null;
      try {
        const html = await slidePrintHtml(chunks[index], deck.theme, parseTokens(designMd), format);
        return arrayBufferToBase64(await renderSlidePng(c.env.CLAWNIFY_TOKEN, html, format.page));
      } catch (e) {
        console.error("view_slide render failed", e);
        return null;
      }
    },
  };

  // Drive the loop in the background; the streamed response keeps the worker
  // alive until we close the writer, and waitUntil guards against early teardown.
  const run$ = (async () => {
    try {
      await generate(
        c.env,
        {
          prompt: b.prompt!.trim(),
          tokens: parseTokens(designMd),
          designMd,
          format,
          // The brand's layouts for this format (copy-first grounding), and its
          // other-format layouts as visual-language reference when none match.
          brandExamples: extractExampleSlides(designMd, format.id),
          otherFormatExamples: extractBrandExamples(designMd)
            .filter((e) => e.format !== format.id)
            .map((e) => e.html),
          templates: templatesFor(format),
          currentIndex: b.current_index ?? 0,
          deck: snapshot(),
          instructions: deck.instructions || "",
        },
        ops,
      );
      await send({ type: "done", total: chunks.length, content: joinDeck(chunks) });
    } catch (err) {
      await send({ type: "error", error: String(err instanceof Error ? err.message : err) });
    } finally {
      scheduleSweep(c); // a deck rewrite may have dropped a media reference
      await writer.close().catch(() => {});
    }
  })();
  try { c.executionCtx?.waitUntil(run$); } catch { /* no execution ctx in some dev paths */ }

  return new Response(readable, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    },
  });
});

// ── Brand library (each deck picks one) ──────────────────────────────

interface Brand {
  id: string;
  name: string;
  design_md: string;
  created_at: string;
  updated_at: string;
}

// Always keep at least one brand; seed "Default" on first use.
async function ensureBrands(): Promise<Brand[]> {
  let rows = await query<Brand>("SELECT * FROM brands ORDER BY created_at ASC");
  if (rows.length === 0) {
    await run("INSERT INTO brands (name, design_md) VALUES (?, ?)", ["Default", DEFAULT_BRAND_MD]);
    rows = await query<Brand>("SELECT * FROM brands ORDER BY created_at ASC");
  }
  return rows;
}
// The DESIGN.md a deck renders with (its brand, or the first/default brand).
async function brandMdFor(brandId: string | null | undefined): Promise<string> {
  const rows = await ensureBrands();
  const b = (brandId && rows.find((r) => r.id === brandId)) || rows[0];
  return b.design_md || DEFAULT_BRAND_MD;
}

app.get("/api/brands", async (c) => {
  const rows = await ensureBrands();
  return c.json(rows.map((r) => ({ id: r.id, name: r.name, tokens: parseTokens(r.design_md) })));
});

app.get("/api/brands/:id", async (c) => {
  const row = await get<Brand>("SELECT * FROM brands WHERE id = ?", [c.req.param("id")]);
  if (!row) return c.json({ error: "Not found" }, 404);
  // The brand's original source files (role='reference') — shown in the editor
  // and readable by agents replicating/refining the brand.
  const references = await query<Asset>(
    "SELECT * FROM assets WHERE role = 'reference' AND brand_id = ? ORDER BY created_at ASC",
    [row.id],
  );
  return c.json({ id: row.id, name: row.name, design_md: row.design_md, tokens: parseTokens(row.design_md), references });
});

app.post("/api/brands", async (c) => {
  const b = await c.req.json<{ name?: string; design_md?: string }>();
  const res = await run("INSERT INTO brands (name, design_md) VALUES (?, ?)", [b.name?.trim() || "New brand", b.design_md || DEFAULT_BRAND_MD]);
  const row = await get<Brand>("SELECT * FROM brands WHERE rowid = ?", [res.lastInsertRowid]);
  return c.json(row, 201);
});

app.put("/api/brands/:id", async (c) => {
  const id = c.req.param("id");
  const existing = await get<Brand>("SELECT * FROM brands WHERE id = ?", [id]);
  if (!existing) return c.json({ error: "Not found" }, 404);
  const b = await c.req.json<{ name?: string; design_md?: string; tokens?: BrandTokens }>();
  // Visual inspector sends tokens (written into the md block); editors send md.
  const nextMd = b.tokens ? setTokensInMd(existing.design_md, b.tokens) : (b.design_md ?? existing.design_md);
  await run("UPDATE brands SET name = ?, design_md = ?, updated_at = datetime('now') WHERE id = ?", [b.name ?? existing.name, nextMd, id]);
  const row = await get<Brand>("SELECT * FROM brands WHERE id = ?", [id]);
  scheduleSweep(c); // the logo may have been changed or cleared
  return c.json({ id: row!.id, name: row!.name, design_md: row!.design_md, tokens: parseTokens(row!.design_md) });
});

app.delete("/api/brands/:id", async (c) => {
  const id = c.req.param("id");
  // Reference originals (and their derived page images) live exactly as long
  // as their brand.
  for (const a of await query<Asset>("SELECT * FROM assets WHERE role IN ('reference', 'reference-page') AND brand_id = ?", [id])) {
    await deleteUpload(a.key);
    await run("DELETE FROM assets WHERE id = ?", [a.id]);
  }
  await run("DELETE FROM brands WHERE id = ?", [id]);
  await ensureBrands(); // never leave the library empty
  scheduleSweep(c);
  return c.json({ ok: true });
});

// Edit a brand by natural-language instruction — a live agent loop. The model
// adjusts tokens and rewrites the guidelines through composable verbs; each
// change persists and streams over SSE so the brand preview updates live.
//
// SSE events: { type: "brand", design_md, tokens } | { type: "done" } | { type: "error", error }
app.post("/api/brands/:id/generate", async (c) => {
  const id = c.req.param("id");
  const existing = await get<Brand>("SELECT * FROM brands WHERE id = ?", [id]);
  if (!existing) return c.json({ error: "Not found" }, 404);
  const { instruction } = await c.req.json<{ instruction?: string }>();
  if (!instruction?.trim()) return c.json({ error: "instruction is required" }, 400);
  if (!hasAiKey(c.env)) return c.json({ error: "AI isn't configured (set ANTHROPIC_API_KEY or OPENROUTER_API_KEY)." }, 503);

  let md = existing.design_md || DEFAULT_BRAND_MD;

  // The brand's original source files are attached to the model, so "based on
  // the original file" instructions are grounded in the actual file, not a
  // guess. For a PDF original, attach its derived PAGE IMAGES (small, and a
  // PDF part + tool-result images in one conversation trips a provider bug);
  // fall back to the PDF itself only if no pages were derived. Image originals
  // attach directly. Bounded like inlineAssets.
  const refRows = await query<Asset>(
    "SELECT * FROM assets WHERE role = 'reference' AND brand_id = ? ORDER BY created_at ASC",
    [id],
  );
  const references: { name: string; contentType: string; data: string }[] = [];
  const paletteLines: string[] = [];
  for (const r of refRows.slice(0, 4)) {
    if (references.length >= 10) break;
    const pages = await query<Asset>(
      "SELECT * FROM assets WHERE role = 'reference-page' AND key LIKE ? ORDER BY key ASC",
      [`${r.key}.page-%`],
    );
    if (r.content_type === "application/pdf") {
      // Exact vector colors from the file itself — authoritative over any raster.
      try {
        const obj = await getUploadBytes(r.key);
        if (obj) {
          const palette = await extractPdfPalette(obj.data);
          if (palette.length) paletteLines.push(`${r.name}: ${palette.join(", ")}`);
        }
      } catch (e) {
        console.error("pdf palette extraction failed", e);
      }
    }
    const rows = pages.length ? pages : [r];
    for (const p of rows) {
      if (references.length >= 10) break;
      const obj = await getUploadBytes(p.key);
      if (!obj || obj.data.byteLength > 8 * 1024 * 1024) continue;
      references.push({ name: p.name, contentType: obj.contentType, data: arrayBufferToBase64(obj.data) });
    }
  }

  const enc = new TextEncoder();
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  // Best-effort: if the SSE client disconnects (tab closed, proxy timeout),
  // write() rejects — swallow it so the agent loop keeps running and persisting;
  // the deck/brand is the durable output, the stream is just a live view.
  const send = (obj: unknown) => writer.write(enc.encode(`data: ${JSON.stringify(obj)}\n\n`)).catch(() => {});

  const persist = async () => {
    await run("UPDATE brands SET design_md = ?, updated_at = datetime('now') WHERE id = ?", [md, id]);
    await send({ type: "brand", design_md: md, tokens: parseTokens(md) });
  };

  const ops: BrandOps = {
    read: async () => md,
    updateTokens: async (patch: BrandTokensPatch) => {
      const cur = parseTokens(md);
      const merged: BrandTokens = {
        ...cur,
        ...(patch.radius !== undefined ? { radius: patch.radius } : {}),
        ...(patch.logoPosition !== undefined ? { logoPosition: patch.logoPosition } : {}),
        ...(patch.textAlign !== undefined ? { textAlign: patch.textAlign } : {}),
        colors: { ...cur.colors, ...(patch.colors || {}) },
        fonts: { ...cur.fonts, ...(patch.fonts || {}) },
        sizes: { ...cur.sizes, ...(patch.sizes || {}) },
      };
      md = setTokensInMd(md, merged);
      await persist();
    },
    editGuidelines: async (oldStr: string, newStr: string) => {
      // Surgical prose edit: replace one exact snippet. Guard the tokens block so
      // a prose edit can never corrupt the JSON (visual changes go via updateTokens).
      const block = md.match(/```[a-zA-Z]*\s*clawnify-brand[\s\S]*?```/)?.[0] ?? "";
      if (block && block.includes(oldStr)) throw new Error("that text is in the tokens block — use update_tokens for token/visual changes");
      const idx = md.indexOf(oldStr);
      if (idx === -1) throw new Error("text not found — read_brand and copy the exact snippet to replace");
      if (md.indexOf(oldStr, idx + oldStr.length) !== -1) throw new Error("that text appears more than once — include more surrounding context to make it unique");
      md = md.slice(0, idx) + newStr + md.slice(idx + oldStr.length);
      await persist();
    },
    writeGuidelines: async (markdown: string) => {
      md = setTokensInMd(markdown, parseTokens(md)); // new prose, keep current tokens
      await persist();
    },
    // Render the brand's current example slides for one format so the agent can
    // SEE its output and compare it against the attached original (the loop that
    // gets replication to pixel-perfect).
    renderExamples: async (formatId: string) => {
      if (!c.env.CLAWNIFY_TOKEN) return null; // no managed render off-platform
      const fmt = safeFormat(formatId);
      const tokens = parseTokens(md);
      const out: string[] = [];
      // JPEG + a cap of 3: these images ride the model conversation alongside the
      // attached original on EVERY step, so keep them light or the provider
      // rejects the growing payload.
      for (const ex of extractExampleSlides(md, fmt.id).slice(0, 3)) {
        try {
          const html = await slidePrintHtml(ex, "white", tokens, fmt);
          out.push(arrayBufferToBase64(await renderSlidePng(c.env.CLAWNIFY_TOKEN, html, fmt.page, { type: "jpeg", quality: 60 })));
        } catch (e) {
          console.error("view_examples render failed", e);
        }
      }
      return out;
    },
  };

  const run$ = (async () => {
    try {
      await editBrand(c.env, {
        instruction: instruction.trim(),
        currentMd: md,
        references,
        paletteNote: paletteLines.length ? paletteLines.join("\n") : undefined,
      }, ops);
      await send({ type: "done" });
    } catch (err) {
      await send({ type: "error", error: String(err instanceof Error ? err.message : err) });
    } finally {
      scheduleSweep(c); // the logo reference may have changed
      await writer.close().catch(() => {});
    }
  })();
  try { c.executionCtx?.waitUntil(run$); } catch { /* no execution ctx in some dev paths */ }

  return new Response(readable, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" },
  });
});

// Full visual preview of a brand: a guidelines page (example slides + color
// palette + type scale) rendered with the brand's own tokens & fonts.
app.get("/api/brands/:id/preview", async (c) => {
  const row = await get<Brand>("SELECT * FROM brands WHERE id = ?", [c.req.param("id")]);
  const md = row?.design_md || DEFAULT_BRAND_MD;
  const tokens = parseTokens(md);
  // The preview renders the DESIGN.md's own example slides (every format, each on
  // its own canvas) — bake infographics and point media at the served route so
  // they look exactly like real slides.
  const theme = { colorPrimary: tokens.colors.accent, colorBg: tokens.colors.bg };
  const examples = await Promise.all(
    extractBrandExamples(md).map(async (ex) => ({ ...ex, html: rewriteAssetsForView(await bakeInfographics(ex.html, theme)) })),
  );
  return c.html(brandGuideHtml(row?.name || "Brand", tokens, resolveLogoForView(tokens.logo), examples));
});

// Designed, on-brand slide templates the client inserts into a deck.
// ?format=a4-portrait returns the document page set; default is the 16:9 set.
app.get("/api/templates", (c) => {
  const fmt = c.req.query("format");
  return c.json(fmt ? templatesFor(safeFormat(fmt)) : TEMPLATES);
});

// The available page formats (id, label, canvas) — the client's new-deck menu
// and the agent both read these instead of hardcoding sizes.
app.get("/api/formats", (c) =>
  c.json(Object.values(FORMATS).map((f) => ({ id: f.id, label: f.label, kind: f.kind, canvas: f.canvas }))));

// Export the deck to PDF (one slide per page) via the managed PDF service.
app.get("/api/decks/:id/pdf", async (c) => {
  const row = await get<Deck>("SELECT * FROM decks WHERE id = ?", [c.req.param("id")]);
  if (!row) return c.json({ error: "Not found" }, 404);
  if (!c.env.CLAWNIFY_TOKEN) {
    return c.json(
      { error: "PDF export not configured (missing CLAWNIFY_TOKEN). Export runs on deployed apps." },
      503,
    );
  }

  // The headless renderer can't reach the app's authenticated /api/uploads
  // route, so inline any referenced media (and the logo) as data: URIs.
  const tokens = parseTokens(await brandMdFor(row.brand_id));
  const format = safeFormat(row.format);
  const baked = await bakeInfographics(row.content, { colorPrimary: tokens.colors.accent, colorBg: tokens.colors.bg });
  const content = await inlineAssets(baked);
  const html = revealDoc({
    mode: "print",
    content,
    theme: row.theme,
    format,
    brandHeadHtml: brandHead(tokens),
    brandLogoHtml: brandLogoTag(await resolveLogoForPrint(tokens.logo)),
    nav: parseNav(row.nav), // print uses only nav.slideNumber (arrows/progress are present-only)
  });

  try {
    const pdf = await renderDeckPdf(c.env.CLAWNIFY_TOKEN, html, format.page);
    const filename = `${makeKey(row.title)}.pdf`;
    return new Response(pdf, {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${filename}"`,
      },
    });
  } catch (err) {
    const detail = err instanceof PdfRenderError ? err.detail || err.message : String(err);
    return c.json({ error: "pdf_render_failed", detail }, 502);
  }
});

// Build the print HTML for ONE slide (infographics baked, media inlined, no page
// chrome) — shared by the slide-PNG endpoint and the agent's view_slide tool.
async function slidePrintHtml(slideChunk: string, theme: string, tokens: BrandTokens, format: PageFormat): Promise<string> {
  let content = await bakeInfographics(slideChunk, { colorPrimary: tokens.colors.accent, colorBg: tokens.colors.bg });
  content = await inlineAssets(content);
  return revealDoc({
    mode: "print",
    content,
    theme,
    format,
    brandHeadHtml: brandHead(tokens),
    brandLogoHtml: brandLogoTag(await resolveLogoForPrint(tokens.logo)),
    nav: { mode: "none" },
  });
}

// Render a single slide to a PNG so an agent can SEE how its HTML came out and
// whether it rendered correctly. GET /api/decks/:id/slide/:n → image/png.
app.get("/api/decks/:id/slide/:n", async (c) => {
  const row = await get<Deck>("SELECT * FROM decks WHERE id = ?", [c.req.param("id")]);
  if (!row) return c.json({ error: "Not found" }, 404);
  if (!c.env.CLAWNIFY_TOKEN) {
    return c.json({ error: "Slide render not configured (missing CLAWNIFY_TOKEN). Runs on deployed apps." }, 503);
  }
  const n = parseInt(c.req.param("n"), 10);
  const chunks = splitDeck(row.content);
  if (!Number.isFinite(n) || n < 0 || n >= chunks.length) {
    return c.json({ error: `No slide ${n} — deck has ${chunks.length} slide(s)` }, 404);
  }
  const tokens = parseTokens(await brandMdFor(row.brand_id));
  const format = safeFormat(row.format);
  try {
    const html = await slidePrintHtml(chunks[n], row.theme, tokens, format);
    // ?output=url → a presigned link instead of bytes: agents calling through
    // API proxies can't receive binary bodies, but they can fetch/vision a URL.
    if (c.req.query("output") === "url") {
      const link = await renderSlidePngLink(c.env.CLAWNIFY_TOKEN, html, format.page, { filename: `slide-${n + 1}.png` });
      return c.json(link);
    }
    const png = await renderSlidePng(c.env.CLAWNIFY_TOKEN, html, format.page);
    return new Response(png, { headers: { "Content-Type": "image/png", "Cache-Control": "no-store" } });
  } catch (err) {
    const detail = err instanceof PdfRenderError ? err.detail || err.message : String(err);
    return c.json({ error: "slide_render_failed", detail }, 502);
  }
});

// ── Assets (media + brand reference originals) ───────────────────────
// There is no media library: a `media` asset exists only while a slide or a
// brand logo references it (`assets/<key>`). Upload inserts a reference;
// removing the last reference makes the asset an orphan, which the sweep
// deletes from R2. A `reference` asset is different: it's a brand's original
// source file (e.g. the PDF a brand was replicated from) — kept as provenance
// and as a fidelity oracle for later edits. References are never swept; they
// live until their brand is deleted (or they're removed explicitly).

interface Asset {
  id: string;
  key: string;
  name: string;
  content_type: string;
  size: number;
  role: string; // 'media' | 'reference'
  brand_id: string | null; // for role='reference': the owning brand
  created_at: string;
}

// ── PDF reference → page images ──────────────────────────────────────
// A PDF original is rasterized to per-page JPEGs at upload time by PyMuPDF in
// the managed exec sandbox (services.clawnify.com/exec) — MuPDF renders color
// spaces faithfully where in-browser pdf.js shifts CMYK images/gradients (the
// classic "pink JPEG" bug), and pixel-perfect replication lives or dies on
// true colors. The page images — not the raw PDF — are what the brand AI gets
// attached: they're ~50x smaller than the base64 PDF re-sent on every agent
// step, and they sidestep a provider bug where a PDF part + tool-result images
// in the same conversation is rejected. Stored as role='reference-page' rows
// keyed `<parentKey>.page-N.jpg`, so parent deletion can find them; never swept.

const RASTER_PY = `import fitz
doc = fitz.open("doc.pdf")
n = min(len(doc), 8)
for i in range(n):
    page = doc[i]
    scale = 794 / page.rect.width
    pix = page.get_pixmap(matrix=fitz.Matrix(scale, scale))
    pix.save(f"page-{i+1}.jpg", jpg_quality=80)
print(n)
`;

// The colors ACTUALLY used by the original, parsed from the PDF's own vector
// content streams (rg/RG = rgb fill/stroke, k/K = cmyk) — ground truth that no
// rasterizer can shift. Streams are FlateDecoded via DecompressionStream.
// Returns hexes ranked by use, e.g. ["#C8392B (23x)", "#1B2D5B (14x)"].
async function extractPdfPalette(pdf: ArrayBuffer): Promise<string[]> {
  const bytes = new Uint8Array(pdf);
  // ASCII-only view for locating markers. NOTE: never round-trip stream BYTES
  // through a TextDecoder — "latin1" is really windows-1252 and remaps
  // 0x80–0x9F, corrupting compressed data. Slice the byte array directly.
  const ascii = (u8: Uint8Array) => {
    let s = "";
    const chunk = 0x8000;
    for (let i = 0; i < u8.length; i += chunk) s += String.fromCharCode(...u8.subarray(i, i + chunk));
    return s;
  };
  const whole = ascii(bytes);
  const counts = new Map<string, number>();
  const hex = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, "0");
  const add = (r: number, g: number, b: number) => {
    const h = `#${hex(r)}${hex(g)}${hex(b)}`.toUpperCase();
    counts.set(h, (counts.get(h) ?? 0) + 1);
  };
  const scan = (s: string) => {
    for (const m of s.matchAll(/(\d*\.?\d+)\s+(\d*\.?\d+)\s+(\d*\.?\d+)\s+(?:rg|RG|scn?|SCN?)[\s\n]/g)) {
      add(parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3]));
    }
    for (const m of s.matchAll(/(\d*\.?\d+)\s+(\d*\.?\d+)\s+(\d*\.?\d+)\s+(\d*\.?\d+)\s+(?:k|K)[\s\n]/g)) {
      const [c2, m2, y2, k2] = [parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3]), parseFloat(m[4])];
      add((1 - c2) * (1 - k2), (1 - m2) * (1 - k2), (1 - y2) * (1 - k2));
    }
  };
  scan(whole); // uncompressed content
  // FlateDecoded streams: inflate each and scan. Failures (image streams, other
  // filters) are expected — skip them. DecompressionStream is strict: trim the
  // trailing EOL before `endstream` or it throws "trailing junk". The negative
  // lookbehind skips the `stream\n` inside `endstream\n`.
  for (const m of whole.matchAll(/(?<!end)stream\r?\n/g)) {
    const start = (m.index ?? 0) + m[0].length;
    let end = whole.indexOf("endstream", start);
    if (end < 0 || end - start > 2 * 1024 * 1024) continue;
    while (end > start && (bytes[end - 1] === 0x0a || bytes[end - 1] === 0x0d || bytes[end - 1] === 0x20 || bytes[end - 1] === 0x09)) end--;
    try {
      const ds = new DecompressionStream("deflate");
      const inflated = await new Response(new Blob([bytes.subarray(start, end)]).stream().pipeThrough(ds)).arrayBuffer();
      scan(ascii(new Uint8Array(inflated)));
    } catch {
      /* not a flate text stream */
    }
  }
  return [...counts.entries()]
    .filter(([h]) => h !== "#FFFFFF" && h !== "#000000") // whites/blacks carry no brand signal
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([h, n]) => `${h} (${n}x)`);
}

async function rasterizeReferencePdf(
  token: string,
  pdf: ArrayBuffer,
  parentKey: string,
  parentName: string,
  brandId: string,
): Promise<void> {
  const res = await fetch("https://services.clawnify.com/exec/run", {
    method: "POST",
    headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      files: [
        { path: "main.py", data_base64: btoa(RASTER_PY) },
        { path: "doc.pdf", data_base64: arrayBufferToBase64(pdf) },
      ],
      entry: "main.py",
      requirements: ["pymupdf"],
      artifacts: Array.from({ length: 8 }, (_, i) => `page-${i + 1}.jpg`),
      output: "url",
    }),
  });
  if (!res.ok) throw new Error(`exec service responded ${res.status}: ${(await res.text().catch(() => "")).slice(0, 300)}`);
  const out = (await res.json()) as {
    success?: boolean;
    stderr?: string;
    artifacts?: Array<{ path: string; url: string }>;
  };
  if (!out.artifacts?.length) throw new Error(`rasterization produced no pages: ${(out.stderr || "").slice(0, 300)}`);
  for (const a of out.artifacts) {
    const n = parseInt(a.path.match(/page-(\d+)\.jpg/)?.[1] ?? "0", 10);
    if (!n) continue;
    const img = await fetch(a.url);
    if (!img.ok) continue;
    const bytes = await img.arrayBuffer();
    const key = `${parentKey}.page-${n}.jpg`;
    await putUpload(key, bytes, "image/jpeg");
    await run(
      "INSERT INTO assets (key, name, content_type, size, role, brand_id) VALUES (?, ?, ?, ?, 'reference-page', ?)",
      [key, `${parentName} — page ${n}`, "image/jpeg", bytes.byteLength, brandId],
    );
  }
}

app.post("/api/assets", async (c) => {
  const body = await c.req.parseBody();
  const file = body["file"];
  if (!file || typeof file === "string") return c.json({ error: "No file provided" }, 400);

  // Optional fields: role='reference' + brand_id store the file as a brand's
  // original source document instead of GC-managed slide media.
  const role = typeof body["role"] === "string" && body["role"] === "reference" ? "reference" : "media";
  const brandId = typeof body["brand_id"] === "string" ? body["brand_id"] : "";
  if (role === "reference") {
    if (!brandId) return c.json({ error: "brand_id is required for reference uploads" }, 400);
    const brand = await get<{ id: string }>("SELECT id FROM brands WHERE id = ?", [brandId]);
    if (!brand) return c.json({ error: "Unknown brand_id" }, 400);
  }

  let key = makeKey(file.name || "file");
  const clash = await get<{ id: string }>("SELECT id FROM assets WHERE key = ?", [key]);
  // PLACEHOLDER_KEY is virtual (served from a constant) — a real upload with
  // that name would be shadowed, so suffix it like a clash.
  if (clash || key === PLACEHOLDER_KEY) {
    const dot = key.lastIndexOf(".");
    const suffix = lower8();
    key = dot > 0 ? `${key.slice(0, dot)}-${suffix}${key.slice(dot)}` : `${key}-${suffix}`;
  }

  const data = await file.arrayBuffer();
  const contentType = file.type || "application/octet-stream";
  await putUpload(key, data, contentType);

  const res = await run(
    "INSERT INTO assets (key, name, content_type, size, role, brand_id) VALUES (?, ?, ?, ?, ?, ?)",
    [key, file.name || key, contentType, data.byteLength, role, role === "reference" ? brandId : null],
  );
  const row = await get<Asset>("SELECT * FROM assets WHERE rowid = ?", [res.lastInsertRowid]);

  // PDF originals: derive per-page images now (synchronously — a brand generate
  // may start right after this upload and needs the pages). Non-fatal on error.
  if (role === "reference" && contentType === "application/pdf" && c.env.CLAWNIFY_TOKEN && data.byteLength <= 15 * 1024 * 1024) {
    try {
      await rasterizeReferencePdf(c.env.CLAWNIFY_TOKEN, data, key, file.name || key, brandId);
    } catch (e) {
      console.error("reference pdf rasterization failed", e);
    }
  }
  return c.json(row, 201);
});

// Remove a brand's reference original. Media assets are GC-managed (delete the
// slide reference instead), so only role='reference' rows can be deleted here.
app.delete("/api/assets/:id", async (c) => {
  const row = await get<Asset>("SELECT * FROM assets WHERE id = ?", [c.req.param("id")]);
  if (!row) return c.json({ error: "Not found" }, 404);
  if (row.role !== "reference") {
    return c.json({ error: "Only reference assets can be deleted directly — media is removed by dropping its slide reference" }, 400);
  }
  // A PDF original takes its derived page images with it.
  for (const p of await query<Asset>("SELECT * FROM assets WHERE role = 'reference-page' AND key LIKE ?", [`${row.key}.page-%`])) {
    await deleteUpload(p.key);
    await run("DELETE FROM assets WHERE id = ?", [p.id]);
  }
  await deleteUpload(row.key);
  await run("DELETE FROM assets WHERE id = ?", [row.id]);
  return c.json({ ok: true });
});

app.get("/api/uploads/:key", async (c) => {
  const key = c.req.param("key");
  const obj = await getUpload(key);
  if (!obj) return c.json({ error: "Not found" }, 404);
  // Uploaded files never change under a key → cache hard. The virtual
  // placeholder is code-defined and DOES change with deploys → cache briefly,
  // or browsers hold a stale copy for a year after any fix to it.
  const cache = key === PLACEHOLDER_KEY ? "public, max-age=300" : "public, max-age=31536000";
  return new Response(obj.data, {
    headers: { "Content-Type": obj.contentType, "Cache-Control": cache },
  });
});

// ── deck content helpers (slides + speaker notes) ────────────────────
// A deck is one document; slides are separated by a line containing only `---`.
// Mirrors the client's splitSlides so indices line up across the wire.
function splitDeck(content: string): string[] {
  return ("\n" + content + "\n")
    .replace(/\r\n/g, "\n")
    .split(/\n[ \t]*---[ \t]*\n/)
    .map((c) => c.replace(/^\n+|\n+$/g, ""))
    .filter((c) => c.trim());
}
const joinDeck = (chunks: string[]) => chunks.join("\n\n---\n\n");

// Speaker notes live inside the slide as <aside class="notes">…</aside>. They're
// the per-slide store of intent: hidden on the slide and in the PDF, shown in the
// presenter view, and read/written by the agent. We keep notes and slide markup
// separate over the tool boundary and assemble them into the chunk.
const NOTES_RE = /<aside\b[^>]*\bclass="[^"]*\bnotes\b[^"]*"[^>]*>([\s\S]*?)<\/aside>/i;
const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const decodeHtml = (s: string) =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

function extractNotes(chunk: string): { content: string; notes: string } {
  const m = chunk.match(NOTES_RE);
  if (!m) return { content: chunk.trim(), notes: "" };
  const notes = decodeHtml(m[1].trim());
  const content = chunk.replace(NOTES_RE, "").replace(/\n{3,}/g, "\n\n").trim();
  return { content, notes };
}

function assembleChunk({ content, notes }: AuthoredSlide): string {
  const body = content.trim();
  return notes.trim() ? `${body}\n<aside class="notes">${escapeHtml(notes.trim())}</aside>` : body;
}

// ── helpers ──────────────────────────────────────────────────────────

function lower8(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(4)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

const ASSET_REF_RE = /assets\/([A-Za-z0-9._-]+)/g;

// Delete any media asset no slide or brand logo references anymore
// (garbage-collect media removed from the deck). Reference originals
// (role='reference') are exempt — they're kept until their brand is deleted.
// A short grace period spares freshly-uploaded assets whose reference hasn't
// been saved yet (the editor saves on a debounce).
async function sweepOrphanAssets(): Promise<void> {
  const stale = await query<{ id: string; key: string }>(
    "SELECT id, key FROM assets WHERE role = 'media' AND created_at < datetime('now', '-120 seconds')",
  );
  if (stale.length === 0) return;

  const used = new Set<string>();
  const collect = (s: string) => {
    for (const m of s.matchAll(ASSET_REF_RE)) used.add(m[1]);
  };
  for (const d of await query<{ content: string }>("SELECT content FROM decks")) collect(d.content);
  for (const b of await query<{ design_md: string }>("SELECT design_md FROM brands")) collect(b.design_md);

  for (const a of stale) {
    if (used.has(a.key)) continue;
    await deleteUpload(a.key);
    await run("DELETE FROM assets WHERE id = ?", [a.id]);
  }
}

// Run the sweep without blocking the response when possible.
function scheduleSweep(c: { executionCtx?: { waitUntil(p: Promise<unknown>): void } }): void {
  const p = sweepOrphanAssets().catch((e) => console.error("asset sweep failed", e));
  try {
    c.executionCtx?.waitUntil(p);
  } catch {
    /* no execution context (e.g. some dev paths) — the promise still runs */
  }
}

// View mode: media is same-origin with the app, so point `assets/<key>` at the
// served R2 route.
function rewriteAssetsForView(s: string): string {
  return s.replace(/(["'(])assets\//g, "$1/api/uploads/");
}

function resolveLogoForView(logo: string): string {
  if (!logo) return "";
  return logo.startsWith("assets/") ? `/api/uploads/${logo.slice("assets/".length)}` : logo;
}

async function resolveLogoForPrint(logo: string): Promise<string> {
  if (!logo) return "";
  if (!logo.startsWith("assets/")) return logo; // external URL
  const obj = await getUploadBytes(logo.slice("assets/".length));
  if (!obj) return "";
  return `data:${obj.contentType};base64,${arrayBufferToBase64(obj.data)}`;
}

// Replace `assets/<key>` references with inline data: URIs for PDF export.
// Bounded so a malicious/huge deck can't blow up the render payload.
async function inlineAssets(content: string): Promise<string> {
  const keys = new Set<string>();
  for (const m of content.matchAll(/assets\/([A-Za-z0-9._-]+)/g)) keys.add(m[1]);
  if (keys.size === 0) return content;

  let out = content;
  let count = 0;
  for (const key of keys) {
    if (count >= 30) break;
    const obj = await getUploadBytes(key);
    if (!obj || obj.data.byteLength > 8 * 1024 * 1024) continue;
    const dataUri = `data:${obj.contentType};base64,${arrayBufferToBase64(obj.data)}`;
    out = out.split(`assets/${key}`).join(dataUri);
    count++;
  }
  return out;
}

function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export default app;
