import { describe, expect, it } from "vitest";
import { revealDoc, isFlowAttrs, slideParts } from "./reveal";
import { FORMATS } from "./formats";

const LOGO = `<img class="brand-logo" src="data:image/png;base64,AAAA" alt="" />`;
const designed = `<!-- html -->\n<div style="position:absolute;inset:0">Cover</div>`;
const flowing = `<!-- html -->\n<!-- .slide: data-flow -->\n<div style="padding:0 9%"><p>Long terms</p></div>`;

const print = (content: string, nav: "numbers" | "none" = "none") =>
  revealDoc({ mode: "print", content, theme: "white", format: FORMATS["a4-portrait"], brandHeadHtml: "", brandLogoHtml: LOGO, nav: { mode: nav } });

const count = (s: string, needle: string) => s.split(needle).length - 1;

describe("print document", () => {
  it("keeps a deck without continuing pages exactly as before: one fixed page each, one logo overlay", () => {
    const html = print(`${designed}\n\n---\n\n${designed}`, "numbers");
    expect(count(html, `<div class="pdf-page">`)).toBe(2);
    expect(html).not.toContain(`<table class="pdf-flow-frame"`);
    expect(count(html, LOGO)).toBe(1); // the position:fixed overlay, outside the pages
    expect(html).toContain(`<div class="pdf-num">1 / 2</div>`);
  });

  it("wraps a continuing page in a frame whose spacer rows repeat on every printed page", () => {
    const html = print(`${designed}\n\n---\n\n${flowing}`, "numbers");
    expect(html).toContain(`<div class="pdf-flow"><table class="pdf-flow-frame"><thead><tr><td><div class="pdf-flow-gap"></div></td></tr></thead><tfoot>`);
    expect(html).toContain("<p>Long terms</p>");
    expect(html).not.toContain("data-flow"); // the attribute line is consumed, not printed
    // The logo moves inside the designed page, so continuing pages carry none.
    expect(count(html, LOGO)).toBe(1);
    expect(html).toContain(`<div class="pdf-page">${LOGO}<div class="pdf-slide"`);
    // A continuing page spans an unknown number of pages, so no "n / total" labels.
    expect(html).not.toContain(`class="pdf-num"`);
    // Layout is scaled with zoom (breakable), not a transform.
    expect(html).toMatch(/\.pdf-flow-body\{[^}]*zoom: 0\.64/);
  });
});

describe("slide attributes", () => {
  it("reads the attribute line and spots data-flow", () => {
    expect(slideParts(flowing)).toEqual({ attrs: "data-flow", body: `<div style="padding:0 9%"><p>Long terms</p></div>` });
    expect(isFlowAttrs(`data-background-color="#fff" data-flow`)).toBe(true);
    expect(isFlowAttrs(`data-flowchart="x"`)).toBe(false);
    expect(isFlowAttrs(``)).toBe(false);
  });
});
