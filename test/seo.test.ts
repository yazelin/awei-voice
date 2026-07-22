import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(resolve(repositoryRoot, "index.html"), "utf8");
const canonicalUrl = "https://yazelin.github.io/awei-voice/";
const ogImageUrl = `${canonicalUrl}assets/og-image.png`;

describe("SEO and social sharing metadata", () => {
  it("declares canonical URL and Open Graph basics", () => {
    expect(html).toMatch(new RegExp(`<link rel="canonical" href="${canonicalUrl}"`));
    expect(html).toMatch(new RegExp(`<meta property="og:url" content="${canonicalUrl}"`));
    expect(html.includes(`content="${ogImageUrl}"`)).toBe(true);
    expect(html).toMatch(/<meta property="og:image:width" content="1200"/);
    expect(html).toMatch(/<meta property="og:image:height" content="630"/);
    expect(html).toMatch(/<meta name="twitter:card" content="summary_large_image"/);
  });

  it("ships an Open Graph PNG with the declared 1200 by 630 dimensions", () => {
    const png = readFileSync(resolve(repositoryRoot, "public/assets/og-image.png"));
    expect(png.subarray(1, 4).toString()).toBe("PNG");
    expect(png.readUInt32BE(16)).toBe(1200);
    expect(png.readUInt32BE(20)).toBe(630);
  });

  it("exposes WebApplication structured data matching the canonical URL", () => {
    const jsonLdMatch = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
    expect(jsonLdMatch).not.toBeNull();
    const structuredData = JSON.parse(jsonLdMatch![1]!);
    expect(structuredData.url).toBe(canonicalUrl);
    expect(structuredData["@type"]).toBe("WebApplication");
  });

  it("lists the canonical page in sitemap.xml, linked from robots.txt", () => {
    const sitemap = readFileSync(resolve(repositoryRoot, "public/sitemap.xml"), "utf8");
    expect(sitemap.includes(`<loc>${canonicalUrl}</loc>`)).toBe(true);

    const robots = readFileSync(resolve(repositoryRoot, "public/robots.txt"), "utf8");
    expect(robots.includes(`${canonicalUrl}sitemap.xml`)).toBe(true);
  });
});
