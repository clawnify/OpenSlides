import { describe, expect, it } from "vitest";
import { collectFields, exampleValues, fillPages, fillTemplate, hasTemplate, imageValues, logoKey, TemplateTooLargeError, unusedKeys, websiteDomain, withImages } from "./variables";

const QUOTE = `<!-- html -->
<!-- .slide: data-flow -->
<div style="padding:0 9%">
  <h2>Quote for {{client.name}}</h2>
  <img src="{{client.logo}}" alt="">
  <table>
    <thead><tr><th>Item</th><th>Total</th></tr></thead>
    <tbody>
      <tr data-each="line_items">
        <td>{{name}}<div class="sub" data-if="note">{{note}}</div></td>
        <td>{{total}}</td>
      </tr>
    </tbody>
  </table>
  <p>Total {{total}}</p>
  <ul><li data-each="includes">{{.}}</li></ul>
</div>`;

const VALUES = {
  client: { name: "Harbor & Pine", logo: "https://example.com/logo.png" },
  total: "€1,500.00",
  line_items: [
    { name: "Care plan", total: "€1,500.00" },
    { name: "Setup fee", total: "€0.00", note: "after 100% discount" },
  ],
  includes: ["Unlimited users", "Standard support"],
};

describe("fillTemplate", () => {
  it("fills values, repeats rows and escapes HTML", () => {
    const r = fillTemplate(QUOTE, VALUES, { strict: true });
    expect(r.missing).toEqual([]);
    expect(r.invalid).toEqual([]);
    expect(r.html).toContain("Quote for Harbor &amp; Pine");
    expect(r.html).toContain('src="https://example.com/logo.png"');
    expect(r.html.match(/<tr data-each/g)).toHaveLength(2);
    expect(r.html).toContain("<td>Care plan</td>"); // no note on this row, so no note element
    expect(r.html).toContain(`<td>Setup fee<div class="sub" data-if="note">after 100% discount</div></td>`);
    expect(r.html).toContain("after 100% discount");
    expect(r.html.match(/class="sub"/g)).toHaveLength(1); // the note shows only on the row that has one
    expect(r.html).toContain("<li data-each=\"includes\">Unlimited users</li><li data-each=\"includes\">Standard support</li>");
    expect(r.html).toContain("<!-- .slide: data-flow -->"); // comments pass through untouched
  });

  it("never lets a value inject markup, in text or in an attribute", () => {
    const r = fillTemplate(`<p title="{{x}}">{{x}}</p>`, { x: `"><script>alert(1)</script>` }, { strict: true });
    expect(r.html).not.toContain("<script>");
    expect(r.html).toBe(`<p title="&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;">&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;</p>`);
  });

  it("reports every gap with its full path in strict mode", () => {
    const r = fillTemplate(QUOTE, { ...VALUES, client: { name: "A" }, line_items: [{ name: "x" }, { total: "1" }] }, { strict: true });
    expect(r.missing.sort()).toEqual(["client.logo", "line_items[0].total", "line_items[1].name"].sort());
  });

  it("does not fall back to an outer value inside a repeated row", () => {
    // The row's {{total}} must not silently become the quote's grand total.
    const r = fillTemplate(`<p>{{total}}</p><div data-each="rows">{{total}}</div>`, { total: "GRAND", rows: [{}] }, { strict: true });
    expect(r.missing).toEqual(["rows[0].total"]);
  });

  it("treats a missing data-if value as hidden, not as an error", () => {
    const r = fillTemplate(`<p data-if="discount">Discount {{discount}}</p><p>Always</p>`, {}, { strict: true });
    expect(r.missing).toEqual([]);
    expect(r.html).toBe("<p>Always</p>");
  });

  it("hides data-if elements for empty values and shows them for set ones", () => {
    const tpl = `<p data-if="a">A</p><p data-if="b">B</p><p data-if="c">C</p><p data-if="d">D</p>`;
    const r = fillTemplate(tpl, { a: "", b: [], c: 0, d: "yes" }, { strict: true });
    expect(r.html).toBe(`<p data-if="d">D</p>`);
  });

  it("rejects values of the wrong kind", () => {
    const r = fillTemplate(`<p>{{client}}</p><div data-each="rows">x</div>`, { client: { name: "A" }, rows: "nope" }, { strict: true });
    expect(r.invalid.sort()).toEqual(["client: expected text, got an object", "rows: expected a list"]);
  });

  it("renders an empty list as no rows", () => {
    const r = fillTemplate(`<ul><li data-each="xs">{{.}}</li></ul>`, { xs: [] }, { strict: true });
    expect(r.html).toBe("<ul></ul>");
  });

  it("handles nested lists", () => {
    const tpl = `<section data-each="groups"><h3>{{title}}</h3><p data-each="items">{{label}}</p></section>`;
    const r = fillTemplate(tpl, { groups: [{ title: "G1", items: [{ label: "a" }, { label: "b" }] }, { title: "G2", items: [] }] }, { strict: true });
    expect(r.missing).toEqual([]);
    expect(r.html.replace(/ data-each="\w+"/g, "")).toBe("<section><h3>G1</h3><p>a</p><p>b</p></section><section><h3>G2</h3></section>");
  });

  it("keeps unset tokens visible in lenient mode and shows one template row", () => {
    const r = fillTemplate(`<p>{{a}}</p><tr data-each="rows"><td>{{name}}</td></tr><p>{{b}}</p>`, { a: "A" }, { strict: false });
    expect(r.missing).toEqual([]);
    expect(r.html).toBe(`<p>A</p><tr data-each="rows"><td>{{name}}</td></tr><p>{{b}}</p>`);
  });

  it("hides an optional part with no value in lenient mode too, as the real document will", () => {
    const r = fillTemplate(`<div data-each="rows">{{name}}<small data-if="note">{{note}}</small></div>`, { rows: [{ name: "x" }] }, { strict: false });
    expect(r.html).toBe(`<div data-each="rows">x</div>`);
  });

  it("leaves scripts, styles and comments alone", () => {
    const tpl = `<script type="text/x-infographic">title {{a}}</script><style>.x{}</style><!-- {{a}} --><p>{{a}}</p>`;
    expect(fillTemplate(tpl, { a: "Z" }, { strict: true }).html).toBe(`<script type="text/x-infographic">title {{a}}</script><style>.x{}</style><!-- {{a}} --><p>Z</p>`);
  });

  it("repeats a row whose end tag is implied", () => {
    const r = fillTemplate(`<table><tr data-each="rows"><td>{{n}}<tr><td>after</td></table>`, { rows: [{ n: 1 }, { n: 2 }] }, { strict: true });
    expect(r.html).toBe(`<table><tr data-each="rows"><td>1<tr data-each="rows"><td>2<tr><td>after</td></table>`);
  });

  it("accepts > inside quoted attributes", () => {
    const r = fillTemplate(`<div data-each="rows" title="a > b">{{n}}</div>`, { rows: [{ n: 1 }] }, { strict: true });
    expect(r.html).toBe(`<div data-each="rows" title="a > b">1</div>`);
  });

  it("refuses a fill that would blow up in size", () => {
    const rows = Array.from({ length: 3000 }, () => ({ n: "x".repeat(5000) }));
    expect(() => fillTemplate(`<p data-each="rows">{{n}}</p>`, { rows }, { strict: true })).toThrow(TemplateTooLargeError);
  });
});

describe("values as callers send them", () => {
  it("reads an outer value inside a row only when asked with @root", () => {
    const tpl = `<tr data-each="rows"><td>{{amount}} {{@root.currency}}</td></tr>`;
    const r = fillTemplate(tpl, { currency: "EUR", rows: [{ amount: "10" }, { amount: "20" }] }, { strict: true });
    expect(r.missing).toEqual([]);
    expect(r.html).toBe(`<tr data-each="rows"><td>10 EUR</td></tr><tr data-each="rows"><td>20 EUR</td></tr>`);
    // Still no silent fallback: a plain {{currency}} in the row is the item's own field.
    expect(fillTemplate(`<p data-each="rows">{{currency}}</p>`, { currency: "EUR", rows: [{}] }, { strict: true }).missing).toEqual(["rows[0].currency"]);
    // A missing @root value is reported by its top-level path.
    expect(fillTemplate(tpl, { rows: [{ amount: "1" }] }, { strict: true }).missing).toEqual(["currency"]);
  });

  it("accepts @root in data-if, data-unless and data-each", () => {
    const tpl = `<div data-each="rows"><b data-if="@root.vip">VIP</b><i data-unless="@root.vip">std</i><u data-each="@root.tags">{{.}}</u></div>`;
    const r = fillTemplate(tpl, { vip: true, tags: ["a"], rows: [{}] }, { strict: true });
    expect(r.html.replace(/ data-\w+="[^"]*"/g, "")).toBe("<div><b>VIP</b><u>a</u></div>");
  });

  it("fills a dotted name from a flat key, nested first", () => {
    expect(fillTemplate(`<p>{{client.name}}</p>`, { "client.name": "Flat" }, { strict: true }).html).toBe("<p>Flat</p>");
    expect(fillTemplate(`<p>{{client.name}}</p>`, { client: { name: "Nested" }, "client.name": "Flat" }, { strict: true }).html).toBe("<p>Nested</p>");
    expect(fillTemplate(`<li data-each="plan.items">{{.}}</li>`, { "plan.items": ["x"] }, { strict: true }).html).toBe(`<li data-each="plan.items">x</li>`);
  });

  it("prints an explicit null as nothing, but still fails on an absent key", () => {
    const tpl = `<p>[{{a}}]</p><p>[{{client.name}}]</p><i data-each="rows">{{.}}</i>`;
    const r = fillTemplate(tpl, { a: null, client: null, rows: null }, { strict: true });
    expect(r.missing).toEqual([]);
    expect(r.html).toBe("<p>[]</p><p>[]</p>");
    expect(fillTemplate(`<p>{{a}}</p>`, {}, { strict: true }).missing).toEqual(["a"]);
    // A null item in a list of strings prints nothing too.
    expect(fillTemplate(`<i data-each="xs">[{{.}}]</i>`, { xs: ["a", null] }, { strict: true }).html).toBe(`<i data-each="xs">[a]</i><i data-each="xs">[]</i>`);
  });

  it("treats the strings false and 0 as false in data-if", () => {
    const tpl = `<p data-if="a">A</p><p data-if="b">B</p><p data-if="c">C</p><p data-if="d">D</p><p data-if="e">E</p>`;
    const r = fillTemplate(tpl, { a: "false", b: " FALSE ", c: "0", d: "no", e: "   " }, { strict: true });
    expect(r.html).toBe(`<p data-if="d">D</p>`);
  });

  it("keeps line breaks in page text, escaped, but not in attributes", () => {
    const r = fillTemplate(`<p title="{{a}}">{{a}}</p>`, { a: "12 Quay St\r\nRotterdam\n<b>" }, { strict: true });
    expect(r.html).toBe(`<p title="12 Quay St\r\nRotterdam\n&lt;b&gt;">12 Quay St<br>Rotterdam<br>&lt;b&gt;</p>`);
  });

  it("shows a data-unless element only when its value is not set", () => {
    const tpl = `<p data-unless="discount">No discount</p>`;
    expect(fillTemplate(tpl, {}, { strict: true }).html).toBe(tpl);
    expect(fillTemplate(tpl, { discount: "" }, { strict: true }).html).toBe(tpl);
    expect(fillTemplate(tpl, { discount: "10%" }, { strict: true }).html).toBe("");
  });

  it("never resolves a name to a built-in property", () => {
    expect(fillTemplate(`<p>{{toString}}</p>`, {}, { strict: true }).missing).toEqual(["toString"]);
  });
});

describe("fillPages", () => {
  it("reports each gap once across pages", () => {
    const r = fillPages([`<p>{{a}}</p>`, `<p>{{a}} {{b}}</p>`], { b: "B" }, { strict: true });
    expect(r.missing).toEqual(["a"]);
  });
});

describe("collectFields", () => {
  it("lists values, lists with their item fields, and optional parts", () => {
    const { fields, problems } = collectFields([QUOTE]);
    expect(problems).toEqual([]);
    expect(fields).toEqual([
      { name: "client.name", type: "text", optional: false },
      { name: "client.logo", type: "image", optional: false },
      {
        name: "line_items",
        type: "list",
        optional: false,
        fields: [
          { name: "name", type: "text", optional: false },
          { name: "note", type: "text", optional: true },
          { name: "total", type: "text", optional: false },
        ],
      },
      { name: "total", type: "text", optional: false },
      { name: "includes", type: "list", optional: false, fields: [{ name: ".", type: "text", optional: false }] },
    ]);
  });

  it("reads a data-if-only name as an optional flag", () => {
    expect(collectFields([`<p data-if="show_terms">Terms</p>`]).fields).toEqual([{ name: "show_terms", type: "flag", optional: true }]);
  });

  it("lists a data-unless name as an optional flag and guards its content", () => {
    expect(collectFields([`<p data-unless="discount">No discount for {{client}}</p>`]).fields).toEqual([
      { name: "discount", type: "flag", optional: true },
      { name: "client", type: "text", optional: true },
    ]);
  });

  it("lists an @root reference inside a row as a top-level value, not an item field", () => {
    const { fields, problems } = collectFields([`<tr data-each="rows"><td>{{amount}} {{@root.currency}}</td></tr>`]);
    expect(problems).toEqual([]);
    expect(fields).toEqual([
      { name: "rows", type: "list", optional: false, fields: [{ name: "amount", type: "text", optional: false }] },
      { name: "currency", type: "text", optional: false },
    ]);
  });

  it("flags malformed syntax", () => {
    const { problems } = collectFields([`<p>{{ client name }}</p><p>{{.}}</p><div data-each="9x"></div>`]);
    expect(problems).toHaveLength(3);
  });
});

describe("image variables", () => {
  const TPL = `<img data-if="client.logo" src="{{client.logo}}" alt="{{client.name}}">
<div style="background:url('{{hero}}') center/cover"></div>
<img src="https://cdn.test/{{slug}}.png">
<tr data-each="rows"><td><img src="{{icon}}"> {{label}} <img src="{{@root.badge}}"></td></tr>`;

  it("types a variable used as a whole image source as image", () => {
    const { fields } = collectFields([TPL]);
    const byName = Object.fromEntries(fields.map((f) => [f.name, f.type]));
    expect(byName).toMatchObject({ "client.logo": "image", "client.name": "text", hero: "image", slug: "text", rows: "list", badge: "image" });
    expect(fields.find((f) => f.name === "rows")!.fields).toEqual([
      { name: "icon", type: "image", optional: false },
      { name: "label", type: "text", optional: false },
    ]);
  });

  it("finds every image value with its path, nested, flat and per row", () => {
    const { fields } = collectFields([TPL]);
    const values = { "client.logo": "L", client: { name: "N" }, hero: null, rows: [{ icon: "I0" }, { label: "no icon" }], badge: "B" };
    expect(imageValues(fields, values)).toEqual([
      { path: "client.logo", value: "L" },
      { path: "rows[0].icon", value: "I0" },
      { path: "badge", value: "B" },
    ]);
  });

  it("swaps resolved images into a copy of the values, wherever each was found", () => {
    const { fields } = collectFields([TPL]);
    const values = { "client.logo": "L", client: { name: "N" }, rows: [{ icon: "I0", label: "x" }], badge: "B" };
    const out = withImages(fields, values, new Map([["client.logo", "data:L"], ["rows[0].icon", "data:I0"], ["badge", "data:B"]]));
    expect(out).toEqual({ "client.logo": "data:L", client: { name: "N" }, rows: [{ icon: "data:I0", label: "x" }], badge: "data:B" });
    expect(values["client.logo"]).toBe("L"); // the caller's object is untouched
  });
});

describe("exampleValues", () => {
  it("builds a complete body from samples, with placeholders only for required values", () => {
    const { fields } = collectFields([QUOTE]);
    const ex = exampleValues(fields, { client: { name: "Harbor & Pine" }, line_items: [{ name: "Care plan", total: "€1" }] });
    expect(ex).toEqual({
      client: { name: "Harbor & Pine", logo: "<client.logo>" },
      line_items: [{ name: "Care plan", total: "€1" }], // optional `note` has no sample: omitted, not "<note>"
      total: "<total>",
      includes: ["<item>"],
    });
    // The example itself fills cleanly, so a caller can start from it.
    expect(fillTemplate(QUOTE, ex, { strict: true }).missing).toEqual([]);
  });
});

describe("helpers", () => {
  it("spots template syntax", () => {
    expect(hasTemplate("<p>plain</p>")).toBe(false);
    expect(hasTemplate("<p>{{a}}</p>")).toBe(true);
    expect(hasTemplate(`<tr data-each="x">`)).toBe(true);
  });

  it("names top-level keys no page uses", () => {
    const { fields } = collectFields([QUOTE]);
    expect(unusedKeys(fields, { client: {}, totl: "1" })).toEqual(["totl"]);
  });

  it("does not report a flat dotted key as unused", () => {
    const { fields } = collectFields([QUOTE]);
    expect(unusedKeys(fields, { "client.name": "A", "client.nmae": "B" })).toEqual(["client.nmae"]);
  });

  it("spots data-unless as template syntax", () => {
    expect(hasTemplate(`<p data-unless="x">`)).toBe(true);
  });
});

describe("company logos (data-logo)", () => {
  const PAGE = `<div><img data-logo="client.website" data-logo-shape="full" alt="" style="height:40px"><p>{{client.name}}</p></div>`;
  const ROWS = `<ul><li data-each="partners"><img data-logo="site" data-logo-theme="dark" src="x.png"></li></ul>`;

  it("lists the website as an optional website field, required once it is also printed", () => {
    expect(collectFields([PAGE]).fields).toEqual([
      { name: "client.website", type: "website", optional: true },
      { name: "client.name", type: "text", optional: false },
    ]);
    const printed = collectFields([`${PAGE}<p>{{client.website}}</p>`]).fields.find((f) => f.name === "client.website");
    expect(printed).toEqual({ name: "client.website", type: "website", optional: false });
    expect(collectFields([ROWS]).fields).toEqual([
      { name: "partners", type: "list", optional: false, fields: [{ name: "site", type: "website", optional: true }] },
    ]);
    expect(hasTemplate(`<img data-logo="client.website">`)).toBe(true);
  });

  it("reports misuse", () => {
    const { problems } = collectFields([
      `<div data-logo="client.website"></div><img data-logo="bad name"><img data-logo="a" data-logo-shape="round" data-logo-theme="Dark"><img data-logo="b"><img src="{{b}}">`,
    ]);
    expect(problems).toEqual([
      'data-logo="client.website" works on an <img> only',
      'data-logo="bad name" is not a valid variable name',
      'data-logo-shape="round" must be square or full',
      '"b" is used both as an image and as a logo\'s website',
    ]);
  });

  it("collects the logos to look up, then shows them, and leaves out one not found", () => {
    const values = { client: { name: "Acme", website: "https://www.Acme.com/about" } };
    const first = fillTemplate(PAGE, values, { strict: true });
    expect(first.missing).toEqual([]);
    expect(first.logos).toEqual([{ domain: "acme.com", shape: "full", theme: "light" }]);
    expect(first.html).toContain('<img data-logo="client.website"'); // unchanged until looked up

    const key = logoKey(first.logos[0]);
    const shown = fillTemplate(PAGE, values, { strict: true, logos: new Map([[key, "data:image/png;base64,AAAA"]]) });
    expect(shown.html).toContain('<img src="data:image/png;base64,AAAA" data-logo="client.website"');
    expect(shown.warnings).toEqual([]);

    const none = fillTemplate(PAGE, values, { strict: true, logos: new Map([[key, null]]) });
    expect(none.html).not.toContain("<img");
    expect(none.warnings).toEqual(["client.website: no logo found for acme.com, so the image is left out"]);
  });

  it("hides the image without a website, and refuses a value that is not one", () => {
    for (const website of [undefined, null, "", "  "]) {
      const r = fillTemplate(PAGE, { client: { name: "Acme", website } }, { strict: true });
      expect(r.html).not.toContain("<img");
      expect(r.missing).toEqual([]);
      expect(r.logos).toEqual([]);
    }
    const bad = fillTemplate(PAGE, { client: { name: "Acme", website: "Acme Inc" } }, { strict: true });
    expect(bad.invalid).toEqual(["client.website: expected a website or domain, like acme.com"]);
    expect(bad.html).not.toContain("<img");
  });

  it("looks up a logo per row, replacing any src the image had", () => {
    const values = { partners: [{ site: "stripe.com" }, { site: "linear.app" }, { site: "stripe.com" }] };
    const first = fillPages([ROWS], values, { strict: true });
    expect(first.logos).toEqual([
      { domain: "stripe.com", shape: "square", theme: "dark" },
      { domain: "linear.app", shape: "square", theme: "dark" },
    ]);
    const logos = new Map(first.logos.map((l) => [logoKey(l), `data:image/svg+xml;base64,${l.domain}`]));
    const html = fillPages([ROWS], values, { strict: true, logos }).pages[0];
    expect(html.match(/<img src="data:image\/svg\+xml;base64,(stripe\.com|linear\.app)" data-logo="site" data-logo-theme="dark">/g)).toHaveLength(3);
    expect(html).not.toContain("x.png");
  });
});

describe("websiteDomain", () => {
  it("reads a domain from the ways people write a website", () => {
    expect(websiteDomain("acme.com")).toBe("acme.com");
    expect(websiteDomain("https://www.Acme.com/about?x=1")).toBe("acme.com");
    expect(websiteDomain("http://shop.acme.co.uk:8080/")).toBe("shop.acme.co.uk");
    expect(websiteDomain("jane@acme.com")).toBe("acme.com");
    expect(websiteDomain(" www.harborandpine.nl/ ")).toBe("harborandpine.nl");
    expect(websiteDomain("café.fr")).toBe("xn--caf-dma.fr");
  });
  it("refuses what names no public domain", () => {
    for (const v of ["Acme Inc", "acme", "localhost", "192.168.1.1", "[::1]", "http://", "acme.c", "acme.com/about us"]) {
      expect(websiteDomain(v)).toBeNull();
    }
  });
});
