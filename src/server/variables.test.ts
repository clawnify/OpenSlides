import { describe, expect, it } from "vitest";
import { collectFields, exampleValues, fillPages, fillTemplate, hasTemplate, TemplateTooLargeError, unusedKeys } from "./variables";

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
    const rows = Array.from({ length: 3000 }, () => ({ n: "x".repeat(2000) }));
    expect(() => fillTemplate(`<p data-each="rows">{{n}}</p>`, { rows }, { strict: true })).toThrow(TemplateTooLargeError);
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
      { name: "client.logo", type: "text", optional: false },
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

  it("flags malformed syntax", () => {
    const { problems } = collectFields([`<p>{{ client name }}</p><p>{{.}}</p><div data-each="9x"></div>`]);
    expect(problems).toHaveLength(3);
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
});
