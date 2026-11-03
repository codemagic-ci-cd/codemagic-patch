/**
 * Old Local quickstart content lived on the docs homepage (`/`). Released CLI
 * builds still print `/#5-try-it-with-your-own-app` and similar hashes. Send
 * those hashes to `/local-quickstart` so the landing page stays the home URL.
 */
const MOVED_HOME_HASHES = new Set([
  'ngrok',
  '5-try-it-with-your-own-app',
  '3-watch-an-update-apply-on-device-demo',
  '4-confirm-in-the-dashboard-optional',
  'what-you-need',
  '1-start-the-stack',
  'tear-down',
  'where-to-go-next',
]);

function isDocsHome(pathname: string): boolean {
  const trimmed = pathname.replace(/\/+$/, '') || '/';
  return trimmed === '/docs' || trimmed === '/';
}

function localQuickstartPath(pathname: string): string {
  if (pathname === '/' || pathname === '') {
    return '/local-quickstart';
  }
  const base = pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
  return `${base}/local-quickstart`;
}

export function onRouteDidUpdate({
  location,
}: {
  location: {pathname: string; hash: string};
}): void {
  const hash = location.hash.replace(/^#/, '');
  if (!hash || !MOVED_HOME_HASHES.has(hash) || !isDocsHome(location.pathname)) {
    return;
  }
  const next = `${localQuickstartPath(location.pathname)}#${hash}`;
  window.location.replace(next);
}
