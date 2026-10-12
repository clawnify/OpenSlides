// Renders a print-mode reveal.js HTML doc to PDF via Clawnify's managed PDF
// service (the same primitive open-books uses for invoices). The service runs
// Cloudflare Browser Rendering's page.pdf() under the hood — see
// services.clawnify.com/pdf/render. Slides come back one-per-page because the
// HTML puts reveal.js into print-pdf mode (pdfMaxPagesPerSlide: 1).

export class PdfRenderError extends Error {
  constructor(message: string, readonly status?: number, readonly detail?: string) {
    super(message);
    this.name = "PdfRenderError";
  }
}

function deckPdfRequest(html: string, page: { width: number; height: number }) {
  return {
    html,
    // Render at exactly the physical page size of the deck's format. The doc's
    // layout is fixed px, but pinning the viewport keeps the renderer from
    // introducing any scaling of its own.
    viewport: { width: page.width, height: page.height },
    // The print doc injects `@page { size: …; margin: 0 }` for its format.
    // prefer_css_page_size makes Browser Rendering honor that exact page size
    // instead of defaulting to Letter portrait — without it every page block
    // lands in the top strip and the rest bleeds onto the next page.
    // (Cloudflare's REST /pdf supports preferCSSPageSize/format, not pixel
    // width/height, so we drive the size from the document's own CSS.)
    prefer_css_page_size: true,
    print_background: true,
    margin: { top: "0", right: "0", bottom: "0", left: "0" },
  };
}

export async function renderDeckPdf(
  token: string,
  html: string,
  page: { width: number; height: number } = { width: 1280, height: 720 },
): Promise<ArrayBuffer> {
  const res = await fetch("https://services.clawnify.com/pdf/render", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(deckPdfRequest(html, page)),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new PdfRenderError(
      `PDF service responded ${res.status}`,
      res.status,
      detail.slice(0, 500),
    );
  }
  return res.arrayBuffer();
}

// A presigned link to a stored render (`output:"url"`): remote agents calling
// through API proxies can't receive binary bodies, so they fetch the file from
// this URL (or hand it to a vision call) instead.
export interface RenderLink {
  url: string;
  expires_at: string;
  size: number;
  content_type: string;
}

// The same deck PDF, stored by the service and returned as a presigned link:
// what the render API hands to agents, which can't receive the bytes.
export async function renderDeckPdfLink(
  token: string,
  html: string,
  page: { width: number; height: number },
  opts: { filename: string; expiresIn: number },
): Promise<RenderLink> {
  const res = await fetch("https://services.clawnify.com/pdf/render", {
    method: "POST",
    headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ ...deckPdfRequest(html, page), output: "url", filename: opts.filename, expires_in: opts.expiresIn }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new PdfRenderError(`PDF service responded ${res.status}`, res.status, detail.slice(0, 500));
  }
  const link = (await res.json()) as RenderLink;
  return { url: link.url, expires_at: link.expires_at, size: link.size, content_type: link.content_type };
}

export async function renderSlidePngLink(
  token: string,
  html: string,
  size: { width: number; height: number } = { width: 1280, height: 720 },
  opts: { filename?: string } = {},
): Promise<RenderLink> {
  const res = await fetch("https://services.clawnify.com/screenshot/render", {
    method: "POST",
    headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      html,
      width: size.width,
      height: size.height,
      type: "png",
      output: "url",
      filename: opts.filename ?? "slide.png",
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new PdfRenderError(`Screenshot service responded ${res.status}`, res.status, detail.slice(0, 500));
  }
  return res.json();
}

// Render one slide's HTML to a PNG via the managed screenshot service. Used to
// show a deck slide to an agent (in-app self-check + the REST preview endpoint)
// so it can verify the slide rendered correctly. Same auth as the PDF service.
export async function renderSlidePng(
  token: string,
  html: string,
  size: { width: number; height: number } = { width: 1280, height: 720 },
  // jpeg + quality shrinks the payload ~5x — used where the image feeds a model
  // loop (many images per conversation) rather than a human download.
  // waitForSelector: capture only once the page's own script appends this
  // element (JS-heavy documents, e.g. pdf.js rasterizing a page to canvas).
  opts: { type?: "png" | "jpeg"; quality?: number; waitForSelector?: string } = {},
): Promise<ArrayBuffer> {
  const res = await fetch("https://services.clawnify.com/screenshot/render", {
    method: "POST",
    headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      html,
      width: size.width,
      height: size.height,
      type: opts.type ?? "png",
      ...(opts.quality !== undefined ? { quality: opts.quality } : {}),
      ...(opts.waitForSelector ? { wait_for_selector: opts.waitForSelector } : {}),
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new PdfRenderError(`Screenshot service responded ${res.status}`, res.status, detail.slice(0, 500));
  }
  return res.arrayBuffer();
}
