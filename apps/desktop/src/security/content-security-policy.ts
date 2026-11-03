// One definition of the renderer's Content Security Policy, used by the main
// process (as a response header) and by the renderer build (as a <meta> tag).
//
// The packaged app loads its renderer from file://, where response headers do
// not apply, so production relies on the <meta> tag that the build injects.
// `npm run dev` loads the renderer from the Vite dev server, which injects an
// inline React Fast Refresh script and inline <style> tags, so the development
// policy allows inline scripts and styles. It is never used in a packaged app.

export const developmentRendererOrigin = "http://localhost:5173";

export type ContentSecurityPolicyMode = "production" | "development";

export function buildContentSecurityPolicy(
  mode: ContentSecurityPolicyMode,
  options: { readonly forMetaTag?: boolean } = {}
): string {
  const development = mode === "development";
  const directives = [
    "default-src 'self'",
    development
      ? `script-src 'self' 'unsafe-inline' ${developmentRendererOrigin}`
      : "script-src 'self'",
    development ? "style-src 'self' 'unsafe-inline'" : "style-src 'self'",
    "img-src 'self' data:",
    development
      ? `connect-src 'self' ${developmentRendererOrigin} ws://localhost:5173`
      : "connect-src 'self'",
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'none'"
  ];
  // Browsers ignore frame-ancestors in a <meta> tag and log an error for it.
  if (options.forMetaTag !== true) {
    directives.push("frame-ancestors 'none'");
  }
  return directives.join("; ");
}
