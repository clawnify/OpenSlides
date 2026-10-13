// Image values for the render API. Every value a template uses as an image is
// resolved here before the PDF is printed: fetched (an https URL), checked (a
// data: URI) or read (an upload), and embedded as a data: URI, so the PDF never
// depends on a host answering at print time, and an image that can't be loaded
// is an error the caller sees, naming the variable, instead of a blank space in
// a sent document.

import type { ImageValue } from "./variables";

// Embedded images travel inside the page HTML to the PDF service, so they are
// bounded: plenty for logos and document photos, not for print-resolution art.
// Render time grows with them (measured 2026-10-12: 8 s for 1.9 MB of images,
// 17 s for 3.7 MB, 45 s for 5.6 MB), so the total stays where a render is quick.
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_BYTES = 4 * 1024 * 1024;
const MAX_IMAGES = 50;
const FETCH_TIMEOUT_MS = 8000;
const MB = (n: number) => `${n / (1024 * 1024)} MB`;

export interface ImageDeps {
  fetch: typeof fetch;
  /** This app's upload under `key`, or null. */
  getAsset(key: string): Promise<{ data: ArrayBuffer; contentType: string } | null>;
}

export interface ResolvedImages {
  /** path → value to fill instead: a data: URI, or the value unchanged. */
  replaced: Map<string, string>;
  /** Readable failures, e.g. `client.logo: image could not be loaded (HTTP 404)`. */
  invalid: string[];
  /** Upload keys the render used, so cleanup keeps them. */
  usedAssets: string[];
}

/** `bytes`: the image's size, counted toward the document's total. */
type Outcome = { ok: true; value: string; asset?: string; bytes: number } | { ok: false; reason: string };

const ASSET_RE = /^assets\/([A-Za-z0-9._-]+)$/;
const DATA_RE = /^data:(image\/[a-z0-9.+-]+)(;[^,]*)?,/i;

export async function resolveImages(images: ImageValue[], deps: ImageDeps): Promise<ResolvedImages> {
  const replaced = new Map<string, string>();
  const invalid: string[] = [];
  const usedAssets = new Set<string>();

  // The same value in several places (a logo on every page) is resolved once,
  // and different values are fetched in parallel.
  const distinct = new Map<string, Promise<Outcome>>();
  const wanted: { path: string; value: string }[] = [];
  for (const img of images) {
    if (typeof img.value !== "string") {
      invalid.push(`${img.path}: expected an image (an https URL, a data:image URI or an upload)`);
      continue;
    }
    const value = img.value.trim();
    if (!distinct.has(value)) {
      if (distinct.size >= MAX_IMAGES) {
        invalid.push(`${img.path}: too many different images in one document (max ${MAX_IMAGES})`);
        continue;
      }
      distinct.set(value, resolveOne(value, deps));
    }
    wanted.push({ path: img.path, value });
  }
  const counted = new Set<string>();
  let total = 0;
  for (const { path, value } of wanted) {
    const outcome = await distinct.get(value)!;
    if (!outcome.ok) {
      invalid.push(`${path}: ${outcome.reason}`);
      continue;
    }
    if (!counted.has(value)) {
      // Name the image that would push the total over, not every one after it.
      if (total + outcome.bytes > MAX_TOTAL_BYTES) {
        invalid.push(`${path}: the document's images add up to more than ${MB(MAX_TOTAL_BYTES)}`);
        continue;
      }
      counted.add(value);
      total += outcome.bytes;
    }
    replaced.set(path, outcome.value);
    if (outcome.asset) usedAssets.add(outcome.asset);
  }
  return { replaced, invalid, usedAssets: [...usedAssets] };
}

async function resolveOne(value: string, deps: ImageDeps): Promise<Outcome> {
  if (value === "") return { ok: true, value, bytes: 0 }; // an intentional blank, like null

  const asset = value.match(ASSET_RE);
  if (asset) {
    const file = await deps.getAsset(asset[1]);
    if (!file) {
      return { ok: false, reason: `no upload named ${asset[1]} in this app (an upload no page uses is removed a few minutes after it is made)` };
    }
    const outcome = embed(new Uint8Array(file.data), file.contentType);
    return outcome.ok ? { ...outcome, asset: asset[1] } : outcome;
  }

  if (/^data:/i.test(value)) {
    if (!DATA_RE.test(value)) return { ok: false, reason: "a data: URI must be an image (data:image/…)" };
    const payload = value.slice(value.indexOf(",") + 1);
    const bytes = /;base64$/i.test(value.slice(0, value.indexOf(","))) ? Math.floor((payload.length * 3) / 4) : payload.length;
    if (bytes > MAX_IMAGE_BYTES) return { ok: false, reason: `image is larger than ${MB(MAX_IMAGE_BYTES)}` };
    return { ok: true, value, bytes };
  }

  if (/^https?:\/\//i.test(value)) return fetchImage(value, deps);

  return { ok: false, reason: "expected an https URL, a data:image URI or an upload (assets/<key>)" };
}

async function fetchImage(url: string, deps: ImageDeps): Promise<Outcome> {
  let res: Response;
  try {
    res = await deps.fetch(url, { redirect: "follow", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), headers: { accept: "image/*" } });
  } catch (e) {
    const timedOut = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
    return { ok: false, reason: `image could not be loaded (${timedOut ? "timed out" : "network error"})` };
  }
  if (!res.ok) return { ok: false, reason: `image could not be loaded (HTTP ${res.status})` };
  if (Number(res.headers.get("content-length") ?? "0") > MAX_IMAGE_BYTES) return { ok: false, reason: `image is larger than ${MB(MAX_IMAGE_BYTES)}` };
  return embed(new Uint8Array(await res.arrayBuffer()), res.headers.get("content-type") ?? "", "the URL did not return an image");
}

/** Bytes as an embedded data: URI, if they are an image of an allowed size. */
function embed(body: Uint8Array, contentType: string, notImage = "the upload is not an image"): Outcome {
  if (body.byteLength > MAX_IMAGE_BYTES) return { ok: false, reason: `image is larger than ${MB(MAX_IMAGE_BYTES)}` };
  if (!body.byteLength) return { ok: false, reason: "image could not be loaded (empty response)" };
  const header = contentType.split(";")[0].trim().toLowerCase();
  const type = header.startsWith("image/") ? header : sniff(body);
  if (!type) return { ok: false, reason: `${notImage} (${header || "no content type"})` };
  return { ok: true, value: `data:${type};base64,${toBase64(body)}`, bytes: body.byteLength };
}

/** Recognise an image whose server didn't say what it is. */
export function sniff(b: Uint8Array): string | null {
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return "image/gif";
  const ascii = (from: number, to: number) => String.fromCharCode(...b.subarray(from, to));
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
  // An SVG may open with an XML declaration, comments or a doctype.
  const head = new TextDecoder().decode(b.subarray(0, 1024)).replace(/^\uFEFF/, "");
  if (/^\s*(?:<\?xml[^>]*>\s*)?(?:(?:<!--[\s\S]*?-->|<!doctype[^>]*>)\s*)*<svg[\s>]/i.test(head)) return "image/svg+xml";
  return null;
}

export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}
