// Template variables: the parts of a deck or document that change per copy.
//
//   {{client.name}}              a value, in text or inside an attribute
//   <tr data-each="line_items">  repeat this element once per item of a list;
//                                inside it, names refer to the item
//   {{@root.currency}}           an outer (top-level) value, from anywhere
//   <p data-if="discount_note">  keep this element only when the value is set
//   <p data-unless="discount">   keep this element only when the value is NOT set
//   <img data-logo="client.website">  the company logo for that website, looked
//                                up before the fill (logos.ts); no website, no image
//
// Structure lives in attributes rather than in {{#section}} tags on purpose: the
// editor re-serializes a page through the browser's HTML parser on every
// click-edit, and a bare section tag inside <table>/<tbody> would be moved out
// of the table on the first edit. An attribute travels with its element.
//
// Inside a repeated element names resolve against the item ONLY, never an outer
// value. Mustache falls back outward, which in a quote turns a row's missing
// {{total}} into the grand {{total}} printed on every line. Here that gap is an
// error instead; a row that wants an outer value says so with {{@root.name}}.
//
// Values as callers send them: `client.name` resolves nested first, then as a
// literal flat key ({"client.name": …}). An explicit null prints nothing (an
// absent key is still a gap), and line breaks in a value print as line breaks.
//
// Plain string scanning, no DOM, no dependencies: the same module fills
// documents in the Worker (render API, preview, PDF export) and lists a page's
// variables in the editor bundle.

/** One variable as a caller sees it (GET /api/decks/:id/fields). */
export interface Field {
  /** Dotted path: `client.name`. Inside a list, relative to the item. */
  name: string;
  /**
   * text = a string or number · image = used as an <img src> or a CSS url(),
   * so it takes an image (https URL, data: image or an upload) · website = a
   * website or domain a data-logo image shows the company logo of · list =
   * repeated items · flag = only switches a data-if / data-unless element.
   */
  type: "text" | "image" | "website" | "list" | "flag";
  /** Every use sits inside a data-if / data-unless element (or is that switch itself), so leaving it out hides or shows that part instead of failing. */
  optional: boolean;
  /** A list's item fields. A list of plain strings has one field named `.` */
  fields?: Field[];
}

export interface FillResult {
  html: string;
  /** Paths the template needs that the values don't provide, e.g. `line_items[1].unit_price`. */
  missing: string[];
  /** Values of the wrong kind, e.g. `line_items: expected a list`. */
  invalid: string[];
  /** The logos the filled page shows, to look up before filling again with them. */
  logos: LogoRequest[];
  /** Notes that don't stop a render, e.g. a website with no logo found. */
  warnings: string[];
}

export type LogoShape = "square" | "full";
export type LogoTheme = "light" | "dark";

/** One logo to look up: a company's website, the shape the slot wants and the background it sits on. */
export interface LogoRequest {
  domain: string;
  shape: LogoShape;
  theme: LogoTheme;
}

/** Looked-up logos by logoKey(): a data: URI, or null when none was found. */
export type LogoMap = Map<string, string | null>;

export const logoKey = (r: LogoRequest) => `${r.domain} ${r.shape} ${r.theme}`;

export class TemplateTooLargeError extends Error {
  constructor() {
    super("The filled document is too large. Send fewer or shorter items.");
    this.name = "TemplateTooLargeError";
  }
}

/**
 * Upper bound on one filled page, so nested lists can't balloon the render. It
 * leaves room for embedded images (each at most 2 MB, see images.ts).
 */
const MAX_OUTPUT = 12 * 1024 * 1024;

const NAME = "[A-Za-z_][\\w-]*(?:\\.[A-Za-z_][\\w-]*)*";
const ROOT = "@root.";
// A reference: a name, optionally anchored at the top-level values.
const REF = `(?:@root\\.)?${NAME}`;
const TOKEN_RE = new RegExp(`\\{\\{\\s*(\\.|${REF})\\s*\\}\\}`, "g");
const WHOLE_TOKEN_RE = new RegExp(`^\\{\\{\\s*(\\.|${REF})\\s*\\}\\}$`);
const ANY_BRACES_RE = /\{\{[^{}]*\}\}/g;
const NAME_RE = new RegExp(`^${NAME}$`);
const REF_RE = new RegExp(`^${REF}$`);

/** Cheap check: does this content use any template syntax at all? */
export function hasTemplate(content: string): boolean {
  return /\{\{|\sdata-(?:each|if|unless|logo)\s*=/.test(content);
}

/** True when `name` is usable as a variable name (`client.name`, `total`). */
export function isValidName(name: string): boolean {
  return NAME_RE.test(name);
}

// ── HTML scanning ─────────────────────────────────────────────────────

type Node =
  | { kind: "text"; text: string }
  | { kind: "raw"; text: string } // comments, doctypes, script/style bodies: never substituted
  | { kind: "el"; name: string; start: string; end: string; children: Node[]; each: string | null; cond: string | null; unless: string | null; logo: string | null };

type El = Extract<Node, { kind: "el" }>;

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
const RAW_TEXT = new Set(["script", "style", "textarea", "title"]);
// Start tags that implicitly close an open <p>, as the HTML parser does.
const CLOSES_P = new Set([
  "address", "article", "aside", "blockquote", "details", "div", "dl", "fieldset", "figcaption", "figure",
  "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr", "main", "nav", "ol", "p", "pre",
  "section", "table", "ul",
]);
// A start tag implicitly closes the innermost open element named in `closes`
// (and everything opened inside it), unless an `until` element comes first:
// a new <tr> ends the previous row and its open cell, as the HTML parser does.
const IMPLIED: Record<string, { closes: string[]; until: string[] }> = {
  li: { closes: ["li"], until: ["ul", "ol"] },
  dt: { closes: ["dt", "dd"], until: ["dl"] },
  dd: { closes: ["dt", "dd"], until: ["dl"] },
  tr: { closes: ["tr"], until: ["table", "thead", "tbody", "tfoot"] },
  td: { closes: ["td", "th"], until: ["tr", "table"] },
  th: { closes: ["td", "th"], until: ["tr", "table"] },
  thead: { closes: ["thead", "tbody", "tfoot"], until: ["table"] },
  tbody: { closes: ["thead", "tbody", "tfoot"], until: ["table"] },
  tfoot: { closes: ["thead", "tbody", "tfoot"], until: ["table"] },
  option: { closes: ["option"], until: ["select", "datalist"] },
};

function attrValue(startTag: string, attr: string): string | null {
  const m = startTag.match(new RegExp(`\\s${attr}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>\`]+))`, "i"));
  if (!m) return null;
  return (m[1] ?? m[2] ?? m[3] ?? "").trim();
}

/** Index just past the `>` of the start tag beginning at `i`, honouring quoted attribute values. */
function startTagEnd(src: string, i: number): number {
  let quote = "";
  for (let j = i + 1; j < src.length; j++) {
    const ch = src[j];
    if (quote) {
      if (ch === quote) quote = "";
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === ">") {
      return j + 1;
    }
  }
  return -1;
}

function parse(src: string): Node[] {
  const root: El = { kind: "el", name: "#root", start: "", end: "", children: [], each: null, cond: null, unless: null, logo: null };
  const stack: El[] = [root];
  const push = (n: Node) => stack[stack.length - 1].children.push(n);

  // Close every element above and including the innermost open `names`
  // element (they keep no end tag of their own), stopping at an `until` boundary.
  const implicitlyClose = (names: string[], until: string[]) => {
    for (let k = stack.length - 1; k > 0; k--) {
      const n = stack[k].name;
      if (until.includes(n)) return;
      if (names.includes(n)) {
        stack.length = k;
        return;
      }
    }
  };

  let i = 0;
  while (i < src.length) {
    const lt = src.indexOf("<", i);
    if (lt < 0) {
      push({ kind: "text", text: src.slice(i) });
      break;
    }
    if (lt > i) push({ kind: "text", text: src.slice(i, lt) });
    i = lt;

    if (src.startsWith("<!--", i)) {
      const close = src.indexOf("-->", i + 4);
      const end = close < 0 ? src.length : close + 3;
      push({ kind: "raw", text: src.slice(i, end) });
      i = end;
      continue;
    }
    if (src[i + 1] === "!" || src[i + 1] === "?") {
      const close = src.indexOf(">", i);
      const end = close < 0 ? src.length : close + 1;
      push({ kind: "raw", text: src.slice(i, end) });
      i = end;
      continue;
    }
    const endTag = src.slice(i, i + 200).match(/^<\/([A-Za-z][\w:-]*)\s*>/);
    if (endTag) {
      const name = endTag[1].toLowerCase();
      for (let k = stack.length - 1; k > 0; k--) {
        if (stack[k].name === name) {
          stack[k].end = endTag[0];
          stack.length = k;
          break;
        }
      }
      // A stray end tag with no open element is dropped, as the parser does.
      i += endTag[0].length;
      continue;
    }
    const open = src.slice(i, i + 200).match(/^<([A-Za-z][\w:-]*)/);
    const tagEnd = open ? startTagEnd(src, i) : -1;
    if (!open || tagEnd < 0) {
      push({ kind: "text", text: "<" });
      i += 1;
      continue;
    }
    const name = open[1].toLowerCase();
    const start = src.slice(i, tagEnd);
    i = tagEnd;

    if (CLOSES_P.has(name)) implicitlyClose(["p"], ["div", "section", "td", "th", "li", "table", "blockquote"]);
    const implied = IMPLIED[name];
    if (implied) implicitlyClose(implied.closes, implied.until);

    const el: El = {
      kind: "el", name, start, end: "", children: [],
      each: attrValue(start, "data-each"), cond: attrValue(start, "data-if"), unless: attrValue(start, "data-unless"),
      logo: attrValue(start, "data-logo"),
    };
    push(el);
    if (VOID.has(name) || /\/\s*>$/.test(start)) continue;
    if (RAW_TEXT.has(name)) {
      const close = src.slice(i).search(new RegExp(`</${name}\\s*>`, "i"));
      const bodyEnd = close < 0 ? src.length : i + close;
      el.children.push({ kind: "raw", text: src.slice(i, bodyEnd) });
      const m = src.slice(bodyEnd).match(new RegExp(`^</${name}\\s*>`, "i"));
      el.end = m ? m[0] : "";
      i = bodyEnd + (m ? m[0].length : 0);
      continue;
    }
    stack.push(el);
  }
  return root.children;
}

// ── filling ───────────────────────────────────────────────────────────

interface Scope {
  value: unknown;
  /** Where this scope sits in the values, for error messages: `line_items[1]`. */
  path: string;
  /** True for a data-each item, where `{{.}}` means the item itself. */
  item: boolean;
}

interface Ctx {
  strict: boolean;
  missing: Set<string>;
  invalid: Set<string>;
  size: number;
  /** The top-level values, what {{@root.name}} reads from inside a row. */
  root: Scope;
  /** Looked-up logos; absent on the first fill, which only collects `requests`. */
  logos?: LogoMap;
  requests: Map<string, LogoRequest>;
  warnings: Set<string>;
}

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ESCAPES[c]);

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

const joinPath = (base: string, rest: string) => (base ? `${base}.${rest}` : rest);

const own = (o: Record<string, unknown>, k: string) => Object.prototype.hasOwnProperty.call(o, k);

/**
 * Resolve a dotted path in one object: nested first (`client` then `name`),
 * then as a literal flat key (`"client.name"`). Own properties only, so a name
 * like `toString` never reaches a built-in. An explicit null part-way along the
 * path makes the whole value an explicit null.
 */
function resolvePath(obj: unknown, path: string): { present: boolean; value: unknown } {
  let v: unknown = obj;
  let nested = true;
  for (const part of path.split(".")) {
    if (v === null) return { present: true, value: null };
    if (!isObject(v) || !own(v, part)) {
      nested = false;
      break;
    }
    v = v[part];
  }
  if (nested && v !== undefined) return { present: true, value: v };
  if (isObject(obj) && own(obj, path) && obj[path] !== undefined) return { present: true, value: obj[path] };
  return { present: false, value: undefined };
}

/**
 * Resolve a reference against the current scope (the item inside data-each,
 * else the top-level values), or against the top-level values for `@root.…`.
 * `found` means the caller provided the key, even as an explicit null.
 */
function lookup(expr: string, scope: Scope, ctx: Ctx): { found: boolean; value: unknown; path: string } {
  if (expr === ".") return { found: scope.item && scope.value !== undefined, value: scope.value, path: scope.path || "." };
  const base = expr.startsWith(ROOT) ? ctx.root : scope;
  const path = expr.startsWith(ROOT) ? expr.slice(ROOT.length) : expr;
  const r = resolvePath(base.value, path);
  return { found: r.present, value: r.value, path: joinPath(base.path, path) };
}

// Empty, false, 0 and [] hide a data-if element. Strings "false" and "0" count
// as false too: forms and CRMs send flags and numbers as text.
function truthy(v: unknown): boolean {
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    return s !== "" && s !== "false" && s !== "0";
  }
  return !(v === undefined || v === null || v === false || v === 0);
}

// `inText`: a value printed as page text keeps its line breaks; inside an
// attribute it is only escaped.
function substitute(text: string, scope: Scope, ctx: Ctx, inText: boolean): string {
  return text.replace(TOKEN_RE, (whole, expr: string) => {
    if (expr === "." && !scope.item) {
      ctx.invalid.add("{{.}} only works inside a data-each element");
      return whole;
    }
    const r = lookup(expr, scope, ctx);
    if (!r.found) {
      if (ctx.strict) ctx.missing.add(r.path);
      return whole; // lenient: keep the token visible so the gap shows
    }
    if (r.value === null) return ""; // an explicit null is an intentional blank
    if (typeof r.value === "string" || typeof r.value === "number" || typeof r.value === "boolean") {
      const out = escapeHtml(String(r.value));
      return inText ? out.replace(/\r\n|\r|\n/g, "<br>") : out;
    }
    ctx.invalid.add(`${r.path}: expected text, got ${Array.isArray(r.value) ? "a list" : "an object"}`);
    return whole;
  });
}

function emit(ctx: Ctx, s: string): string {
  ctx.size += s.length;
  if (ctx.size > MAX_OUTPUT) throw new TemplateTooLargeError();
  return s;
}

function renderNodes(nodes: Node[], scope: Scope, ctx: Ctx): string {
  let out = "";
  for (const n of nodes) {
    if (n.kind === "text") out += emit(ctx, substitute(n.text, scope, ctx, true));
    else if (n.kind === "raw") out += emit(ctx, n.text);
    else out += renderEl(n, scope, ctx);
  }
  return out;
}

function renderOnce(el: El, scope: Scope, ctx: Ctx): string {
  let src = "";
  if (el.logo !== null) {
    const logo = logoSrc(el.logo, el.start, scope, ctx);
    if (logo === null) return "";
    src = logo;
  }
  const start = substitute(el.start, scope, ctx, false);
  return emit(ctx, src ? setSrc(start, src) : start) + renderNodes(el.children, scope, ctx) + emit(ctx, el.end);
}

/**
 * A data-logo image's source: null leaves the image out (no website, or no logo
 * found for it), "" keeps it as written (not looked up yet), else the data: URI.
 */
function logoSrc(ref: string, start: string, scope: Scope, ctx: Ctx): string | null {
  const r = lookup(ref, scope, ctx);
  // No website hides the image, as data-if would: a logo is never required.
  if (!r.found || r.value === null || (typeof r.value === "string" && !r.value.trim())) return null;
  const domain = typeof r.value === "string" ? websiteDomain(r.value) : null;
  if (!domain) {
    ctx.invalid.add(`${r.path}: expected a website or domain, like acme.com`);
    return null;
  }
  const req: LogoRequest = { domain, ...logoOptions(start) };
  ctx.requests.set(logoKey(req), req);
  const uri = ctx.logos?.get(logoKey(req));
  if (uri === undefined) return "";
  if (uri === null) {
    ctx.warnings.add(`${r.path}: no logo found for ${domain}, so the image is left out`);
    return null;
  }
  return uri;
}

function logoOptions(start: string): { shape: LogoShape; theme: LogoTheme } {
  return {
    shape: attrValue(start, "data-logo-shape")?.toLowerCase() === "full" ? "full" : "square",
    theme: attrValue(start, "data-logo-theme")?.toLowerCase() === "dark" ? "dark" : "light",
  };
}

/** An <img> start tag with `src` set (replacing any src it had). */
export function setSrc(start: string, src: string): string {
  const without = start.replace(/\ssrc\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+)/i, "");
  return without.replace(/^<img\b/i, `<img src="${src.replace(/"/g, "&quot;")}"`);
}

/**
 * The domain a website value names: `https://www.acme.com/about`, `acme.com`
 * and `jane@acme.com` all give `acme.com`. Null when it names no public domain
 * (a company name, localhost, an IP address).
 */
export function websiteDomain(value: string): string | null {
  const s = value.trim();
  if (!s || /\s/.test(s)) return null;
  let host: string;
  try {
    host = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`).hostname;
  } catch {
    return null;
  }
  host = host.toLowerCase().replace(/\.$/, "").replace(/^www\./, "");
  return /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/.test(host) ? host : null;
}

function renderEl(el: El, scope: Scope, ctx: Ctx): string {
  // data-if decides whether the element appears at all; data-each then repeats
  // it. An absent value hides the element in both modes, so the preview shows
  // what the real document will (the template view, unfilled, shows it all).
  if (el.cond !== null) {
    const r = lookup(el.cond, scope, ctx);
    if (!(r.found && truthy(r.value))) return "";
  }
  if (el.unless !== null) {
    const r = lookup(el.unless, scope, ctx);
    if (r.found && truthy(r.value)) return "";
  }
  if (el.each === null) return renderOnce(el, scope, ctx);

  const r = lookup(el.each, scope, ctx);
  // Lenient with no usable list: one template row with an empty item, so the
  // row's own {{tokens}} stay visible.
  const templateRow = () => renderOnce(el, { value: {}, path: `${r.path}[0]`, item: true }, ctx);
  if (!r.found) {
    if (!ctx.strict) return templateRow();
    ctx.missing.add(r.path);
    return "";
  }
  if (r.value === null) return ""; // an explicit null list is an empty list
  if (!Array.isArray(r.value)) {
    ctx.invalid.add(`${r.path}: expected a list`);
    return ctx.strict ? "" : templateRow();
  }
  let out = "";
  r.value.forEach((item, idx) => {
    out += renderOnce(el, { value: item, path: `${r.path}[${idx}]`, item: true }, ctx);
  });
  return out;
}

/**
 * Fill one template (one slide/page chunk) with `values`.
 *
 * strict (the render API): every value the template reaches must be provided;
 * gaps come back in `missing` and the caller refuses to render. A data-if whose
 * value is absent simply hides its element, which is how optional parts work.
 *
 * lenient (editor preview, PDF export from the editor): fill what is there and
 * leave unset `{{tokens}}` visible.
 *
 * Sample values are never merged into strict values: a gap in a real document
 * must fail, not quietly print the sample's client name.
 */
export function fillTemplate(template: string, values: unknown, opts: FillOptions): FillResult {
  const root: Scope = { value: isObject(values) ? values : {}, path: "", item: false };
  const ctx: Ctx = {
    strict: opts.strict, missing: new Set(), invalid: new Set(), size: 0, root,
    logos: opts.logos, requests: new Map(), warnings: new Set(),
  };
  const html = renderNodes(parse(template), root, ctx);
  return { html, missing: [...ctx.missing], invalid: [...ctx.invalid], logos: [...ctx.requests.values()], warnings: [...ctx.warnings] };
}

/**
 * `logos`: the data-logo images' looked-up logos. Without it a fill only
 * collects which logos the pages need (FillResult.logos); fill again with them.
 */
export interface FillOptions {
  strict: boolean;
  logos?: LogoMap;
}

/** Fill every page of a deck; gaps across all pages are reported once each. */
export function fillPages(pages: string[], values: unknown, opts: FillOptions): Omit<FillResult, "html"> & { pages: string[] } {
  const missing = new Set<string>();
  const invalid = new Set<string>();
  const warnings = new Set<string>();
  const logos = new Map<string, LogoRequest>();
  const out = pages.map((p) => {
    const r = fillTemplate(p, values, opts);
    r.missing.forEach((m) => missing.add(m));
    r.invalid.forEach((m) => invalid.add(m));
    r.warnings.forEach((m) => warnings.add(m));
    r.logos.forEach((l) => logos.set(logoKey(l), l));
    return r.html;
  });
  return { pages: out, missing: [...missing], invalid: [...invalid], logos: [...logos.values()], warnings: [...warnings] };
}

// ── listing variables ─────────────────────────────────────────────────

interface Use {
  name: string;
  type: Field["type"];
  guarded: boolean;
  /** The data-each lists enclosing this use, outermost first. */
  lists: string[];
}

function collectUses(nodes: Node[], lists: string[], guarded: boolean, uses: Use[], problems: Set<string>): void {
  // A reference anchored at the top level (`@root.x`) is a top-level value
  // wherever it appears, even inside a row.
  const use = (ref: string, type: Field["type"], g: boolean, at: string[]) => {
    if (ref.startsWith(ROOT)) uses.push({ name: ref.slice(ROOT.length), type, guarded: g, lists: [] });
    else uses.push({ name: ref, type, guarded: g, lists: at });
  };
  // `images`: the references a start tag uses as an image source.
  const tokens = (text: string, g: boolean, at: string[], images?: Set<string>) => {
    for (const m of text.matchAll(ANY_BRACES_RE)) {
      const t = m[0].match(WHOLE_TOKEN_RE);
      if (!t) problems.add(`"${m[0]}" is not a variable: use letters, digits, _ and dots, e.g. {{client.name}}`);
      else if (t[1] === "." && !at.length) problems.add("{{.}} only works inside a data-each element");
      else use(t[1], images?.has(t[1]) ? "image" : "text", g, at);
    }
  };
  for (const n of nodes) {
    if (n.kind === "text") tokens(n.text, guarded, lists);
    else if (n.kind === "el") {
      let g = guarded;
      for (const [attr, ref] of [["data-if", n.cond], ["data-unless", n.unless]] as const) {
        if (ref === null) continue;
        if (REF_RE.test(ref)) use(ref, "flag", true, lists);
        else problems.add(`${attr}="${ref}" is not a valid variable name`);
        g = true;
      }
      let inner = lists;
      if (n.each !== null) {
        if (REF_RE.test(n.each)) {
          use(n.each, "list", g, lists);
          inner = n.each.startsWith(ROOT) ? [n.each.slice(ROOT.length)] : [...lists, n.each];
        } else problems.add(`data-each="${n.each}" is not a valid variable name`);
      }
      // The element's own attributes are filled per item too, so they read from the inner scope.
      if (n.logo !== null) {
        if (n.name !== "img") problems.add(`data-logo="${n.logo}" works on an <img> only`);
        if (REF_RE.test(n.logo)) use(n.logo, "website", true, inner);
        else problems.add(`data-logo="${n.logo}" is not a valid variable name`);
        for (const [attr, allowed] of LOGO_OPTIONS) {
          const v = attrValue(n.start, attr);
          if (v !== null && !(allowed as readonly string[]).includes(v.toLowerCase())) problems.add(`${attr}="${v}" must be ${allowed.join(" or ")}`);
        }
      }
      tokens(n.start, g, inner, imageRefs(n));
      collectUses(n.children, inner, g, uses, problems);
    }
  }
}

const LOGO_OPTIONS = [["data-logo-shape", ["square", "full"]], ["data-logo-theme", ["light", "dark"]]] as const;

const IMG_SRC_RE = new RegExp(`\\ssrc\\s*=\\s*(["'])\\s*\\{\\{\\s*(${REF})\\s*\\}\\}\\s*\\1`, "gi");
const CSS_URL_RE = new RegExp(`url\\(\\s*(["']?)\\s*\\{\\{\\s*(${REF})\\s*\\}\\}\\s*\\1\\s*\\)`, "gi");

/** References an element uses as a whole image source: an <img src="{{x}}"> or a CSS url({{x}}). */
function imageRefs(el: El): Set<string> {
  const refs = new Set<string>();
  if (el.name === "img") for (const m of el.start.matchAll(IMG_SRC_RE)) refs.add(m[2]);
  for (const m of el.start.matchAll(CSS_URL_RE)) refs.add(m[2]);
  return refs;
}

const KIND_RANK: Record<Field["type"], number> = { flag: 0, text: 1, website: 2, image: 2, list: 3 };

function buildFields(uses: Use[], depth: number, problems: Set<string>): Field[] {
  const byName = new Map<string, { field: Field; allGuarded: boolean; kinds: Set<Field["type"]> }>();
  const order: string[] = [];
  const nested = new Map<string, Use[]>(); // list name → uses inside its items

  for (const u of uses) {
    if (u.lists.length > depth) {
      const list = u.lists[depth];
      if (!nested.has(list)) nested.set(list, []);
      nested.get(list)!.push(u);
      continue;
    }
    let entry = byName.get(u.name);
    if (!entry) {
      entry = { field: { name: u.name, type: u.type, optional: true }, allGuarded: true, kinds: new Set() };
      byName.set(u.name, entry);
      order.push(u.name);
    }
    entry.kinds.add(u.type);
    if (KIND_RANK[u.type] > KIND_RANK[entry.field.type]) entry.field.type = u.type;
    if (!u.guarded) entry.allGuarded = false;
  }

  return order.map((name) => {
    const { field, allGuarded, kinds } = byName.get(name)!;
    field.optional = allGuarded;
    if (kinds.has("list") && (kinds.has("text") || kinds.has("image") || kinds.has("website"))) problems.add(`"${name}" is used both as a list (data-each) and as a value`);
    if (kinds.has("image") && kinds.has("website")) problems.add(`"${name}" is used both as an image and as a logo's website`);
    if (field.type === "list") {
      const items = buildFields(nested.get(name) ?? [], depth + 1, problems);
      // No names inside the repeated element: a list of plain strings, read with {{.}}.
      field.fields = items.length ? items : [{ name: ".", type: "text", optional: false }];
    }
    return field;
  });
}

/**
 * The variables a deck's pages use, in order of first appearance, plus any
 * malformed syntax worth telling the author about.
 */
export function collectFields(pages: string[]): { fields: Field[]; problems: string[] } {
  const uses: Use[] = [];
  const problems = new Set<string>();
  for (const p of pages) collectUses(parse(p), [], false, uses, problems);
  return { fields: buildFields(uses, 0, problems), problems: [...problems] };
}

// ── example payload ───────────────────────────────────────────────────

function getPath(obj: unknown, path: string): unknown {
  let v: unknown = obj;
  for (const part of path.split(".")) {
    if (!isObject(v)) return undefined;
    v = v[part];
  }
  return v;
}

function setPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split(".");
  let o = obj;
  for (const part of parts.slice(0, -1)) {
    if (!isObject(o[part])) o[part] = {};
    o = o[part] as Record<string, unknown>;
  }
  o[parts[parts.length - 1]] = value;
}

function exampleItem(fields: Field[], sample: unknown): unknown {
  if (fields.length === 1 && fields[0].name === ".") {
    return typeof sample === "string" || typeof sample === "number" ? sample : "<item>";
  }
  return exampleObject(fields, isObject(sample) ? sample : {});
}

function exampleObject(fields: Field[], sample: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    const s = getPath(sample, f.name);
    // An optional value with no sample is left out: absent simply hides its
    // part, while a "<note>" placeholder sent back as-is would print.
    if (f.optional && (s === undefined || s === null)) continue;
    if (f.type === "list") {
      const items = Array.isArray(s) && s.length ? s : [undefined];
      setPath(out, f.name, items.map((it) => exampleItem(f.fields ?? [], it)));
    } else if (f.type === "flag") {
      setPath(out, f.name, s === undefined ? true : s);
    } else {
      setPath(out, f.name, typeof s === "string" || typeof s === "number" ? s : `<${f.name}>`);
    }
  }
  return out;
}

/**
 * A complete request body for the render API: the stored sample values, with
 * `<name>` placeholders for required values that have none. Optional values
 * without a sample are omitted.
 */
export function exampleValues(fields: Field[], sample: unknown): Record<string, unknown> {
  return exampleObject(fields, isObject(sample) ? sample : {});
}

// ── image values ──────────────────────────────────────────────────────

export interface ImageValue {
  /** Where it sits in the values: `client.logo`, `line_items[2].icon`. */
  path: string;
  value: unknown;
}

function walkImages(
  fields: Field[],
  obj: unknown,
  base: string,
  visit: (path: string, holder: Record<string, unknown>, key: string, value: unknown) => void,
): void {
  for (const f of fields) {
    if (f.type !== "image" && f.type !== "list") continue;
    const at = locate(obj, f.name);
    if (!at) continue;
    const path = joinPath(base, f.name);
    const value = at.holder[at.key];
    if (f.type === "image") visit(path, at.holder, at.key, value);
    else if (Array.isArray(value)) value.forEach((item, i) => walkImages(f.fields ?? [], item, `${path}[${i}]`, visit));
  }
}

/** Where a dotted path's value lives, as resolvePath finds it: nested first, then a flat key. */
function locate(obj: unknown, path: string): { holder: Record<string, unknown>; key: string } | null {
  if (!isObject(obj)) return null;
  const parts = path.split(".");
  let holder: unknown = obj;
  for (const part of parts.slice(0, -1)) {
    if (!isObject(holder) || !own(holder, part)) {
      holder = null;
      break;
    }
    holder = holder[part];
  }
  const last = parts[parts.length - 1];
  if (isObject(holder) && own(holder, last) && holder[last] !== undefined) return { holder, key: last };
  if (own(obj, path) && obj[path] !== undefined) return { holder: obj, key: path };
  return null;
}

/** Every value the pages use as an image, with its path. Absent and null values are skipped. */
export function imageValues(fields: Field[], values: unknown): ImageValue[] {
  const out: ImageValue[] = [];
  walkImages(fields, values, "", (path, _h, _k, value) => {
    if (value !== null && value !== undefined) out.push({ path, value });
  });
  return out;
}

/** A copy of `values` with each image path in `replaced` swapped for its new value (e.g. an embedded data: URI). */
export function withImages(fields: Field[], values: unknown, replaced: Map<string, string>): Record<string, unknown> {
  const copy = (isObject(values) ? structuredClone(values) : {}) as Record<string, unknown>;
  walkImages(fields, copy, "", (path, holder, key) => {
    const next = replaced.get(path);
    if (next !== undefined) holder[key] = next;
  });
  return copy;
}

/** Top-level keys a caller sent that no page uses: most likely a typo. A flat key (`"client.name"`) counts as used. */
export function unusedKeys(fields: Field[], values: unknown): string[] {
  if (!isObject(values)) return [];
  const heads = new Set(fields.map((f) => f.name.split(".")[0]));
  const names = new Set(fields.map((f) => f.name));
  return Object.keys(values).filter((k) => !heads.has(k) && !names.has(k));
}
