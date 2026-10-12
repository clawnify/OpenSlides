// Page formats. A deck has one format that drives the design canvas (the fixed
// pixel box every slide/page is authored on), the exported PDF's physical page
// size, and the editor's aspect ratio. "16:9" is the classic presentation deck;
// "a4-portrait" makes the same editor author print-shaped documents (one-pagers,
// info memos, branded reports).
//
// The A4 canvas is 1240×1754 — the same ~width as the 16:9 canvas — so ONE
// brand's type scale (heading/subheading/body px), the ~9% side padding and all
// template px values read the same in both formats. Print scales the canvas to
// a physically exact A4 page (210×297mm) with a single CSS transform.

export interface PageFormat {
  id: string;
  label: string;
  kind: "deck" | "document"; // wording + AI guidance: slides vs pages
  canvas: { width: number; height: number }; // authoring box (px), also the reveal.js size
  page: { width: number; height: number }; // physical PDF page in CSS px (96dpi)
  pageSizeCss: string; // the @page size rule for print
}

export const FORMATS: Record<string, PageFormat> = {
  "16:9": {
    id: "16:9",
    label: "Presentation · 16:9",
    kind: "deck",
    canvas: { width: 1280, height: 720 },
    page: { width: 1280, height: 720 },
    pageSizeCss: "1280px 720px",
  },
  "a4-portrait": {
    id: "a4-portrait",
    label: "Document · A4",
    kind: "document",
    // 210:297 at 1240 wide (A4 @150dpi) — aspect 0.70695 vs A4's 0.70707.
    canvas: { width: 1240, height: 1754 },
    // 210mm = 794 CSS px at 96dpi; the print transform is page.w / canvas.w.
    page: { width: 794, height: 1123 },
    pageSizeCss: "210mm 297mm",
  },
};

export const DEFAULT_FORMAT_ID = "16:9";

export function safeFormat(id: string | null | undefined): PageFormat {
  return FORMATS[id ?? ""] ?? FORMATS[DEFAULT_FORMAT_ID];
}

/** How much print shrinks the canvas to fit the physical page (1 for 16:9). */
export function printScale(f: PageFormat): number {
  return f.page.width / f.canvas.width;
}

/**
 * Top and bottom whitespace (canvas px) on every physical page a continuing
 * page spans (one marked `<!-- .slide: data-flow -->`). It matches the ~7% top
 * padding of designed document pages, so a continuing page lines up with its
 * neighbours.
 */
export function flowMargin(f: PageFormat): number {
  return Math.round(f.canvas.width * 0.07);
}
