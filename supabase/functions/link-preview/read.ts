// The page-reading half of link-preview: name, price and picture from a shop page's HTML.

const decode = (s: string) => s
  .replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))).replace(/&nbsp;/g, " ").trim();

function meta(html: string, ...names: string[]): string {
  for (const name of names) {
    const re = new RegExp(`<meta[^>]+(?:property|name|itemprop)=["']${name}["'][^>]*>`, "i");
    const tag = html.match(re)?.[0];
    const content = tag?.match(/content=["']([^"']*)["']/i)?.[1];
    if (content) return decode(content);
  }
  return "";
}

// schema.org Product in JSON-LD, wherever it sits (@graph, arrays, nested).
function findProduct(node: unknown): Record<string, unknown> | null {
  if (!node || typeof node !== "object") return null;
  if (Array.isArray(node)) { for (const n of node) { const f = findProduct(n); if (f) return f; } return null; }
  const o = node as Record<string, unknown>;
  const t = o["@type"];
  if (t === "Product" || (Array.isArray(t) && t.includes("Product"))) return o;
  for (const k of ["@graph", "mainEntity", "itemListElement"]) { const f = findProduct(o[k]); if (f) return f; }
  return null;
}
function offerPrice(offers: unknown): { price?: number; currency?: string } {
  const list = Array.isArray(offers) ? offers : offers ? [offers] : [];
  for (const raw of list) {
    const o = raw as Record<string, unknown>;
    const p = Number(String(o.price ?? o.lowPrice ?? (o.priceSpecification as Record<string, unknown> | undefined)?.price ?? "").replace(/[^\d.]/g, ""));
    if (p > 0) return { price: p, currency: String(o.priceCurrency ?? "") || undefined };
  }
  return {};
}

// A schema.org image can be a string, an ImageObject, or a list of either.
function imageOf(v: unknown): string {
  if (Array.isArray(v)) return imageOf(v[0]);
  if (v && typeof v === "object") { const o = v as Record<string, unknown>; return String(o.url ?? o.contentUrl ?? ""); }
  return v ? String(v) : "";
}

// Amazon publishes no product tags, so its own page markup is read instead.
// Its price is only taken in pounds: read from abroad, it shows dollars.
function amazon(html: string) {
  const name = decode(html.match(/id=["']productTitle["'][^>]*>([^<]+)</i)?.[1] ?? "");
  const pics = decode(html.match(/id=["']landingImage["'][^>]*data-a-dynamic-image=["']([^"']+)["']/i)?.[1]
    ?? html.match(/data-a-dynamic-image=["']([^"']+)["'][^>]*id=["']landingImage["']/i)?.[1] ?? "");
  const image = pics.match(/https:\/\/[^"]+/)?.[0] ?? html.match(/data-old-hires=["'](https:[^"']+)["']/i)?.[1] ?? "";
  const pounds = html.match(/class=["']a-offscreen["']>\s*£\s*([\d,]+\.?\d*)/i)?.[1];
  return { name, image, price: pounds ? Number(pounds.replace(/,/g, "")) : undefined };
}

export function read(html: string, base: URL) {
  const az = /(^|\.)amazon\./i.test(base.hostname) ? amazon(html) : null;
  let product: Record<string, unknown> | null = null;
  for (const m of html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try { product = findProduct(JSON.parse(m[1])); } catch { /* bad JSON-LD */ }
    if (product) break;
  }
  const fromLd = product ? offerPrice(product.offers) : {};
  const priceText = meta(html, "product:price:amount", "og:price:amount", "price", "twitter:data1");
  const metaPrice = Number(priceText.replace(/[^\d.]/g, "")) || undefined;
  let image = (product ? imageOf(product.image) : "") || az?.image
    || meta(html, "og:image", "og:image:url", "twitter:image", "twitter:image:src");
  if (image) { try { image = new URL(image, base).href; } catch { image = ""; } }
  if (!/^https?:/i.test(image)) image = "";   // placeholders such as a 1px data: GIF
  const title = (product?.name ? decode(String(product.name)) : "") || az?.name
    || meta(html, "og:title", "twitter:title")
    || decode(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "");
  return {
    name: title.replace(/\s+/g, " ").slice(0, 200),
    price: fromLd.price ?? metaPrice ?? az?.price ?? null,
    currency: fromLd.currency || (az?.price ? "GBP" : "") || meta(html, "product:price:currency", "og:price:currency", "priceCurrency") || null,
    image: image || null,
    site: meta(html, "og:site_name") || base.hostname.replace(/^www\./, ""),
  };
}
