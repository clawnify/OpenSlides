import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Plus,
  Play,
  FileDown,
  Trash2,
  Copy,
  Presentation,
  Loader2,
  ChevronUp,
  ChevronDown,
  SlidersHorizontal,
  Sparkles,
  Code2,
  Wand2,
  Palette,
  ArrowLeft,
  Check,
  ImagePlus,
  Undo2,
  Redo2,
  FileText,
  Paperclip,
  ExternalLink,
} from "lucide-react";

// Open a file picker and upload the chosen file as an asset. Resolves to the
// stored asset (or null if cancelled). `extra` adds form fields (e.g.
// role=reference + brand_id for a brand's original source files).
function pickAndUpload(accept: string, extra?: Record<string, string>): Promise<Asset | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.onchange = async () => {
      const f = input.files?.[0];
      if (!f) return resolve(null);
      const fd = new FormData();
      fd.append("file", f);
      for (const [k, v] of Object.entries(extra ?? {})) fd.append(k, v);
      resolve(await fetch("/api/assets", { method: "POST", body: fd }).then((r) => r.json()));
    };
    input.click();
  });
}

// ── page formats (mirrors the server's formats.ts) ───────────────────
// The format drives the canvas aspect ratio in the editor and the wording
// (slides vs pages). Sizes live server-side; the client only needs the ratio.
const CLIENT_FORMATS: Record<string, { w: number; h: number; kind: "deck" | "document" }> = {
  "16:9": { w: 1280, h: 720, kind: "deck" },
  "a4-portrait": { w: 1240, h: 1754, kind: "document" },
};
const formatOf = (id: string | null | undefined) => CLIENT_FORMATS[id ?? ""] ?? CLIENT_FORMATS["16:9"];

// ── deck content <-> slides ──────────────────────────────────────────
function splitSlides(content: string): string[] {
  return ("\n" + content + "\n")
    .replace(/\r\n/g, "\n")
    .split(/\n[ \t]*---[ \t]*\n/)
    .map((c) => c.replace(/^\n+|\n+$/g, ""))
    .filter((c) => c.trim());
}
const joinSlides = (s: string[]) => s.join("\n\n---\n\n");

// Must mirror the renderer's data-sid selector exactly (same order) so a clicked
// element maps back to the right source node.
const SEL_LIST = "div,h1,h2,h3,h4,h5,h6,p,li,blockquote,span,strong,em,code,td,th,figcaption,img";

// ── per-element / per-slide source edits (pure) ──────────────────────
function parseHtmlSlide(chunk: string): { attrs: string; body: string } {
  let rest = chunk.replace(/^\s*<!--\s*html\s*-->\s*\n?/i, "");
  let attrs = "";
  const m = rest.match(/^<!--\s*\.slide:\s*([\s\S]*?)-->\s*\n?/i);
  if (m) {
    attrs = m[1].trim();
    rest = rest.slice(m[0].length);
  }
  return { attrs, body: rest.replace(/^\n+|\n+$/g, "") };
}
const buildHtmlSlide = (attrs: string, body: string) =>
  `<!-- html -->\n${attrs ? `<!-- .slide: ${attrs} -->\n` : ""}${body}`;

function withBody(body: string, fn: (root: HTMLElement) => void): string {
  const doc = new DOMParser().parseFromString(`<body><div id="__r">${body}</div></body>`, "text/html");
  const root = doc.getElementById("__r")!;
  fn(root);
  return root.innerHTML;
}
const elBySid = (root: HTMLElement, sid: number) =>
  (root.querySelectorAll(SEL_LIST)[sid] as HTMLElement | undefined) ?? null;

const FRAG = ["fragment", "fade-up", "fade-down", "fade-left", "fade-right", "zoom-in", "grow", "shrink"];

function applyTextHtml(chunk: string, sid: number, text: string): string {
  const { attrs, body } = parseHtmlSlide(chunk);
  return buildHtmlSlide(attrs, withBody(body, (r) => {
    const el = elBySid(r, sid);
    if (el) el.textContent = text;
  }));
}
function applyAnimHtml(chunk: string, sid: number, effect: string): string {
  const { attrs, body } = parseHtmlSlide(chunk);
  return buildHtmlSlide(attrs, withBody(body, (r) => {
    const el = elBySid(r, sid);
    if (!el) return;
    el.classList.remove(...FRAG);
    if (effect === "fade") el.classList.add("fragment");
    else if (effect) el.classList.add("fragment", effect);
  }));
}
// The clicked image's src as the canvas served it (/api/uploads/<key> or a
// bare assets/<key>) → the source reference (assets/<key>), for src-matching.
function assetRefFromViewSrc(src: string): string | null {
  try {
    const u = new URL(src, location.origin);
    if (u.pathname.startsWith("/api/uploads/")) return "assets/" + u.pathname.slice("/api/uploads/".length);
  } catch { /* not a URL */ }
  return src.startsWith("assets/") ? src : null;
}

// Swap the clicked image's src. sid-first; if the sid doesn't land on an IMG
// (older markup where live/source element indices diverge), fall back to
// matching the clicked src; as a last resort fill the first empty placeholder
// slot (that's always what a placeholder click means). Logs each step so a
// failing swap is diagnosable from the console, and reports how it matched.
function applyImgHtml(chunk: string, sid: number, ref: string, clickedSrc?: string): { chunk: string; swapped: string | null } {
  const { attrs, body } = parseHtmlSlide(chunk);
  let swapped: string | null = null;
  const next = buildHtmlSlide(attrs, withBody(body, (r) => {
    const imgs = [...r.querySelectorAll("img")];
    const el = elBySid(r, sid);
    console.info("[img-swap] sid=%d clickedSrc=%s → el=%s | imgs=%o", sid, clickedSrc, el?.tagName, imgs.map((i) => i.getAttribute("src")));
    if (el && el.tagName === "IMG") {
      el.setAttribute("src", ref);
      swapped = "sid";
      return;
    }
    const want = clickedSrc ? assetRefFromViewSrc(clickedSrc) : null;
    const bySrc = want ? imgs.find((im) => im.getAttribute("src") === want) : undefined;
    if (bySrc) {
      bySrc.setAttribute("src", ref);
      swapped = "src";
      return;
    }
    const slot = imgs.find((im) => im.getAttribute("src") === "assets/placeholder.svg");
    if (slot) {
      slot.setAttribute("src", ref);
      swapped = "placeholder-slot";
    }
  }));
  console.info("[img-swap] result=%s", swapped ?? "FAILED");
  return { chunk: next, swapped };
}

// alert() is silently suppressed inside sandboxed iframes (the dashboard embeds
// the app) — surface user-facing errors as an in-page toast instead.
function showToast(msg: string) {
  const el = document.createElement("div");
  el.textContent = msg;
  el.style.cssText =
    "position:fixed;left:50%;bottom:28px;transform:translateX(-50%);background:#111;color:#fff;padding:10px 16px;border-radius:8px;font:500 13px/1.4 system-ui;z-index:9999;max-width:80%;box-shadow:0 4px 16px rgba(0,0,0,.25)";
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 6000);
}
function removeElHtml(chunk: string, sid: number): string {
  const { attrs, body } = parseHtmlSlide(chunk);
  return buildHtmlSlide(attrs, withBody(body, (r) => elBySid(r, sid)?.remove()));
}
function getSlideBg(chunk: string): string | null {
  const m = chunk.match(/data-background-color="([^"]*)"/i);
  return m ? m[1] : null;
}
function setSlideBg(chunk: string, color: string | null): string {
  const commentRe = /<!--\s*\.slide:\s*([\s\S]*?)-->/i;
  const ex = chunk.match(commentRe);
  if (ex) {
    let attrs = ex[1].replace(/\s*data-background-color="[^"]*"/i, "").trim();
    if (color) attrs = `${attrs} data-background-color="${color}"`.trim();
    return attrs ? chunk.replace(commentRe, `<!-- .slide: ${attrs} -->`) : chunk.replace(commentRe, "").replace(/^\n+/, "");
  }
  if (!color) return chunk;
  const comment = `<!-- .slide: data-background-color="${color}" -->`;
  // Insert after an optional leading `<!-- html -->` marker, else prepend.
  if (/^\s*<!--\s*html\s*-->/i.test(chunk)) return chunk.replace(/(^\s*<!--\s*html\s*-->\s*\n?)/i, `$1${comment}\n`);
  return `${comment}\n${chunk}`;
}

// Speaker notes live inside the slide as <aside class="notes">…</aside> — hidden
// on the slide and in the PDF, shown in the presenter view, and read/written by
// the AI. They're the per-slide store of intent.
function getNotes(chunk: string): string {
  const { body } = parseHtmlSlide(chunk);
  const doc = new DOMParser().parseFromString(`<body>${body}</body>`, "text/html");
  const a = doc.querySelector("aside.notes");
  return a ? (a.textContent || "").trim() : "";
}
function setNotes(chunk: string, notes: string): string {
  const { attrs, body } = parseHtmlSlide(chunk);
  return buildHtmlSlide(attrs, withBody(body, (r) => {
    let a = r.querySelector("aside.notes");
    if (!notes.trim()) { a?.remove(); return; }
    if (!a) { a = r.ownerDocument.createElement("aside"); a.className = "notes"; r.appendChild(a); }
    a.textContent = notes;
  }));
}

// ── brand tokens ─────────────────────────────────────────────────────
interface BrandTokens {
  colors: { bg: string; text: string; heading: string; accent: string; muted: string };
  fonts: { heading: string; body: string; mono: string; google: string[] };
  sizes: { heading: number; subheading: number; body: number };
  radius: string;
  logo: string;
  logoPosition: "top-left" | "top-right" | "bottom-left" | "bottom-right";
  textAlign: "left" | "center";
}
const LOGO_POSITIONS = [
  { v: "top-left", l: "Top left" },
  { v: "top-right", l: "Top right" },
  { v: "bottom-left", l: "Bottom left" },
  { v: "bottom-right", l: "Bottom right" },
] as const;
const TEXT_ALIGNS = [
  { v: "left", l: "Left" },
  { v: "center", l: "Center" },
] as const;
const SYSTEM_SANS = "-apple-system, BlinkMacSystemFont, Segoe UI, sans-serif";
const FONTS = [
  { name: "System sans", family: SYSTEM_SANS, google: "" },
  { name: "Inter", family: "Inter", google: "Inter:wght@400;500;600;700" },
  { name: "Space Grotesk", family: "Space Grotesk", google: "Space+Grotesk:wght@500;700" },
  { name: "Poppins", family: "Poppins", google: "Poppins:wght@400;600;700" },
  { name: "Montserrat", family: "Montserrat", google: "Montserrat:wght@500;700" },
  { name: "Roboto", family: "Roboto", google: "Roboto:wght@400;500;700" },
  { name: "Playfair Display", family: "Playfair Display", google: "Playfair+Display:wght@500;700" },
  { name: "Georgia", family: "Georgia, serif", google: "" },
];
const nameOfFamily = (f: string) => FONTS.find((x) => x.family === f)?.name ?? "System sans";
const fontByName = (n: string) => FONTS.find((x) => x.name === n) ?? FONTS[0];

const ANIMS = [
  { v: "none", l: "None" },
  { v: "fade", l: "Fade in" },
  { v: "fade-up", l: "Fade up" },
  { v: "fade-down", l: "Fade down" },
  { v: "fade-left", l: "Fade left" },
  { v: "fade-right", l: "Fade right" },
  { v: "zoom-in", l: "Zoom in" },
  { v: "grow", l: "Grow" },
];

interface Deck { id: string; title: string; content: string; nav: string; brand_id: string | null; format: string; instructions: string; updated_at: string }
interface Asset { id: string; key: string; name: string; content_type: string; role?: string; brand_id?: string | null }
interface SlideTemplate { id: string; name: string; body: string }
type NavMode = "dots" | "arrows" | "numbers" | "none";
interface Nav { mode: NavMode }
const DEFAULT_NAV: Nav = { mode: "dots" };
const NAV_MODES: { v: NavMode; l: string }[] = [
  { v: "dots", l: "Dots (centered)" },
  { v: "arrows", l: "Arrows + progress bar" },
  { v: "numbers", l: "Page numbers" },
  { v: "none", l: "None" },
];
// Read the stored nav, collapsing the legacy {arrows,progress,…} shape to a mode.
function parseNavMode(s: string | undefined): Nav {
  try {
    const o = s ? JSON.parse(s) : {};
    if (typeof o.mode === "string" && NAV_MODES.some((m) => m.v === o.mode)) return { mode: o.mode };
    if (o.dots) return { mode: "dots" };
    if (o.arrows || o.progress) return { mode: "arrows" };
    if (o.slideNumber) return { mode: "numbers" };
    if (Object.keys(o).length) return { mode: "none" };
  } catch { /* fall through */ }
  return { ...DEFAULT_NAV };
}
interface SelEl { sid: number; tag: string; anim: string; text: string }

// The canned instruction behind "New brand from PDF" — replicate the attached
// original as this brand. The server attaches the reference file(s) to the
// model; the system prompt's replication mode does the heavy lifting.
const REPLICATE_INSTRUCTION =
  "Replicate the attached original document as this brand. Extract its exact colors, fonts and type scale, name the brand after it, and recreate EACH of its distinctive page layouts as format-tagged example slides. Verify with view_examples and iterate until each rendered example matches the original page.";

// A designed (HTML) slide wrapper using the brand CSS variables. Slides are
// always HTML — markdown is not supported. No text-align / align-items: the
// slide inherits the brand's alignment by default (overridable per slide).
const designedSlide = (inner: string) =>
  `<!-- html -->\n<div style="position:absolute;inset:0;display:flex;flex-direction:column;justify-content:center;padding:0 9%;box-sizing:border-box">\n${inner}\n</div>`;
// A truly empty slide — just the brand canvas, no elements. Add content via the
// Media button, the prompt, or the Code tab. (The wrapper keeps it a real,
// persistable slide; a fully empty chunk would be dropped as whitespace.)
const BLANK_SLIDE = designedSlide("");
const FALLBACK_STARTER = designedSlide(
  `  <div class="kicker" style="font-size:24px">Your kicker</div>\n  <h1 style="font:700 var(--brand-heading-size)/1.02 var(--r-heading-font);margin:14px 0 0;color:var(--brand-heading)">Your presentation</h1>\n  <p style="font:400 var(--brand-body-size)/1.4 var(--r-main-font);color:var(--brand-muted);max-width:72%;margin-top:18px">A supporting subtitle that sets the scene in one clear line.</p>`,
);
// An infographic slide: the @antv/infographic DSL lives in a marked script and is
// rendered to a brand-themed SVG at serve time. Edit the DSL in the Code tab or
// ask the AI (e.g. "make this a funnel"). Use the card/badge/node variants for a
// visual look — the bare "…-simple" templates are text-only. Good picks:
// sequence-steps-badge-card, list-grid-badge-card, list-grid-compact-card,
// sequence-funnel-simple, sequence-pyramid-simple, compare-swot.
const INFOGRAPHIC_SLIDE = designedSlide(
  `  <h2 style="font:700 var(--brand-subheading-size)/1.05 var(--r-heading-font);margin:0;color:var(--brand-heading)">Our process</h2>
  <div class="infographic" style="flex:1;min-height:0;margin-top:18px"><script type="text/x-infographic">
infographic sequence-steps-badge-card
data
  lists
    - label Discover
      desc Research and scope
    - label Build
      desc Ship the core
    - label Launch
      desc Go to market
</script></div>`,
);

export function App() {
  const [decks, setDecks] = useState<Deck[]>([]);
  const [templates, setTemplates] = useState<SlideTemplate[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const [title, setTitle] = useState("");
  const [slides, setSlides] = useState<string[]>([]);
  const [sel, setSel] = useState(0);
  const [nav, setNav] = useState<Nav>({ ...DEFAULT_NAV });
  const [instructions, setInstructions] = useState(""); // deck-level agent.md

  // brand library
  const [brands, setBrands] = useState<{ id: string; name: string; tokens: BrandTokens }[]>([]);
  const [brandId, setBrandId] = useState<string | null>(null);
  const [tokens, setTokens] = useState<BrandTokens | null>(null);
  const [page, setPage] = useState<"deck" | "brands">("deck");
  const [editorBrandId, setEditorBrandId] = useState<string | null>(null);
  // A one-shot instruction the brand editor runs on open (PDF → brand import).
  const [pendingAuto, setPendingAuto] = useState<{ brandId: string; instruction: string } | null>(null);

  const [selEl, setSelEl] = useState<SelEl | null>(null);
  const [bottomTab, setBottomTab] = useState<"prompt" | "code">("prompt");
  const [prompt, setPrompt] = useState("");
  const [genLoading, setGenLoading] = useState(false);
  const [noteDraft, setNoteDraft] = useState("");

  const [saving, setSaving] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [viewKey, setViewKey] = useState(0);
  const [addOpen, setAddOpen] = useState(false);
  const [decksOpen, setDecksOpen] = useState(false);

  const canvasRef = useRef<HTMLIFrameElement>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const brandTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rendered = useRef("");
  const instructionsRef = useRef(""); // fresh value for the debounced save closure

  // Undo/redo history of the slides array. Speaker notes live inside each slide's
  // HTML (the <aside class="notes">), so snapshotting `slides` covers both.
  const undoStack = useRef<string[][]>([]);
  const redoStack = useRef<string[][]>([]);
  const coalesceKey = useRef<string | null>(null); // group rapid same-key edits (notes typing) into one step
  const coalesceAt = useRef(0);
  const undoRef = useRef<() => void>(() => {});
  const redoRef = useRef<() => void>(() => {});
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);

  const selected = decks.find((d) => d.id === selectedId) ?? null;
  const content = joinSlides(slides);
  const deckFormatId = selected?.format ?? "16:9";
  const deckFormat = formatOf(deckFormatId);
  const pageWord = deckFormat.kind === "document" ? "page" : "slide";

  // ── loading ──
  const loadDecks = useCallback(async () => {
    const rows: Deck[] = await fetch("/api/decks").then((r) => r.json());
    setDecks(rows);
    return rows;
  }, []);

  const loadBrands = useCallback(async () => {
    const rows: { id: string; name: string; tokens: BrandTokens }[] = await fetch("/api/brands").then((r) => r.json());
    setBrands(rows);
    return rows;
  }, []);

  useEffect(() => {
    loadBrands();
    loadDecks().then((rows) => rows.length && selectDeck(rows[0]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The "Add slide" template set follows the deck's format (16:9 slides vs A4
  // document pages).
  useEffect(() => {
    fetch(`/api/templates?format=${encodeURIComponent(deckFormatId)}`)
      .then((r) => r.json() as Promise<SlideTemplate[]>)
      .then(setTemplates)
      .catch(() => {});
  }, [deckFormatId]);

  // The Design inspector edits the deck's active brand.
  const activeBrandId = brandId ?? brands[0]?.id ?? null;
  useEffect(() => {
    setTokens(brands.find((b) => b.id === activeBrandId)?.tokens ?? null);
  }, [brands, activeBrandId]);
  const activeBrandName = brands.find((b) => b.id === activeBrandId)?.name ?? "Brand";

  // canvas → editor messages
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      const m = e.data || {};
      if (m.source !== "slides-preview") return;
      if (m.type === "slidechanged") { setSel(m.h ?? 0); setSelEl(null); }
      else if (m.type === "bg-click") setSelEl(null);
      else if (m.type === "el-select") setSelEl({ sid: m.sid, tag: m.tag, anim: m.anim, text: m.text });
      else if (m.type === "el-edit") onElEdit(m.sid, m.oldText, m.newText);
      else if (m.type === "img-click") onImgClick(m.sid, m.src);
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // refs so the (once-bound) message handler + debounced saves read fresh state
  const slidesRef = useRef<string[]>([]);
  const selRef = useRef(0);
  const titleRef = useRef("");
  const navRef = useRef<Nav>({ ...DEFAULT_NAV });
  useEffect(() => { slidesRef.current = slides; }, [slides]);
  useEffect(() => { selRef.current = sel; }, [sel]);
  useEffect(() => { titleRef.current = title; }, [title]);
  useEffect(() => { navRef.current = nav; }, [nav]);

  // The canvas src must NOT depend on `sel`: slide navigation goes through
  // postMessage (gotoSlide), so reacting to `sel` here would reload the iframe on
  // every move and flash slide 1. It reloads only when the deck/brand changes
  // (viewKey), restoring the current slide via the h= param captured at that moment.
  const canvasSrc = useMemo(
    () => (selectedId ? `/api/decks/${selectedId}/view?h=${selRef.current}&t=${viewKey}` : ""),
    [selectedId, viewKey],
  );

  function selectDeck(d: Deck) {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    setSelectedId(d.id);
    setTitle(d.title);
    const s = splitSlides(d.content);
    const initial = s.length ? s : [""];
    setSlides(initial); slidesRef.current = initial; // keep the once-bound handler in sync
    setSel(0);
    selRef.current = 0; // keep the canvasSrc memo from restoring the prior deck's slide
    setSelEl(null);
    setBrandId(d.brand_id ?? null); // reflect the deck's actual brand in the inspector
    setInstructions(d.instructions ?? ""); instructionsRef.current = d.instructions ?? "";
    resetHistory(); // history is per-deck
    titleRef.current = d.title;
    const nv = parseNavMode(d.nav); navRef.current = nv; setNav(nv);
    rendered.current = d.content;
    setViewKey((k) => k + 1);
    setDecksOpen(false);
    setPage("deck");
  }

  // ── save ──
  // `quiet` persists without reloading the canvas — used for speaker-notes edits,
  // which change the document but not the rendered slide.
  function scheduleSave(next: string[], t = title, n = nav, quiet = false) {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => save(next, t, n, quiet), 500);
  }
  async function save(next = slides, t = title, n = nav, quiet = false) {
    if (!selectedId) return;
    const body = { title: t, content: joinSlides(next), nav: JSON.stringify(n), instructions: instructionsRef.current };
    setSaving(true);
    const up: Deck = await fetch(`/api/decks/${selectedId}`, {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    }).then((r) => r.json());
    setDecks((ds) => ds.map((d) => (d.id === up.id ? up : d)));
    setSaving(false);
    if (body.content !== rendered.current) {
      rendered.current = body.content;
      if (!quiet) setViewKey((k) => k + 1);
    }
  }
  // Deck-level agent.md. Saves quietly (doesn't change the rendered slide).
  function setDeckInstructions(v: string) {
    setInstructions(v); instructionsRef.current = v;
    scheduleSave(slides, title, nav, true);
  }
  // ── undo / redo ──
  function syncHist() { setCanUndo(undoStack.current.length > 0); setCanRedo(redoStack.current.length > 0); }
  // The single entry point for every slide change. Records the pre-change state
  // for undo (coalescing rapid same-key edits), then applies + saves.
  function commitSlides(next: string[], opts: { key?: string; quiet?: boolean } = {}) {
    const now = Date.now();
    const coalesce = !!opts.key && opts.key === coalesceKey.current && now - coalesceAt.current < 700;
    if (!coalesce) {
      undoStack.current.push(slidesRef.current);
      if (undoStack.current.length > 100) undoStack.current.shift();
      redoStack.current = [];
    }
    coalesceKey.current = opts.key ?? null;
    coalesceAt.current = now;
    slidesRef.current = next; // keep fresh for the next commit in the same tick
    setSlides(next);
    scheduleSave(next, titleRef.current, navRef.current, !!opts.quiet);
    syncHist();
  }
  function restoreSlides(target: string[]) {
    coalesceKey.current = null;
    slidesRef.current = target;
    setSlides(target);
    setSel((s) => Math.max(0, Math.min(s, target.length - 1)));
    setSelEl(null);
    rendered.current = joinSlides(target);
    setViewKey((k) => k + 1); // reflect the restore on the canvas immediately
    scheduleSave(target, titleRef.current, navRef.current, true); // persist (quiet — we already bumped)
  }
  function undo() {
    if (!undoStack.current.length) return;
    redoStack.current.push(slidesRef.current);
    restoreSlides(undoStack.current.pop()!);
    syncHist();
  }
  function redo() {
    if (!redoStack.current.length) return;
    undoStack.current.push(slidesRef.current);
    restoreSlides(redoStack.current.pop()!);
    syncHist();
  }
  function resetHistory() { undoStack.current = []; redoStack.current = []; coalesceKey.current = null; syncHist(); }
  undoRef.current = undo;
  redoRef.current = redo;

  function applyToSlide(i: number, fn: (c: string) => string) {
    const next = slidesRef.current.slice(); // fresh — this runs from the once-bound canvas message handler too
    next[i] = fn(next[i] ?? "");
    commitSlides(next);
  }
  function setSlidesAndSave(next: string[]) { commitSlides(next); }

  // ── click-to-edit write-backs ──
  function onElEdit(sid: number, _oldText: string, newText: string) {
    const i = selRef.current;
    const chunk = slidesRef.current[i] ?? "";
    applyToSlide(i, () => applyTextHtml(chunk, sid, newText));
  }
  async function onImgClick(sid: number, src: string) {
    console.info("[img-swap] img-click received sid=%d src=%s slide=%d", sid, src, selRef.current);
    const a = await pickAndUpload("image/*");
    if (!a) return;
    const i = selRef.current; const chunk = slidesRef.current[i] ?? "";
    const { chunk: next, swapped } = applyImgHtml(chunk, sid, `assets/${a.key}`, src);
    if (!swapped) {
      showToast("Couldn't locate the clicked image in this slide — the upload is saved; add it via the Code tab or the Media button.");
      return;
    }
    applyToSlide(i, () => next);
    showToast("Image added to the slide.");
  }
  // Upload a new image/video and add it to the current slide.
  async function addMedia() {
    const a = await pickAndUpload("image/*,video/*");
    if (!a) return;
    const ref = `assets/${a.key}`;
    const isVideo = (a.content_type || "").startsWith("video/");
    const i = sel; const chunk = slides[i] ?? "";
    // If the slide has an empty placeholder slot, fill it — an APPENDED image
    // sits after (and underneath) a full-page absolute wrapper, i.e. invisible.
    if (!isVideo && chunk.includes('src="assets/placeholder.svg"')) {
      applyToSlide(i, (c) => c.replace('src="assets/placeholder.svg"', `src="${ref}"`)); // first slot only
      return;
    }
    const { attrs, body } = parseHtmlSlide(chunk);
    const tag = isVideo
      ? `<video controls src="${ref}" style="max-width:100%;border-radius:var(--brand-radius)"></video>`
      : `<img src="${ref}" alt="" style="max-width:100%;border-radius:var(--brand-radius)" />`;
    applyToSlide(i, () => buildHtmlSlide(attrs, `${body}\n${tag}`));
  }
  function setAnim(effect: string) {
    if (!selEl) return;
    setSelEl({ ...selEl, anim: effect });
    const i = sel; const chunk = slides[i] ?? "";
    applyToSlide(i, () => applyAnimHtml(chunk, selEl.sid, effect === "none" ? "" : effect));
  }
  function deleteSelEl() {
    if (!selEl) return;
    applyToSlide(sel, (c) => removeElHtml(c, selEl.sid));
    setSelEl(null);
  }

  // ── background popover ──
  const currentBg = getSlideBg(slides[sel] ?? "") ?? tokens?.colors.bg ?? "#000000";
  function changeBg(color: string | null) {
    applyToSlide(sel, (c) => setSlideBg(c, color));
  }

  // ── slide ops ──
  function gotoSlide(i: number) {
    setSel(i); setSelEl(null);
    canvasRef.current?.contentWindow?.postMessage({ target: "slides-view", type: "goto", h: i }, "*");
  }
  function addSlide(body: string) {
    setAddOpen(false);
    const next = slides.slice(); next.splice(sel + 1, 0, body);
    setSel(sel + 1); setSlidesAndSave(next);
  }
  function duplicateSlide(i: number) {
    const next = slides.slice(); next.splice(i + 1, 0, slides[i]);
    setSel(i + 1); setSlidesAndSave(next);
  }
  function moveSlide(i: number, dir: -1 | 1) {
    const j = i + dir; if (j < 0 || j >= slides.length) return;
    const next = slides.slice(); [next[i], next[j]] = [next[j], next[i]];
    setSel(j); setSlidesAndSave(next);
  }
  function deleteSlide(i: number) {
    if (slides.length <= 1) return;
    const next = slides.slice(); next.splice(i, 1);
    setSel(Math.max(0, Math.min(i, next.length - 1))); setSlidesAndSave(next);
  }

  // New decks start from designed starters for their format (Title + bullets for
  // 16:9, Cover + Card sections for A4 documents), or a single fallback slide.
  // Fetched per format — the loaded `templates` state tracks the CURRENT deck's
  // format, which may differ from the one being created.
  async function starterContent(format: string) {
    const tpls = await fetch(`/api/templates?format=${encodeURIComponent(format)}`)
      .then((r) => r.json() as Promise<SlideTemplate[]>)
      .catch(() => [] as SlideTemplate[]);
    const pick = (id: string) => tpls.find((t) => t.id === id)?.body;
    const ids = formatOf(format).kind === "document" ? ["doc-cover", "doc-sections"] : ["title", "bullets"];
    const bodies = ids.map(pick).filter(Boolean) as string[];
    return bodies.length ? bodies.join("\n\n---\n\n") : FALLBACK_STARTER;
  }

  // ── decks ──
  async function newDeck(format = "16:9") {
    const isDoc = formatOf(format).kind === "document";
    const created: Deck = await fetch("/api/decks", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: isDoc ? "Untitled document" : "Untitled deck", content: await starterContent(format), format }),
    }).then((r) => r.json());
    setDecks((ds) => [created, ...ds]); selectDeck(created);
  }
  async function deleteDeck(id: string) {
    await fetch(`/api/decks/${id}`, { method: "DELETE" });
    const rows = await loadDecks();
    if (id === selectedId) rows.length ? selectDeck(rows[0]) : (setSelectedId(null), setSlides([]));
  }
  // Start a brand-new deck/document that uses the given brand, seeded from the
  // brand's own example slides for that format (server falls back to the generic
  // starter content sent here if the brand has none for it).
  async function newDeckWithBrand(id: string, format = "16:9") {
    const isDoc = formatOf(format).kind === "document";
    const created: Deck = await fetch("/api/decks", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: isDoc ? "Untitled document" : "Untitled deck", brand_id: id, format, seed_from_brand: true, content: await starterContent(format) }),
    }).then((r) => r.json());
    setDecks((ds) => [created, ...ds]);
    selectDeck(created);
  }

  // ── present + export ──
  // Presenting fullscreens the canvas IFRAME ELEMENT, so the document inside it
  // can't see its own fullscreen state — tell it explicitly when present mode
  // turns on/off so it gates editing and plays animations + nav chrome.
  const present = () => canvasRef.current?.requestFullscreen?.();
  useEffect(() => {
    const onFs = () =>
      canvasRef.current?.contentWindow?.postMessage(
        { target: "slides-view", type: "present", on: document.fullscreenElement === canvasRef.current },
        "*",
      );
    document.addEventListener("fullscreenchange", onFs);
    document.addEventListener("webkitfullscreenchange", onFs as EventListener);
    return () => {
      document.removeEventListener("fullscreenchange", onFs);
      document.removeEventListener("webkitfullscreenchange", onFs as EventListener);
    };
  }, []);

  // Undo/redo keyboard shortcuts (Cmd/Ctrl+Z, Cmd/Ctrl+Shift+Z or Ctrl+Y). Skip
  // when a text field is focused so native text undo still works there.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      const k = e.key.toLowerCase();
      const isRedo = (k === "z" && e.shiftKey) || k === "y";
      const isUndo = k === "z" && !e.shiftKey;
      if (!isUndo && !isRedo) return;
      const t = e.target as HTMLElement | null;
      const tag = (t?.tagName || "").toLowerCase();
      if (tag === "textarea" || tag === "input" || t?.isContentEditable) return;
      e.preventDefault();
      (isRedo ? redoRef.current : undoRef.current)();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  async function exportPdf() {
    if (!selectedId) return;
    setExporting(true);
    try {
      const res = await fetch(`/api/decks/${selectedId}/pdf`);
      if (!res.ok) { const m: any = await res.json().catch(() => ({})); alert(`Export failed: ${m.detail || m.error || res.status}`); return; }
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement("a"); a.href = url;
      a.download = `${(title || "deck").replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.pdf`; a.click();
      URL.revokeObjectURL(url);
    } finally { setExporting(false); }
  }

  // ── speaker notes (per-slide; the AI reads & writes these too) ──
  // Refresh the draft when the slide changes or the deck reloads (viewKey bumps
  // on slide-switch and on each streamed AI edit). Notes edits save "quiet" (no
  // viewKey bump), so typing here never resets the draft mid-keystroke.
  useEffect(() => { setNoteDraft(getNotes(slides[sel] ?? "")); }, [sel, selectedId, viewKey]); // eslint-disable-line react-hooks/exhaustive-deps
  function setSlideNotes(text: string) {
    setNoteDraft(text);
    const next = slides.slice();
    next[sel] = setNotes(next[sel] ?? "", text);
    // quiet (notes don't change the rendered slide) + coalesce a typing burst into one undo step
    commitSlides(next, { key: `notes:${sel}`, quiet: true });
  }

  // ── AI generate (multi-step agent loop, streamed) ──
  // The server drives the deck through add/edit/delete-slide verbs and streams
  // each change over SSE; we mirror the deck as slides land, one at a time. The
  // server already persists every change, so we never save back here.
  async function runGenerate() {
    if (!prompt.trim() || genLoading || !selectedId) return;
    const id = selectedId;
    setGenLoading(true);
    try {
      // Flush pending edits FIRST so the agent reads the latest deck (it reads
      // from the server). Inline canvas edits save on a 500ms debounce, and
      // clicking Generate blurs the editor which commits that last edit via an
      // async postMessage — so yield briefly to let it land, then save now.
      await new Promise((r) => setTimeout(r, 60));
      if (saveTimer.current) { clearTimeout(saveTimer.current); saveTimer.current = null; }
      await save(slidesRef.current, titleRef.current, navRef.current, true);
      const res = await fetch(`/api/decks/${id}/generate`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt, current_index: selRef.current }),
      });
      if (!res.ok || !res.body) {
        const m: any = await res.json().catch(() => ({}));
        alert(m.error || "Generation failed");
        return;
      }
      setPrompt("");
      // One undo entry for the whole generation: snapshot the pre-gen deck now;
      // the streamed slides below don't each record (the server owns persistence).
      undoStack.current.push(slidesRef.current);
      if (undoStack.current.length > 100) undoStack.current.shift();
      redoStack.current = []; coalesceKey.current = null; syncHist();
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n\n")) >= 0) {
          const line = buf.slice(0, nl).split("\n").find((l) => l.startsWith("data:"));
          buf = buf.slice(nl + 2);
          if (!line) continue;
          let ev: any;
          try { ev = JSON.parse(line.slice(5).trim()); } catch { continue; }
          if (ev.type === "slide") {
            const s = splitSlides(ev.content);
            rendered.current = ev.content; // server already persisted; keep save() in sync
            const applied = s.length ? s : [ev.content];
            slidesRef.current = applied; // keep undo's "current" in sync during streaming
            setSlides(applied);
            const idx = Math.min(ev.sel ?? 0, Math.max(0, (s.length || 1) - 1));
            setSel(idx); selRef.current = idx;
            setViewKey((k) => k + 1); // show the slide that just changed
          } else if (ev.type === "error") {
            alert(ev.error || "Generation failed");
          }
        }
      }
    } catch (e) {
      alert(String(e instanceof Error ? e.message : e));
    } finally {
      setGenLoading(false);
    }
  }

  // ── brand inspector ──
  function patchBrand(mut: (t: BrandTokens) => BrandTokens) {
    if (!tokens || !activeBrandId) return;
    const next = mut(structuredClone(tokens));
    setTokens(next);
    setBrands((bs) => bs.map((b) => (b.id === activeBrandId ? { ...b, tokens: next } : b)));
    if (brandTimer.current) clearTimeout(brandTimer.current);
    brandTimer.current = setTimeout(async () => {
      await fetch(`/api/brands/${activeBrandId}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tokens: next }) });
      setViewKey((k) => k + 1);
    }, 300);
  }

  // pick which brand the current deck uses
  async function useBrandForDeck(id: string) {
    if (!selectedId) return;
    setBrandId(id);
    setPage("deck");
    setEditorBrandId(null);
    await fetch(`/api/decks/${selectedId}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ brand_id: id }) });
    setViewKey((k) => k + 1);
  }
  async function createBrand() {
    const b: { id: string } = await fetch("/api/brands", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "New brand" }) }).then((r) => r.json());
    await loadBrands();
    setEditorBrandId(b.id);
  }
  // One-click PDF → brand conversion: create a brand, attach the picked file as
  // its reference original, open the editor and auto-run the replication
  // instruction (the AI reads the file, extracts the design and recreates its
  // page layouts as format-tagged example slides, verifying renders as it goes).
  async function createBrandFromPdf() {
    const b: { id: string } = await fetch("/api/brands", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "Imported template" }) }).then((r) => r.json());
    const a = await pickAndUpload("application/pdf,image/*", { role: "reference", brand_id: b.id });
    if (!a) {
      await fetch(`/api/brands/${b.id}`, { method: "DELETE" }); // picker cancelled — don't leave an empty brand
      await loadBrands();
      return;
    }
    await loadBrands();
    setPendingAuto({ brandId: b.id, instruction: REPLICATE_INSTRUCTION });
    setEditorBrandId(b.id);
  }
  function setFont(role: "heading" | "body", name: string) {
    const f = fontByName(name);
    patchBrand((t) => {
      t.fonts[role] = f.family;
      t.fonts.google = [...new Set([fontByName(nameOfFamily(t.fonts.heading)).google, fontByName(nameOfFamily(t.fonts.body)).google].filter(Boolean))];
      return t;
    });
  }
  function setNavMode(mode: NavMode) {
    const n: Nav = { mode }; setNav(n); save(slides, title, n);
  }

  const radiusPx = tokens ? parseInt(tokens.radius) || 0 : 12;

  return (
    <div className="flex h-screen flex-col bg-neutral-50 text-neutral-900">
      {/* top bar */}
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-neutral-200 bg-white px-3">
        <span className="grid h-7 w-7 place-items-center rounded-md bg-neutral-900 text-white"><Presentation size={15} /></span>
        <div className="relative">
          <button onClick={() => setDecksOpen((o) => !o)} className="flex items-center gap-1.5 rounded-md px-2 py-1 text-sm font-medium hover:bg-neutral-100">
            {title || "OpenSlides"} <ChevronDown size={14} className="text-neutral-400" />
          </button>
          {decksOpen && (
            <div className="absolute left-0 z-30 mt-1 w-60 overflow-hidden rounded-md border border-neutral-200 bg-white py-1 shadow-lg">
              <button onClick={() => newDeck()} className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-neutral-600 hover:bg-neutral-100"><Plus size={14} /> New deck</button>
              <button onClick={() => newDeck("a4-portrait")} className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-neutral-600 hover:bg-neutral-100"><FileText size={14} /> New document (A4)</button>
              <div className="my-1 border-t border-neutral-100" />
              {decks.map((d) => (
                <div key={d.id} className={`group flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-neutral-50 ${d.id === selectedId ? "font-medium" : ""}`}>
                  <button onClick={() => selectDeck(d)} className="flex-1 truncate text-left">{d.title || "Untitled"}</button>
                  <button onClick={() => deleteDeck(d.id)} className="hidden text-neutral-400 hover:text-red-500 group-hover:block"><Trash2 size={13} /></button>
                </div>
              ))}
            </div>
          )}
        </div>
        {selected && (
          <input value={title} onChange={(e) => { setTitle(e.target.value); scheduleSave(slides, e.target.value); }}
            className="ml-1 w-44 rounded px-2 py-1 text-sm text-neutral-500 outline-none hover:bg-neutral-100 focus:bg-neutral-100" placeholder="Deck title" />
        )}
        <div className="flex-1" />
        {selected && page === "deck" && (
          <div className="mr-1 flex items-center">
            <button onClick={() => undoRef.current()} disabled={!canUndo} title="Undo (⌘Z)"
              className="grid h-8 w-8 place-items-center rounded-md text-neutral-600 hover:bg-neutral-100 disabled:opacity-30 disabled:hover:bg-transparent"><Undo2 size={15} /></button>
            <button onClick={() => redoRef.current()} disabled={!canRedo} title="Redo (⌘⇧Z)"
              className="grid h-8 w-8 place-items-center rounded-md text-neutral-600 hover:bg-neutral-100 disabled:opacity-30 disabled:hover:bg-transparent"><Redo2 size={15} /></button>
          </div>
        )}
        <span className="mr-1 text-xs text-neutral-400">{saving ? "Saving…" : selected ? `${slides.length} ${pageWord}${slides.length === 1 ? "" : "s"}` : ""}</span>
        <button onClick={() => setPage(page === "brands" ? "deck" : "brands")} className={`flex h-8 items-center gap-1.5 rounded-md border px-3 text-sm ${page === "brands" ? "border-neutral-900 bg-neutral-900 text-white" : "border-neutral-200 hover:bg-neutral-50"}`}>
          <Palette size={14} /> Brands
        </button>
        <button onClick={exportPdf} disabled={!selected || exporting} className="flex h-8 items-center gap-1.5 rounded-md border border-neutral-200 px-3 text-sm hover:bg-neutral-50 disabled:opacity-40">
          {exporting ? <Loader2 size={14} className="animate-spin" /> : <FileDown size={14} />} PDF
        </button>
        <button onClick={present} disabled={!selected} className="flex h-8 items-center gap-1.5 rounded-md bg-neutral-900 px-3 text-sm font-medium text-white hover:bg-neutral-700 disabled:opacity-40">
          <Play size={14} /> Present
        </button>
      </header>

      {page === "brands" ? (
        editorBrandId ? (
          <BrandEditor
            brandId={editorBrandId}
            active={editorBrandId === activeBrandId}
            autoInstruction={pendingAuto?.brandId === editorBrandId ? pendingAuto.instruction : undefined}
            onAutoConsumed={() => setPendingAuto(null)}
            onBack={() => setEditorBrandId(null)}
            onChanged={loadBrands}
            onUse={(f) => newDeckWithBrand(editorBrandId, f)}
            onDeleted={async () => { setEditorBrandId(null); const rows = await loadBrands(); if (!rows.find((b) => b.id === brandId)) setBrandId(rows[0]?.id ?? null); setViewKey((k) => k + 1); }}
          />
        ) : (
          <main className="min-h-0 flex-1 overflow-y-auto bg-neutral-50">
            <div className="mx-auto max-w-5xl px-8 py-8">
              <div className="mb-6 flex items-center justify-between">
                <div>
                  <h1 className="text-xl font-semibold">Brand library</h1>
                  <p className="text-sm text-neutral-500">Design systems your decks can use. Click one to preview and edit.</p>
                </div>
                <div className="flex items-center gap-2">
                  <button onClick={createBrandFromPdf} className="flex items-center gap-1.5 rounded-md border border-neutral-300 px-3 py-2 text-sm font-medium text-neutral-700 hover:bg-neutral-100"><FileText size={15} /> New brand from PDF</button>
                  <button onClick={createBrand} className="flex items-center gap-1.5 rounded-md bg-neutral-900 px-3 py-2 text-sm font-medium text-white hover:bg-neutral-700"><Plus size={15} /> New brand</button>
                </div>
              </div>
              <div className="grid grid-cols-3 gap-4">
                {brands.map((b) => (
                  <BrandCard key={b.id} brand={b} active={b.id === activeBrandId} onUse={(f) => newDeckWithBrand(b.id, f)} onEdit={() => setEditorBrandId(b.id)} />
                ))}
              </div>
            </div>
          </main>
        )
      ) : selected ? (
        <div className="flex min-h-0 flex-1">
          {/* Pages */}
          <aside className="flex w-48 shrink-0 flex-col border-r border-neutral-200 bg-white">
            <div className="px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-neutral-400">Pages</div>
            <div className="flex-1 space-y-2 overflow-y-auto px-3 pb-2">
              {slides.map((s, i) => (
                <div key={i} className="group relative">
                  <button onClick={() => gotoSlide(i)} style={{ aspectRatio: `${deckFormat.w} / ${deckFormat.h}` }}
                    className={`block w-full overflow-hidden rounded-md border bg-neutral-900 text-left ${i === sel ? "border-neutral-900 ring-2 ring-neutral-900" : "border-neutral-200 hover:border-neutral-400"}`}>
                    <iframe key={viewKey} src={`/api/decks/${selected.id}/view?only=${i}&thumb=1&t=${viewKey}`} title={`Slide ${i + 1}`} tabIndex={-1} scrolling="no" className="pointer-events-none h-full w-full border-0" />
                  </button>
                  <span className="absolute left-1 top-1 rounded bg-black/60 px-1 text-[10px] font-medium text-white">{String(i + 1).padStart(2, "0")}</span>
                  <div className="absolute right-1 top-1 hidden gap-0.5 group-hover:flex">
                    <IconMini onClick={() => moveSlide(i, -1)}><ChevronUp size={12} /></IconMini>
                    <IconMini onClick={() => moveSlide(i, 1)}><ChevronDown size={12} /></IconMini>
                    <IconMini onClick={() => duplicateSlide(i)} title="Duplicate"><Copy size={12} /></IconMini>
                    <IconMini onClick={() => deleteSlide(i)} danger><Trash2 size={12} /></IconMini>
                  </div>
                </div>
              ))}
            </div>
            <div className="relative border-t border-neutral-200 p-2">
              <button onClick={() => setAddOpen((o) => !o)} className="flex w-full items-center justify-center gap-1.5 rounded-md border border-dashed border-neutral-300 py-2 text-sm text-neutral-600 hover:bg-neutral-50"><Plus size={15} /> Add slide</button>
              {addOpen && (
                <div className="absolute bottom-12 left-2 right-2 z-30 max-h-72 overflow-y-auto rounded-md border border-neutral-200 bg-white py-1 shadow-lg">
                  <div className="px-3 py-1 text-[10px] font-semibold uppercase tracking-wide text-neutral-400">Designed</div>
                  {templates.map((t) => (<button key={t.id} onClick={() => addSlide(t.body)} className="block w-full px-3 py-1.5 text-left text-xs hover:bg-neutral-100">{t.name}</button>))}
                  <div className="my-1 border-t border-neutral-100" />
                  <button onClick={() => addSlide(INFOGRAPHIC_SLIDE)} className="block w-full px-3 py-1.5 text-left text-xs hover:bg-neutral-100">Infographic</button>
                  <button onClick={() => addSlide(BLANK_SLIDE)} className="block w-full px-3 py-1.5 text-left text-xs hover:bg-neutral-100">Blank slide</button>
                </div>
              )}
            </div>
          </aside>

          {/* canvas + prompt/code */}
          <main className="flex min-w-0 flex-1 flex-col bg-neutral-100">
            {/* Always present the canvas as the largest format-shaped box that
                fits the available space (container-query units), so it never
                stretches with the window — only the letterbox around it grows. */}
            <div className="flex min-h-0 flex-1 items-center justify-center p-3" style={{ containerType: "size" }}>
              <div style={{ width: `min(100cqw, calc(100cqh * ${deckFormat.w} / ${deckFormat.h}))`, aspectRatio: `${deckFormat.w} / ${deckFormat.h}` }}>
                <iframe key={viewKey} ref={canvasRef} src={canvasSrc} title="Canvas" allowFullScreen className="h-full w-full rounded-lg border border-neutral-200 bg-white shadow-sm" />
              </div>
            </div>
            <div className="flex h-44 shrink-0 flex-col border-t border-neutral-200 bg-white">
              <div className="flex items-center gap-1 px-3 pt-2">
                <Tab active={bottomTab === "prompt"} onClick={() => setBottomTab("prompt")}><Sparkles size={13} /> Prompt</Tab>
                <Tab active={bottomTab === "code"} onClick={() => setBottomTab("code")}><Code2 size={13} /> Code</Tab>
                <div className="flex-1" />
                <span className="text-[11px] text-neutral-400">Tip: click any text, image or background on the slide to edit it</span>
              </div>
              {bottomTab === "prompt" ? (
                <div className="flex flex-1 flex-col gap-2 p-3">
                  <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)}
                    onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") runGenerate(); }}
                    placeholder="Describe what to make — e.g. “a 3-slide intro for our Q3 launch, bold and confident”"
                    className="flex-1 resize-none rounded-md border border-neutral-200 p-2.5 text-sm outline-none focus:border-neutral-400" />
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] text-neutral-400">Edits this slide, adds slides, or builds a deck — based on what you ask. ⌘↵</span>
                    <div className="flex-1" />
                    <button onClick={runGenerate} disabled={genLoading || !prompt.trim()} className="flex h-8 items-center gap-1.5 rounded-md bg-neutral-900 px-3 text-sm font-medium text-white hover:bg-neutral-700 disabled:opacity-40">
                      {genLoading ? <Loader2 size={14} className="animate-spin" /> : <Wand2 size={14} />} Generate
                    </button>
                  </div>
                </div>
              ) : (
                <textarea value={slides[sel] ?? ""} onChange={(e) => applyToSlide(sel, () => e.target.value)} spellCheck={false}
                  placeholder="Edit this slide's HTML"
                  className="flex-1 resize-none px-3 pb-3 font-mono text-[12.5px] leading-relaxed outline-none" />
              )}
            </div>
          </main>

          {/* Design inspector */}
          <aside className="flex w-72 shrink-0 flex-col overflow-y-auto border-l border-neutral-200 bg-white">
            <div className="flex items-center gap-2 px-4 py-3 text-sm font-medium"><SlidersHorizontal size={15} /> Design</div>
            <div className="px-4 pb-4">
              <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-neutral-400">Brand</div>
              <div className="flex items-center gap-2">
                <select value={activeBrandId ?? ""} onChange={(e) => useBrandForDeck(e.target.value)} className="h-8 flex-1 rounded-md border border-neutral-200 bg-white px-2 text-sm">
                  {brands.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                </select>
                <button onClick={() => setPage("brands")} title="Brand library" className="grid h-8 w-8 shrink-0 place-items-center rounded-md border border-neutral-200 hover:bg-neutral-50"><Palette size={14} /></button>
              </div>
            </div>

            <div className="px-4 pb-4">
              <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-neutral-400">Agent instructions</div>
              <textarea value={instructions} onChange={(e) => setDeckInstructions(e.target.value)}
                placeholder="General guidance the AI always follows for this deck — audience, tone, must-say points, do/don'ts."
                className="h-28 w-full resize-none rounded-md border border-neutral-200 p-2 text-[12px] leading-relaxed outline-none focus:border-neutral-400" />
              <p className="mt-1.5 text-[11px] leading-snug text-neutral-400">This deck's <code>agent.md</code> — read by the AI on every generate. Never shown on slides.</p>
            </div>

            <div className="px-4 pb-4">
              <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-neutral-400">Pagination</div>
              <SelectRow label="Style" value={nav.mode} options={NAV_MODES.map((m) => m.l)}
                onChange={(l) => setNavMode(NAV_MODES.find((m) => m.l === l)!.v)}
                valueToLabel={(v) => NAV_MODES.find((m) => m.v === v)?.l ?? "Dots (centered)"} />
              <p className="mt-1.5 text-[11px] leading-snug text-neutral-400">Applies to the whole deck. Dots and arrows + progress bar show only while presenting; page numbers also print in the PDF.</p>
            </div>

            <div className="px-4 pb-4">
              <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-neutral-400">Media</div>
              <button onClick={addMedia} className="flex w-full items-center justify-center gap-1.5 rounded-md border border-dashed border-neutral-300 py-2 text-sm text-neutral-600 hover:bg-neutral-50">
                <ImagePlus size={15} /> Add image or video
              </button>
              <p className="mt-1.5 text-[11px] leading-snug text-neutral-400">Added to this slide. Click an image on the slide to replace it; delete it from the slide to remove it for good.</p>
            </div>

            <div className="px-4 pb-4">
              <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-neutral-400">Speaker notes</div>
              <textarea value={noteDraft} onChange={(e) => setSlideNotes(e.target.value)}
                placeholder="What to say on this slide…"
                className="h-24 w-full resize-none rounded-md border border-neutral-200 p-2 text-[12px] leading-relaxed outline-none focus:border-neutral-400" />
              <p className="mt-1.5 text-[11px] leading-snug text-neutral-400">Shown in the presenter view (press S while presenting), never on the slide or in the PDF. The AI reads &amp; writes these.</p>
            </div>

            <div className="px-4 pb-6">
              {selEl ? (
                <div className="rounded-lg border border-neutral-200 bg-neutral-50 p-3">
                  <div className="mb-2 flex items-center justify-between">
                    <span className="text-[11px] font-semibold uppercase tracking-wide text-neutral-500">Element · {selEl.tag.toLowerCase()}</span>
                    <button onClick={deleteSelEl} className="text-neutral-400 hover:text-red-500"><Trash2 size={13} /></button>
                  </div>
                  <SelectRow label="Animate in" value={selEl.anim} options={ANIMS.map((a) => a.l)}
                    onChange={(l) => setAnim(ANIMS.find((a) => a.l === l)!.v)} valueToLabel={(v) => ANIMS.find((a) => a.v === v)?.l ?? "None"} />
                </div>
              ) : (
                <div className="space-y-3 rounded-lg border border-neutral-200 bg-neutral-50 p-3">
                  <div className="text-[11px] font-semibold uppercase tracking-wide text-neutral-500">Background</div>
                  <ColorRow label="Slide color" value={currentBg} onChange={(v) => changeBg(v)} />
                  <button onClick={() => changeBg(null)} className="text-xs text-neutral-400 hover:text-neutral-600">Reset to brand</button>
                </div>
              )}
              <p className="mt-3 text-[11px] leading-snug text-neutral-400">Click any text or image on the slide to edit it, or the background for slide settings.</p>
            </div>
          </aside>
        </div>
      ) : (
        <main className="grid flex-1 place-items-center text-neutral-400">
          <div className="text-center">
            <Presentation size={32} className="mx-auto mb-3 opacity-40" />
            <div className="flex items-center justify-center gap-2">
              <button onClick={() => newDeck()} className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700">Create your first deck</button>
              <button onClick={() => newDeck("a4-portrait")} className="rounded-md border border-neutral-300 px-4 py-2 text-sm font-medium text-neutral-600 hover:bg-neutral-100">New A4 document</button>
            </div>
          </div>
        </main>
      )}

    </div>
  );
}

// ── brand library card ──
const resolveLogo = (logo: string) => (logo.startsWith("assets/") ? `/api/uploads/${logo.slice("assets/".length)}` : logo);
function familyCss(f: string) { return /[, ]/.test(f) ? f : `'${f}'`; }
function BrandCard({ brand, active, onUse, onEdit }: { brand: { id: string; name: string; tokens: BrandTokens }; active: boolean; onUse: (format: string) => void; onEdit: () => void }) {
  const t = brand.tokens;
  return (
    <div className={`overflow-hidden rounded-lg border ${active ? "border-neutral-900 ring-1 ring-neutral-900" : "border-neutral-200"}`}>
      <button onClick={onEdit} className="block w-full text-left">
        <div style={{ background: t.colors.bg }} className="flex h-28 flex-col justify-center px-4">
          <div style={{ color: t.colors.accent }} className="text-[10px] font-semibold uppercase tracking-widest">Brand</div>
          <div style={{ color: t.colors.heading, fontFamily: familyCss(t.fonts.heading) }} className="truncate text-xl font-bold">{brand.name}</div>
          <div style={{ color: t.colors.muted, fontFamily: familyCss(t.fonts.body) }} className="truncate text-xs">The quick brown fox jumps</div>
        </div>
      </button>
      <div className="flex items-center justify-between border-t border-neutral-100 px-3 py-2">
        <div className="flex gap-1">
          {[t.colors.bg, t.colors.text, t.colors.accent].map((c, i) => (<span key={i} style={{ background: c }} className="h-3.5 w-3.5 rounded-full border border-neutral-200" />))}
        </div>
        <div className="flex items-center gap-2">
          {active && <span className="flex items-center gap-1 text-xs text-green-600"><Check size={12} /> In use</span>}
          <button onClick={() => onUse("16:9")} className="rounded border border-neutral-200 px-2 py-0.5 text-xs hover:bg-neutral-50">New deck</button>
          <button onClick={() => onUse("a4-portrait")} title="New A4 document" className="rounded border border-neutral-200 px-2 py-0.5 text-xs hover:bg-neutral-50">New doc</button>
          <button onClick={onEdit} className="text-xs text-neutral-500 hover:text-neutral-900">Edit</button>
        </div>
      </div>
    </div>
  );
}

// ── brand editor (preview + name + prompt + DESIGN.md) ──
function BrandEditor({ brandId, active, autoInstruction, onAutoConsumed, onBack, onChanged, onUse, onDeleted }: {
  brandId: string; active: boolean; autoInstruction?: string; onAutoConsumed?: () => void; onBack: () => void; onChanged: () => void; onUse: (format: string) => void; onDeleted: () => void;
}) {
  const [name, setName] = useState("");
  const [md, setMd] = useState("");
  const [tokens, setTokens] = useState<BrandTokens | null>(null);
  const [references, setReferences] = useState<Asset[]>([]); // the brand's original source files
  const [instruction, setInstruction] = useState("");
  const [busy, setBusy] = useState(false);
  const [pk, setPk] = useState(0);
  const tmr = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    fetch(`/api/brands/${brandId}`).then((r) => r.json()).then((b: any) => { setName(b.name); setMd(b.design_md); setTokens(b.tokens); setReferences(b.references ?? []); });
  }, [brandId]);

  // ── original source files (role='reference' assets, kept with the brand) ──
  async function reloadReferences() {
    const b: any = await fetch(`/api/brands/${brandId}`).then((r) => r.json());
    setReferences(b.references ?? []);
  }
  async function addReference() {
    const a = await pickAndUpload("application/pdf,image/*", { role: "reference", brand_id: brandId });
    if (a) reloadReferences();
  }
  async function removeReference(id: string) {
    await fetch(`/api/assets/${id}`, { method: "DELETE" });
    reloadReferences();
  }

  async function put(body: any) {
    const b: any = await fetch(`/api/brands/${brandId}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());
    if (b.design_md != null) setMd(b.design_md);
    if (b.tokens) setTokens(b.tokens);
    onChanged(); setPk((k) => k + 1);
  }
  function patchTokens(mut: (t: BrandTokens) => BrandTokens) {
    if (!tokens) return;
    const next = mut(structuredClone(tokens)); setTokens(next);
    if (tmr.current) clearTimeout(tmr.current);
    tmr.current = setTimeout(() => put({ tokens: next }), 300);
  }
  function setFont(role: "heading" | "body", n: string) {
    const f = fontByName(n);
    patchTokens((t) => { t.fonts[role] = f.family; t.fonts.google = [...new Set([fontByName(nameOfFamily(t.fonts.heading)).google, fontByName(nameOfFamily(t.fonts.body)).google].filter(Boolean))]; return t; });
  }
  // Multi-step agent loop, streamed: the agent adjusts tokens and edits the
  // guidelines through tool calls; each change streams back and updates the
  // preview live (same pattern as the slide editor).
  async function runInstruction(text: string) {
    if (!text.trim() || busy) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/brands/${brandId}/generate`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ instruction: text }),
      });
      if (!res.ok || !res.body) {
        const b: any = await res.json().catch(() => ({}));
        alert(b.error || "Failed");
        return;
      }
      setInstruction("");
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n\n")) >= 0) {
          const line = buf.slice(0, nl).split("\n").find((l) => l.startsWith("data:"));
          buf = buf.slice(nl + 2);
          if (!line) continue;
          let ev: any;
          try { ev = JSON.parse(line.slice(5).trim()); } catch { continue; }
          if (ev.type === "brand") {
            setMd(ev.design_md); setTokens(ev.tokens); onChanged(); setPk((k) => k + 1);
          } else if (ev.type === "error") {
            alert(ev.error || "Failed");
          }
        }
      }
    } catch (e) {
      alert(String(e instanceof Error ? e.message : e));
    } finally { setBusy(false); }
  }
  const applyPrompt = () => runInstruction(instruction);
  // PDF → brand import: auto-run the replication instruction once, as soon as
  // the brand has loaded (the reference file was attached before we opened).
  const autoRan = useRef(false);
  useEffect(() => {
    if (autoInstruction && tokens && !autoRan.current) {
      autoRan.current = true;
      onAutoConsumed?.();
      runInstruction(autoInstruction);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoInstruction, tokens]);
  async function del() {
    if (!confirm("Delete this brand?")) return;
    await fetch(`/api/brands/${brandId}`, { method: "DELETE" });
    onDeleted();
  }
  const radiusPx = tokens ? parseInt(tokens.radius) || 0 : 12;

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-white">
      <div className="flex items-center gap-3 border-b border-neutral-200 px-5 py-2.5">
        <button onClick={onBack} className="flex items-center gap-1 text-sm text-neutral-500 hover:text-neutral-900"><ArrowLeft size={15} /> Library</button>
        <input value={name} onChange={(e) => setName(e.target.value)} onBlur={() => put({ name })} className="ml-1 w-56 rounded px-2 py-1 text-sm font-medium outline-none hover:bg-neutral-100 focus:bg-neutral-100" placeholder="Brand name" />
        <div className="flex-1" />
        {active && <span className="flex items-center gap-1 text-xs text-green-600"><Check size={13} /> In use on current deck</span>}
        <button onClick={del} className="text-xs text-neutral-400 hover:text-red-500">Delete</button>
        <button onClick={() => onUse("a4-portrait")} className="rounded-md border border-neutral-200 px-3 py-1.5 text-sm hover:bg-neutral-50">New A4 document</button>
        <button onClick={() => onUse("16:9")} className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-neutral-700">Use for new slides</button>
      </div>
      <div className="flex min-h-0 flex-1">
        {/* preview */}
        <div className="min-h-0 flex-1 bg-neutral-100 p-4">
          <iframe key={pk} src={`/api/brands/${brandId}/preview?t=${pk}`} title="Brand preview" className="h-full w-full rounded-lg border border-neutral-200 bg-white" />
        </div>
        {/* controls */}
        <div className="flex w-80 shrink-0 flex-col overflow-y-auto border-l border-neutral-200">
          {tokens && (
            <div className="space-y-5 p-4">
              <Group label="Colors">
                <ColorRow label="Background" value={tokens.colors.bg} onChange={(v) => patchTokens((t) => ((t.colors.bg = v), t))} />
                <ColorRow label="Text" value={tokens.colors.text} onChange={(v) => patchTokens((t) => ((t.colors.text = v), (t.colors.heading = v), t))} />
                <ColorRow label="Accent" value={tokens.colors.accent} onChange={(v) => patchTokens((t) => ((t.colors.accent = v), t))} />
              </Group>
              <Group label="Typography">
                <SelectRow label="Display" value={nameOfFamily(tokens.fonts.heading)} options={FONTS.map((f) => f.name)} onChange={(v) => setFont("heading", v)} />
                <SelectRow label="Body" value={nameOfFamily(tokens.fonts.body)} options={FONTS.map((f) => f.name)} onChange={(v) => setFont("body", v)} />
                <SliderRow label="Heading" value={tokens.sizes.heading} min={12} max={100} unit="px" onChange={(v) => patchTokens((t) => ((t.sizes.heading = v), t))} />
                <SliderRow label="Subheading" value={tokens.sizes.subheading} min={12} max={100} unit="px" onChange={(v) => patchTokens((t) => ((t.sizes.subheading = v), t))} />
                <SliderRow label="Paragraph" value={tokens.sizes.body} min={12} max={100} unit="px" onChange={(v) => patchTokens((t) => ((t.sizes.body = v), t))} />
                <SelectRow label="Align" value={tokens.textAlign} options={TEXT_ALIGNS.map((a) => a.l)}
                  onChange={(l) => patchTokens((t) => ((t.textAlign = TEXT_ALIGNS.find((a) => a.l === l)!.v), t))}
                  valueToLabel={(v) => TEXT_ALIGNS.find((a) => a.v === v)?.l ?? "Left"} />
              </Group>
              <Group label="Shape">
                <SliderRow label="Radius" value={radiusPx} min={0} max={32} unit="px" onChange={(v) => patchTokens((t) => ((t.radius = `${v}px`), t))} />
              </Group>
              <Group label="Logo">
                <div className="flex items-center gap-3">
                  <div className="grid h-12 w-20 shrink-0 place-items-center overflow-hidden rounded-md border border-neutral-200 bg-neutral-50">
                    {tokens.logo
                      ? <img src={resolveLogo(tokens.logo)} alt="" className="max-h-10 max-w-[72px] object-contain" />
                      : <span className="text-[10px] text-neutral-400">None</span>}
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <button onClick={async () => { const a = await pickAndUpload("image/*"); if (a) patchTokens((t) => ((t.logo = `assets/${a.key}`), t)); }}
                      className="rounded-md border border-neutral-200 px-2.5 py-1 text-xs hover:bg-neutral-50">Upload logo</button>
                    {tokens.logo && <button onClick={() => patchTokens((t) => ((t.logo = ""), t))} className="text-left text-xs text-neutral-400 hover:text-red-500">Remove</button>}
                  </div>
                </div>
                {tokens.logo && (
                  <SelectRow label="Position" value={tokens.logoPosition}
                    options={LOGO_POSITIONS.map((p) => p.l)}
                    onChange={(l) => patchTokens((t) => ((t.logoPosition = LOGO_POSITIONS.find((p) => p.l === l)!.v), t))}
                    valueToLabel={(v) => LOGO_POSITIONS.find((p) => p.v === v)?.l ?? "Bottom right"} />
                )}
                <p className="text-[11px] leading-snug text-neutral-400">Shown in the chosen corner of every slide and in the exported PDF.</p>
              </Group>
              <Group label="Original files">
                {references.map((r) => (
                  <div key={r.id} className="flex items-center gap-2 text-sm text-neutral-600">
                    <FileText size={13} className="shrink-0 text-neutral-400" />
                    <span className="flex-1 truncate" title={r.name}>{r.name}</span>
                    <a href={`/api/uploads/${r.key}`} target="_blank" rel="noreferrer" title="Open" className="text-neutral-400 hover:text-neutral-900"><ExternalLink size={13} /></a>
                    <button onClick={() => removeReference(r.id)} title="Remove" className="text-neutral-400 hover:text-red-500"><Trash2 size={13} /></button>
                  </div>
                ))}
                <button onClick={addReference} className="flex w-full items-center justify-center gap-1.5 rounded-md border border-dashed border-neutral-300 py-2 text-xs text-neutral-600 hover:bg-neutral-50">
                  <Paperclip size={13} /> Attach original
                </button>
                <p className="text-[11px] leading-snug text-neutral-400">The source files this brand replicates — e.g. the original PDF template. Kept with the brand (never garbage-collected) so the AI can compare pages against them when refining.</p>
              </Group>
              <div>
                <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-neutral-400">Refine by prompt</div>
                <textarea value={instruction} onChange={(e) => setInstruction(e.target.value)} onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") applyPrompt(); }}
                  placeholder="e.g. “darker and more playful, serif display font”" className="h-16 w-full resize-none rounded-md border border-neutral-200 p-2 text-sm outline-none focus:border-neutral-400" />
                <button onClick={applyPrompt} disabled={busy || !instruction.trim()} className="mt-1.5 flex items-center gap-1.5 rounded-md bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-neutral-700 disabled:opacity-40">
                  {busy ? <Loader2 size={14} className="animate-spin" /> : <Wand2 size={14} />} Apply
                </button>
              </div>
              <div>
                <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-neutral-400"><Code2 size={12} /> DESIGN.md</div>
                <textarea value={md} onChange={(e) => setMd(e.target.value)} onBlur={() => put({ design_md: md })} spellCheck={false} className="h-64 w-full resize-none rounded-md border border-neutral-200 p-2 font-mono text-[11px] leading-relaxed outline-none focus:border-neutral-400" />
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── helpers ──
function IconMini({ onClick, children, danger, title }: { onClick: () => void; children: React.ReactNode; danger?: boolean; title?: string }) {
  return <button onClick={(e) => { e.stopPropagation(); onClick(); }} title={title} className={`rounded bg-white/90 p-0.5 text-neutral-600 ${danger ? "hover:text-red-500" : "hover:text-neutral-900"}`}>{children}</button>;
}
function Tab({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return <button onClick={onClick} className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium ${active ? "bg-neutral-900 text-white" : "text-neutral-500 hover:bg-neutral-100"}`}>{children}</button>;
}
function Group({ label, children }: { label: string; children: React.ReactNode }) {
  return <div><div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-neutral-400">{label}</div><div className="space-y-2">{children}</div></div>;
}
function ColorRow({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <div className="flex items-center gap-2">
      <span className="flex-1 text-sm text-neutral-600">{label}</span>
      <input type="color" value={value} onChange={(e) => onChange(e.target.value)} className="h-7 w-7 cursor-pointer rounded border border-neutral-200 bg-white p-0.5" />
      <input value={value} onChange={(e) => onChange(e.target.value)} className="w-20 rounded border border-neutral-200 px-1.5 py-1 text-xs uppercase outline-none" />
    </div>
  );
}
function SelectRow({ label, value, options, onChange, valueToLabel }: { label: string; value: string; options: string[]; onChange: (v: string) => void; valueToLabel?: (v: string) => string }) {
  const shown = valueToLabel ? valueToLabel(value) : value;
  return (
    <div className="flex items-center gap-2">
      <span className="flex-1 text-sm text-neutral-600">{label}</span>
      <select value={shown} onChange={(e) => onChange(e.target.value)} className="w-36 rounded border border-neutral-200 px-1.5 py-1 text-xs outline-none">
        {options.map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
    </div>
  );
}
function SliderRow({ label, value, min, max, unit, onChange }: { label: string; value: number; min: number; max: number; unit: string; onChange: (v: number) => void }) {
  // Drag the slider OR type an exact value. A local draft lets you type a
  // multi-digit number without it being clamped on each keystroke; we clamp +
  // commit on blur / Enter.
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const clamp = (n: number) => Math.max(min, Math.min(max, n));
  const commit = () => {
    const n = parseInt(draft, 10);
    const v = clamp(Number.isFinite(n) ? n : value);
    onChange(v); setDraft(String(v));
  };
  return (
    <div className="flex items-center gap-2">
      <span className="flex-1 text-sm text-neutral-600">{label}</span>
      <input type="range" min={min} max={max} value={value} onChange={(e) => onChange(parseInt(e.target.value, 10))} className="w-20 accent-neutral-900" />
      <span className="flex items-center gap-0.5">
        <input type="number" min={min} max={max} value={draft}
          onChange={(e) => setDraft(e.target.value)} onBlur={commit}
          onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
          className="w-11 rounded border border-neutral-200 px-1 py-1 text-right text-xs tabular-nums outline-none focus:border-neutral-400" />
        <span className="text-xs text-neutral-400">{unit}</span>
      </span>
    </div>
  );
}
