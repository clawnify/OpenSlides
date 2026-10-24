import { describe, expect, it } from "vitest";
import { MAX_IMAGE_BYTES, resolveImages, sniff, type ImageDeps } from "./images";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

function deps(routes: Record<string, () => Response | Promise<Response>>, assets: Record<string, { data: ArrayBuffer; contentType: string }> = {}): ImageDeps & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    fetch: (async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      const route = routes[url];
      if (!route) throw new TypeError("network error");
      return route();
    }) as typeof fetch,
    getAsset: async (key) => assets[key] ?? null,
  };
}

const png = (type = "image/png") => () => new Response(PNG, { headers: { "content-type": type } });

describe("resolveImages", () => {
  it("embeds a fetched image as a data URI, once per distinct URL", async () => {
    const d = deps({ "https://acme.test/logo.png": png() });
    const r = await resolveImages(
      [{ path: "client.logo", value: "https://acme.test/logo.png" }, { path: "footer.logo", value: " https://acme.test/logo.png " }],
      d,
    );
    expect(r.invalid).toEqual([]);
    expect(r.replaced.get("client.logo")).toMatch(/^data:image\/png;base64,/);
    expect(r.replaced.get("footer.logo")).toBe(r.replaced.get("client.logo"));
    expect(d.calls).toHaveLength(1);
  });

  it("recognises an image a server labels as something else", async () => {
    const r = await resolveImages([{ path: "a", value: "https://cdn.test/x" }], deps({ "https://cdn.test/x": png("application/octet-stream") }));
    expect(r.replaced.get("a")).toMatch(/^data:image\/png;base64,/);
  });

  it("names the variable and the reason when an image can't be used", async () => {
    const d = deps({
      "https://acme.test/404.png": () => new Response("nope", { status: 404 }),
      "https://acme.test/page": () => new Response("<html></html>", { headers: { "content-type": "text/html" } }),
      "https://acme.test/huge.png": () => new Response(PNG, { headers: { "content-type": "image/png", "content-length": String(MAX_IMAGE_BYTES + 1) } }),
      "https://acme.test/slow.png": () => { throw Object.assign(new Error("timed out"), { name: "TimeoutError" }); },
    });
    const r = await resolveImages(
      [
        { path: "a", value: "https://acme.test/404.png" },
        { path: "b", value: "https://acme.test/page" },
        { path: "c", value: "https://acme.test/huge.png" },
        { path: "d", value: "https://acme.test/slow.png" },
        { path: "e", value: "https://acme.test/unreachable.png" },
        { path: "f", value: "javascript:alert(1)" },
        { path: "g", value: "data:text/html;base64,PGI+" },
        { path: "h", value: 42 },
      ],
      d,
    );
    expect(r.invalid).toEqual([
      "h: expected an image (an https URL, a data:image URI or an upload)",
      "a: image could not be loaded (HTTP 404)",
      "b: the URL did not return an image (text/html)",
      "c: image is larger than 2 MB",
      "d: image could not be loaded (timed out)",
      "e: image could not be loaded (network error)",
      "f: expected an https URL, a data:image URI or an upload (assets/<key>)",
      "g: a data: URI must be an image (data:image/…)",
    ]);
    expect(r.replaced.size).toBe(0);
  });

  it("embeds an upload of this app and reports it as used, and refuses an unknown one or a non-image", async () => {
    const r = await resolveImages(
      [{ path: "a", value: "assets/logo.png" }, { path: "b", value: "assets/gone.png" }, { path: "c", value: "assets/terms.pdf" }],
      deps({}, {
        "logo.png": { data: PNG.buffer.slice(0), contentType: "image/png" },
        "terms.pdf": { data: new TextEncoder().encode("%PDF-1.7").buffer as ArrayBuffer, contentType: "application/pdf" },
      }),
    );
    expect(r.replaced.get("a")).toMatch(/^data:image\/png;base64,/);
    expect(r.usedAssets).toEqual(["logo.png"]);
    expect(r.invalid).toEqual([
      "b: no upload named gone.png in this app (an upload no page uses is removed a few minutes after it is made)",
      "c: the upload is not an image (application/pdf)",
    ]);
  });

  it("counts uploads toward the per-image limit, as embedded images", async () => {
    const big = new Uint8Array(MAX_IMAGE_BYTES + 1);
    big.set(PNG);
    const r = await resolveImages([{ path: "a", value: "assets/huge.png" }], deps({}, { "huge.png": { data: big.buffer, contentType: "image/png" } }));
    expect(r.invalid).toEqual(["a: image is larger than 2 MB"]);
  });

  it("keeps a data: image and an intentional blank as they are", async () => {
    const r = await resolveImages([{ path: "a", value: "data:image/png;base64,iVBORw0KGgo=" }, { path: "b", value: "" }], deps({}));
    expect(r.invalid).toEqual([]);
    expect(r.replaced.get("a")).toBe("data:image/png;base64,iVBORw0KGgo=");
    expect(r.replaced.get("b")).toBe("");
  });

  it("caps what a document's images add up to", async () => {
    const big = "data:image/png;base64," + "A".repeat(2_500_000); // ~1.9 MB decoded, under the per-image cap
    const values = Array.from({ length: 5 }, (_, i) => ({ path: `p${i}`, value: `${big}${i}` }));
    const r = await resolveImages(values, deps({}));
    expect(r.invalid).toEqual([
      "p2: the document's images add up to more than 4 MB",
      "p3: the document's images add up to more than 4 MB",
      "p4: the document's images add up to more than 4 MB",
    ]);
    const small = await resolveImages([...values.slice(0, 3), { path: "dot", value: "data:image/png;base64,iVBORw0KGgo=" }], deps({}));
    expect(small.invalid).toEqual(["p2: the document's images add up to more than 4 MB"]); // a small one after it still fits
  });

  it("fetches distinct images in parallel", async () => {
    let inFlight = 0;
    let peak = 0;
    const slow = () => async () => {
      inFlight++; peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 20));
      inFlight--;
      return png()();
    };
    await resolveImages(
      [{ path: "a", value: "https://x.test/1.png" }, { path: "b", value: "https://x.test/2.png" }, { path: "c", value: "https://x.test/3.png" }],
      deps({ "https://x.test/1.png": slow(), "https://x.test/2.png": slow(), "https://x.test/3.png": slow() }),
    );
    expect(peak).toBe(3);
  });
});

describe("sniff", () => {
  it("recognises common image formats", () => {
    expect(sniff(PNG)).toBe("image/png");
    expect(sniff(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(sniff(new TextEncoder().encode("GIF89a"))).toBe("image/gif");
    expect(sniff(new TextEncoder().encode("RIFF\0\0\0\0WEBPVP8 "))).toBe("image/webp");
    expect(sniff(new TextEncoder().encode('  <?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"/>'))).toBe("image/svg+xml");
    expect(sniff(new TextEncoder().encode('<?xml version="1.0"?>\n<!-- Generator: Illustrator -->\n<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "x">\n<svg viewBox="0 0 1 1"/>'))).toBe("image/svg+xml");
    expect(sniff(new TextEncoder().encode("<html><svg></svg></html>"))).toBeNull();
    expect(sniff(new TextEncoder().encode("<html>"))).toBeNull();
  });
});

