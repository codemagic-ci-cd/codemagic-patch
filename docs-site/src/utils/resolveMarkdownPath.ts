/**
 * Resolve the public URL path for a page's generated `.md` file.
 *
 * Must stay aligned with `docusaurus-plugin-llms` slug handling in
 * `generateIndividualMarkdownFiles` (nested slugs become `/<slug>.md`,
 * otherwise `docs/<id>.md`).
 */
export function resolveMarkdownPath(
  docId: string,
  slug: string | undefined,
): string {
  const normalizedSlug =
    typeof slug === 'string' ? slug.trim().replace(/^\/+|\/+$/g, '') : '';

  if (normalizedSlug) {
    if (normalizedSlug.includes('/')) {
      return `/${normalizedSlug}.md`;
    }

    return `/docs/${normalizedSlug}.md`;
  }

  return `/docs/${docId}.md`;
}
