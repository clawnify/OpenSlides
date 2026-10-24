// Company logos for data-logo images, looked up from a website.
//
// Sources, first hit wins:
//   1. logo.dev, when the org has saved its secret key as LOGO_DEV_SECRET_KEY.
//      Its API allows storing its logos and putting them in documents. A
//      square slot gets the brand's symbol, a full slot its wide brandmark (the
//      symbol when it has none), each made for the slot's background.
//   2. @clawnify/logokit's brand SVGs, for a website its index lists for that
//      brand. Its lookup also guesses a brand from a domain's first word
//      ("harbor.com" → the Harbor project), which would put another company's
//      logo on a document, so a guess never counts here. Only the brand's main
//      mark is used, or its `dark` version on a dark background: theSVG's
//      wordmarks often have white lettering (made for dark backgrounds, so
//      invisible on paper) and its light/dark wordmark entries mostly 404, so
//      the slot's shape applies with logo.dev only.
//   3. The site's own icon, as its home page declares it (apple-touch-icon and
//      the like), when it is a vector or at least 64 px: a smaller one prints
//      blurred. Google's favicon service is not used: it publishes no terms,
//      and its robots.txt disallows automated access.
// Nothing found leaves the image out, and the render lists it under warnings.
//
// Found logos are kept in the app's storage for 30 days and misses for a day,
// per source, domain, shape and background, so repeated documents don't repeat
// the lookups (or logo.dev's charges).

import type { Variant } from "@clawnify/logokit";
import { MAX_IMAGE_BYTES, sniff, toBase64 } from "./images";
import { logoKey, type LogoMap, type LogoRequest } from "./variables";

export interface Found {
  body: Uint8Array;
  type: string;
}

/** Where looked-up logos are kept: `found` is null for a remembered miss. */
export interface LogoCache {
  get(key: string): Promise<{ found: Found | null; storedAt: number } | null>;
  put(key: string, found: Found | null): Promise<void>;
}

export interface LogoDeps {
  fetch: typeof fetch;
  cache: LogoCache;
  /** The org's logo.dev secret key, when it saved one. */
  logoDevKey?: string;
  now?: () => number;
}

export interface ResolvedLogos {
  logos: LogoMap;
  /** Problems worth telling the caller about, e.g. logo.dev refusing the key. */
  warnings: string[];
}

const DAY = 86_400_000;
const FOUND_TTL = 30 * DAY;
const MISS_TTL = DAY;
const MAX_LOGOS = 50;
const TIMEOUT_MS = 8000;
const MAX_HTML_BYTES = 256 * 1024;
export const MIN_ICON_PX = 64;
const LOGO_DEV_API = "https://api.logo.dev/v2/brands";
// Pixels asked of logo.dev: enough for a logo printed a few centimetres wide.
const LOGO_DEV_SIZE = "512";

export async function resolveLogos(requests: LogoRequest[], deps: LogoDeps): Promise<ResolvedLogos> {
  const logos: LogoMap = new Map();
  const warnings = new Set<string>();
  if (requests.length > MAX_LOGOS) {
    warnings.add(`more than ${MAX_LOGOS} different logos in one document; the rest are left out`);
    for (const r of requests.slice(MAX_LOGOS)) logos.set(logoKey(r), null);
  }
  await Promise.all(
    requests.slice(0, MAX_LOGOS).map(async (r) => {
      const found = await lookupLogo(r, deps, warnings);
      logos.set(logoKey(r), found ? `data:${found.type};base64,${toBase64(found.body)}` : null);
    }),
  );
  return { logos, warnings: [...warnings] };
}

async function lookupLogo(req: LogoRequest, deps: LogoDeps, warnings: Set<string>): Promise<Found | null> {
  const key = `logos/v1/${deps.logoDevKey ? "logodev" : "free"}/${req.domain}/${req.shape}-${req.theme}`;
  const now = (deps.now ?? Date.now)();
  const cached = await deps.cache.get(key).catch(() => null);
  if (cached && now - cached.storedAt < (cached.found ? FOUND_TTL : MISS_TTL)) return cached.found;

  let found: Found | null = null;
  let keep = true; // false after a failure worth retrying, so the outcome isn't remembered
  if (deps.logoDevKey) {
    const r = await fromLogoDev(req, deps);
    found = r.found;
    if (r.retry) keep = false;
    if (r.warning) warnings.add(r.warning);
  }
  found ??= await fromLogokit(req, deps.fetch);
  found ??= await fromSiteIcon(req.domain, deps.fetch);
  if (keep) await deps.cache.put(key, found).catch(() => {});
  return found;
}

// ── logo.dev ──────────────────────────────────────────────────────────

async function fromLogoDev(req: LogoRequest, deps: LogoDeps): Promise<{ found: Found | null; retry?: boolean; warning?: string }> {
  // A full slot wants the wide brandmark; a brand without one gets its symbol.
  for (const route of req.shape === "full" ? ["brandmark", "logo"] : ["logo"]) {
    let res: Response;
    try {
      res = await deps.fetch(`${LOGO_DEV_API}/${route}?domain=${encodeURIComponent(req.domain)}`, {
        headers: { Authorization: `Bearer ${deps.logoDevKey}` },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      return { found: null, retry: true };
    }
    if (res.status === 404) continue; // no such brand, or none of this kind
    if (res.status === 202) return { found: null, retry: true }; // logo.dev is still indexing this brand
    if (res.status === 401 || res.status === 402 || res.status === 403) {
      const why = res.status === 401 ? "check LOGO_DEV_SECRET_KEY" : res.status === 402 ? "out of credits" : "refused";
      return { found: null, retry: true, warning: `logo.dev did not answer (HTTP ${res.status}, ${why}), so other logo sources were used` };
    }
    if (!res.ok) return { found: null, retry: true };
    const body = (await res.json().catch(() => null)) as { data?: { url?: unknown } } | null;
    const url = typeof body?.data?.url === "string" ? safeUrl(body.data.url) : null;
    // The download link is logo.dev's own; anything else is not fetched.
    if (!url || url.protocol !== "https:" || !(url.hostname === "logo.dev" || url.hostname.endsWith(".logo.dev"))) return { found: null, retry: true };
    url.searchParams.set("format", "png"); // their docs: a dark theme can fail as jpg
    url.searchParams.set("theme", req.theme);
    url.searchParams.set("size", LOGO_DEV_SIZE);
    const found = await download(url.href, deps.fetch);
    return found ? { found } : { found: null, retry: true };
  }
  return { found: null };
}

// ── @clawnify/logokit ────────────────────────────────────────────────

// A label no brand is named after, put in front of the domain: lookup() then
// matches only the domains its index lists (the domain and its parents), never
// a guess from the first word.
const NO_GUESS_LABEL = "x0-logo-lookup";

/**
 * Versions to try, best first. theSVG's `dark` files are light-coloured, made
 * for dark backgrounds (155 of the 176 with explicit colours, 2026-10-12).
 */
function logokitVariants(req: LogoRequest): Variant[] {
  return req.theme === "dark" ? ["dark", "default"] : ["default"];
}

async function fromLogokit(req: LogoRequest, fetchFn: typeof fetch): Promise<Found | null> {
  // Imported on use: the brand index costs heap, and only logo lookups need it.
  const kit = await import("@clawnify/logokit");
  const slug = kit.lookup({ raw: req.domain, domain: `${NO_GUESS_LABEL}.${req.domain}`, name: null });
  if (!slug) return null;
  const thesvg = kit.theSVG();
  for (const variant of logokitVariants(req)) {
    if (!kit.hasVariant(slug, variant)) continue;
    const hit = thesvg.resolve({ raw: req.domain, domain: req.domain, name: null }, { variant, size: 128 });
    if (hit?.slug !== slug) continue;
    const found = await download(hit.url, fetchFn);
    if (found) return found; // a stale index entry 404s; the next version may not
  }
  return null;
}

// ── the site's own icon ──────────────────────────────────────────────

interface Icon {
  href: string;
  /** Declared size in px (the larger side), 0 when not declared. */
  size: number;
  vector: boolean;
}

async function fromSiteIcon(domain: string, fetchFn: typeof fetch): Promise<Found | null> {
  let html = "";
  let base = `https://${domain}/`;
  try {
    const res = await fetchFn(base, { redirect: "follow", signal: AbortSignal.timeout(TIMEOUT_MS), headers: { accept: "text/html" } });
    if (res.ok && (res.headers.get("content-type") ?? "").includes("html")) {
      base = res.url || base;
      html = await readText(res, MAX_HTML_BYTES);
    }
  } catch {
    /* no page: the conventional path below may still answer */
  }
  const icons = declaredIcons(html, base);
  // iOS asks for this path when a page declares nothing, so many sites have it.
  icons.push({ href: new URL("/apple-touch-icon.png", base).href, size: 180, vector: false });
  const tried = new Set<string>();
  for (const icon of rankIcons(icons)) {
    if (tried.has(icon.href)) continue;
    tried.add(icon.href);
    if (tried.size > 3) break;
    const found = await download(icon.href, fetchFn);
    if (!found) continue;
    if (found.type === "image/svg+xml") return found;
    const px = pixelSize(found) ?? icon.size;
    if (px >= MIN_ICON_PX) return found;
  }
  return null;
}

const LINK_RE = /<link\b[^>]*>/gi;

/** The icons a page's <link rel="…icon…"> tags declare, with absolute URLs. */
export function declaredIcons(html: string, base: string): Icon[] {
  const out: Icon[] = [];
  for (const [tag] of html.matchAll(LINK_RE)) {
    const rel = attr(tag, "rel")?.toLowerCase() ?? "";
    // mask-icon is a one-colour silhouette for Safari's pinned tabs, not a logo.
    if (!/(^|\s)(icon|apple-touch-icon|apple-touch-icon-precomposed)(\s|$)/.test(rel)) continue;
    const href = attr(tag, "href");
    const url = href ? safeUrl(href, base) : null;
    if (!url || (url.protocol !== "https:" && url.protocol !== "http:")) continue;
    const sizes = attr(tag, "sizes")?.toLowerCase() ?? "";
    const type = attr(tag, "type")?.toLowerCase() ?? "";
    const vector = type === "image/svg+xml" || /\.svg$/i.test(url.pathname) || sizes === "any";
    const declared = Math.max(0, ...[...sizes.matchAll(/(\d+)x(\d+)/g)].map((m) => Math.max(+m[1], +m[2])));
    out.push({ href: url.href, size: declared || (rel.includes("apple-touch-icon") ? 180 : 0), vector });
  }
  return out;
}

/** Vectors first, then the largest declared size; undeclared sizes last (checked once downloaded). */
function rankIcons(icons: Icon[]): Icon[] {
  return [...icons].sort((a, b) => Number(b.vector) - Number(a.vector) || b.size - a.size);
}

function attr(tag: string, name: string): string | null {
  const m = tag.match(new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>\`]+))`, "i"));
  return m ? (m[1] ?? m[2] ?? m[3] ?? "").trim() : null;
}

/** A raster's smaller side in px, when the format says so cheaply (PNG). */
export function pixelSize(f: Found): number | null {
  const b = f.body;
  if (f.type === "image/png" && b.byteLength >= 24) {
    const w = (b[16] << 24) | (b[17] << 16) | (b[18] << 8) | b[19];
    const h = (b[20] << 24) | (b[21] << 16) | (b[22] << 8) | b[23];
    return Math.min(w, h);
  }
  return null;
}

// ── shared ───────────────────────────────────────────────────────────

function safeUrl(href: string, base?: string): URL | null {
  try {
    return new URL(href, base);
  } catch {
    return null;
  }
}

/** Download an image: bounded in time and size, and an image by its bytes, not its headers. */
async function download(url: string, fetchFn: typeof fetch): Promise<Found | null> {
  let res: Response;
  try {
    res = await fetchFn(url, { redirect: "follow", signal: AbortSignal.timeout(TIMEOUT_MS), headers: { accept: "image/*" } });
  } catch {
    return null;
  }
  if (!res.ok || Number(res.headers.get("content-length") ?? "0") > MAX_IMAGE_BYTES) return null;
  const body = new Uint8Array(await res.arrayBuffer().catch(() => new ArrayBuffer(0)));
  if (!body.byteLength || body.byteLength > MAX_IMAGE_BYTES) return null;
  const type = sniff(body);
  return type ? { body, type } : null;
}

/** At most `max` bytes of a response body, as text. */
async function readText(res: Response, max: number): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (size < max) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.byteLength;
  }
  await reader.cancel().catch(() => {});
  const all = new Uint8Array(Math.min(size, max));
  let at = 0;
  for (const c of chunks) {
    const part = c.subarray(0, all.byteLength - at);
    all.set(part, at);
    at += part.byteLength;
    if (at >= all.byteLength) break;
  }
  return new TextDecoder().decode(all);
}
