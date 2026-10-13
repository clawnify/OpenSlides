import type { LogoCache } from "./logos";

let _bucket: R2Bucket;

export function initUploads(bucket: R2Bucket) {
  _bucket = bucket;
}

// ── built-in image placeholder ───────────────────────────────────────
// `assets/placeholder.svg` is a VIRTUAL asset: it has no R2 object and no
// assets row, it's served from this constant. Slides/templates reference it
// for image slots the user fills later ("client hero photo") — it renders as
// a neutral photo box, and clicking it in the editor opens the picker and
// swaps in a real upload. Handled here (not in a route) so every consumer —
// the /api/uploads route, PDF inlining, logo resolution — resolves it alike.
export const PLACEHOLDER_KEY = "placeholder.svg";
// preserveAspectRatio="slice" gives the SVG itself object-fit:cover semantics:
// with only "meet" (the default), the artwork letterboxes inside a container of
// a different aspect ratio, leaving unpainted margins that break rounded clips.
// width/height attributes give the file INTRINSIC dimensions — WebKit treats a
// viewBox-only SVG as sizeless, which breaks object-fit:cover on the <img>
// (Safari letterboxes where Chromium covers).
const PLACEHOLDER_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="450" viewBox="0 0 800 450" preserveAspectRatio="xMidYMid slice">
<rect width="800" height="450" fill="#E9E7E2"/>
<g fill="none" stroke="#A9A59D" stroke-width="8" stroke-linecap="round" stroke-linejoin="round">
<rect x="336" y="156" width="128" height="96" rx="10"/>
<path d="M348 232 L382 198 L406 222 L424 204 L452 232"/>
</g>
<circle cx="368" cy="184" r="9" fill="#A9A59D"/>
<text x="400" y="296" text-anchor="middle" font-family="-apple-system,system-ui,sans-serif" font-size="26" fill="#8E8A82">Click to add image</text>
</svg>`;
const placeholderBytes = () => new TextEncoder().encode(PLACEHOLDER_SVG);

export async function putUpload(
  key: string,
  data: ArrayBuffer | Uint8Array | ReadableStream,
  contentType: string,
): Promise<void> {
  await _bucket.put(key, data, { httpMetadata: { contentType } });
}

export async function getUpload(
  key: string,
): Promise<{ data: ReadableStream; contentType: string; size: number } | null> {
  if (key === PLACEHOLDER_KEY) {
    const bytes = placeholderBytes();
    return { data: new Blob([bytes]).stream(), contentType: "image/svg+xml", size: bytes.byteLength };
  }
  const obj = await _bucket.get(key);
  if (!obj) return null;
  return {
    data: obj.body,
    contentType: obj.httpMetadata?.contentType || "application/octet-stream",
    size: obj.size,
  };
}

export async function getUploadBytes(
  key: string,
): Promise<{ data: ArrayBuffer; contentType: string } | null> {
  if (key === PLACEHOLDER_KEY) {
    const bytes = placeholderBytes();
    return { data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, contentType: "image/svg+xml" };
  }
  const obj = await _bucket.get(key);
  if (!obj) return null;
  return {
    data: await obj.arrayBuffer(),
    contentType: obj.httpMetadata?.contentType || "application/octet-stream",
  };
}

export async function deleteUpload(key: string): Promise<void> {
  await _bucket.delete(key);
}

// Looked-up company logos (logos.ts), under logos/…. They are not uploads: the
// orphan sweep walks the assets table, so it never touches them. A remembered
// miss is an empty object marked miss=1.
export const logoCache: LogoCache = {
  async get(key) {
    const obj = await _bucket.get(key);
    if (!obj) return null;
    const type = obj.httpMetadata?.contentType ?? "";
    const found = obj.customMetadata?.miss || !type.startsWith("image/") ? null : { body: new Uint8Array(await obj.arrayBuffer()), type };
    return { found, storedAt: obj.uploaded.getTime() };
  },
  async put(key, found) {
    if (found) await _bucket.put(key, found.body, { httpMetadata: { contentType: found.type } });
    else await _bucket.put(key, new Uint8Array(0), { customMetadata: { miss: "1" } });
  },
};

/** Filesystem-safe, collision-resistant key from an original filename. */
export function makeKey(filename: string): string {
  const clean = filename.toLowerCase().replace(/[^a-z0-9.\-]+/g, "-").replace(/^-+|-+$/g, "");
  return clean || "file";
}
