import { describe, expect, it } from "vitest";
import { declaredIcons, resolveLogos, type Found, type LogoCache } from "./logos";
import { logoKey, type LogoRequest } from "./variables";

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"/>';

function png(w: number, h = w): Uint8Array {
  const b = new Uint8Array(33);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(b.buffer).setUint32(16, w);
  new DataView(b.buffer).setUint32(20, h);
  return b;
}

type Route = (init?: RequestInit) => Response;
const image = (body: Uint8Array | string, type: string): Route => () => new Response(body as BodyInit, { headers: { "content-type": type } });
const json = (data: unknown, status = 200): Route => () => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
const status = (code: number): Route => () => new Response("", { status: code });
const html = (page: string): Route => () => new Response(page, { headers: { "content-type": "text/html; charset=utf-8" } });

function setup(routes: Record<string, Route>, opts: { key?: string; now?: number } = {}) {
  const calls: { url: string; auth: string | null }[] = [];
  const store = new Map<string, { found: Found | null; storedAt: number }>();
  let now = opts.now ?? Date.UTC(2026, 9, 12);
  const cache: LogoCache = {
    get: async (k) => store.get(k) ?? null,
    put: async (k, found) => void store.set(k, { found, storedAt: now }),
  };
  const deps = {
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, auth: new Headers(init?.headers).get("authorization") });
      const route = routes[url];
      if (!route) throw new TypeError("network error");
      return route(init);
    }) as typeof fetch,
    cache,
    logoDevKey: opts.key,
    now: () => now,
  };
  return { deps, calls, store, advance: (ms: number) => void (now += ms) };
}

const req = (domain: string, shape: LogoRequest["shape"] = "square", theme: LogoRequest["theme"] = "light"): LogoRequest => ({ domain, shape, theme });
const decoded = (uri: string | null | undefined) => (uri ? atob(uri.slice(uri.indexOf(",") + 1)) : uri);

describe("logo.dev (with the org's key)", () => {
  it("asks for the symbol with the secret key and downloads it formatted for the slot", async () => {
    const t = setup(
      {
        "https://api.logo.dev/v2/brands/logo?domain=acme.com": json({ data: { url: "https://img.logo.dev/assets/TOKEN" } }),
        "https://img.logo.dev/assets/TOKEN?format=png&theme=dark&size=512": image(png(512), "image/png"),
      },
      { key: "sk_test" },
    );
    const r = await resolveLogos([req("acme.com", "square", "dark")], t.deps);
    expect(r.logos.get(logoKey(req("acme.com", "square", "dark")))).toMatch(/^data:image\/png;base64,/);
    expect(t.calls[0]).toEqual({ url: "https://api.logo.dev/v2/brands/logo?domain=acme.com", auth: "Bearer sk_test" });
    expect(t.calls[1].auth).toBeNull(); // the signed link needs no key
  });

  it("gives a full slot the wide brandmark, or the symbol when there is none", async () => {
    const t = setup(
      {
        "https://api.logo.dev/v2/brands/brandmark?domain=acme.com": status(404),
        "https://api.logo.dev/v2/brands/logo?domain=acme.com": json({ data: { url: "https://img.logo.dev/assets/SYM" } }),
        "https://img.logo.dev/assets/SYM?format=png&theme=light&size=512": image(png(512), "image/png"),
      },
      { key: "sk_test" },
    );
    const r = await resolveLogos([req("acme.com", "full")], t.deps);
    expect(r.logos.get(logoKey(req("acme.com", "full")))).toMatch(/^data:image\/png/);
    expect(t.calls.map((c) => c.url.split("?")[0])).toEqual([
      "https://api.logo.dev/v2/brands/brandmark",
      "https://api.logo.dev/v2/brands/logo",
      "https://img.logo.dev/assets/SYM",
    ]);
  });

  it("warns about a refused key, uses the free sources, and doesn't remember the outcome", async () => {
    const t = setup(
      {
        "https://api.logo.dev/v2/brands/logo?domain=stripe.com": status(401),
        "https://thesvg.org/icons/stripe/default.svg": image(SVG, "image/svg+xml"),
      },
      { key: "sk_bad" },
    );
    const r = await resolveLogos([req("stripe.com")], t.deps);
    expect(decoded(r.logos.get(logoKey(req("stripe.com"))))).toBe(SVG);
    expect(r.warnings).toEqual(["logo.dev did not answer (HTTP 401, check LOGO_DEV_SECRET_KEY), so other logo sources were used"]);
    expect(t.store.size).toBe(0);
  });

  it("never follows a download link that is not logo.dev's", async () => {
    const t = setup(
      { "https://api.logo.dev/v2/brands/logo?domain=acme.com": json({ data: { url: "https://169.254.169.254/latest" } }) },
      { key: "sk_test" },
    );
    await resolveLogos([req("acme.com")], t.deps);
    expect(t.calls.some((c) => c.url.includes("169.254"))).toBe(false);
  });
});

describe("free sources", () => {
  it("uses the brand SVG for a website the index lists, in the version made for a dark background", async () => {
    const t = setup({
      "https://thesvg.org/icons/stripe/default.svg": image(SVG, "image/svg+xml"),
      "https://thesvg.org/icons/github/dark.svg": image(SVG.replace("10 10", "20 20"), "image/svg+xml"),
    });
    const r = await resolveLogos([req("stripe.com"), req("github.com", "square", "dark")], t.deps);
    expect(decoded(r.logos.get(logoKey(req("stripe.com"))))).toBe(SVG);
    expect(decoded(r.logos.get(logoKey(req("github.com", "square", "dark"))))).toContain("20 20");
  });

  it("uses the brand's main mark for a full slot too: theSVG wordmarks often have white lettering", async () => {
    const t = setup({ "https://thesvg.org/icons/shopify/default.svg": image(SVG, "image/svg+xml") });
    const r = await resolveLogos([req("shopify.com", "full")], t.deps);
    expect(decoded(r.logos.get(logoKey(req("shopify.com", "full"))))).toBe(SVG);
    expect(t.calls.map((c) => c.url)).toEqual(["https://thesvg.org/icons/shopify/default.svg"]);
  });

  it("never takes a brand guessed from a domain's first word", async () => {
    // The index has a "harbor" brand (a container registry), not harbor.com.
    const t = setup({});
    const r = await resolveLogos([req("harbor.com")], t.deps);
    expect(t.calls.some((c) => c.url.includes("thesvg.org"))).toBe(false);
    expect(r.logos.get(logoKey(req("harbor.com")))).toBeNull();
  });

  it("falls back to the site's own icon: an SVG first, else the largest that is at least 64 px", async () => {
    const t = setup({
      "https://bakery.test/": html(`<head>
        <link rel="icon" href="/favicon-32.png" sizes="32x32">
        <link rel="apple-touch-icon" href="https://cdn.bakery.test/touch.png">
        <link rel="mask-icon" href="/pinned.svg">
      </head>`),
      "https://cdn.bakery.test/touch.png": image(png(180), "image/png"),
      "https://bakery.test/favicon-32.png": image(png(32), "image/png"),
    });
    const r = await resolveLogos([req("bakery.test")], t.deps);
    expect(r.logos.get(logoKey(req("bakery.test")))).toMatch(/^data:image\/png/);
    expect(t.calls.some((c) => c.url.endsWith("pinned.svg"))).toBe(false);
  });

  it("leaves out an icon too small to print well", async () => {
    const t = setup({
      "https://tiny.test/": html(`<link rel="icon" href="/favicon.png">`),
      "https://tiny.test/favicon.png": image(png(32), "image/png"),
    });
    const r = await resolveLogos([req("tiny.test")], t.deps);
    expect(r.logos.get(logoKey(req("tiny.test")))).toBeNull();
  });
});

describe("remembering lookups", () => {
  it("keeps a found logo for 30 days and a miss for a day", async () => {
    const t = setup({ "https://thesvg.org/icons/stripe/default.svg": image(SVG, "image/svg+xml") });
    await resolveLogos([req("stripe.com"), req("nothing.test")], t.deps);
    const first = t.calls.length;

    t.advance(20 * 86_400_000);
    await resolveLogos([req("stripe.com")], t.deps);
    expect(t.calls.length).toBe(first); // still fresh

    await resolveLogos([req("nothing.test")], t.deps);
    expect(t.calls.length).toBeGreaterThan(first); // the miss is retried after a day
  });

  it("keeps the logo.dev and free lookups apart", async () => {
    const t = setup({ "https://thesvg.org/icons/stripe/default.svg": image(SVG, "image/svg+xml") });
    await resolveLogos([req("stripe.com")], t.deps);
    expect([...t.store.keys()]).toEqual(["logos/v1/free/stripe.com/square-light"]);
  });

  it("says when a document asks for more logos than it may show", async () => {
    const t = setup({});
    const many = Array.from({ length: 51 }, (_, i) => req(`site${i}.test`));
    const r = await resolveLogos(many, t.deps);
    expect(r.warnings).toEqual(["more than 50 different logos in one document; the rest are left out"]);
    expect(r.logos.get(logoKey(many[50]))).toBeNull();
  });
});

describe("declaredIcons", () => {
  it("reads icon links with absolute URLs, sizes and vectors", () => {
    const icons = declaredIcons(
      `<link rel="shortcut icon" href="/f.ico"><link rel='icon' type='image/svg+xml' href='logo.svg'>
       <link href="/i192.png" rel="icon" sizes="192x192 512x512"><link rel="apple-touch-icon-precomposed" href="//cdn.x.test/t.png">
       <link rel="stylesheet" href="/s.css"><link rel="icon" href="javascript:alert(1)">`,
      "https://x.test/home/",
    );
    expect(icons).toEqual([
      { href: "https://x.test/f.ico", size: 0, vector: false },
      { href: "https://x.test/home/logo.svg", size: 0, vector: true },
      { href: "https://x.test/i192.png", size: 512, vector: false },
      { href: "https://cdn.x.test/t.png", size: 180, vector: false },
    ]);
  });
});
