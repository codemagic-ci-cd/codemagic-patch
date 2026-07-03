import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const dashboardRoot = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    // Dev server: resolve from TypeScript source so `vite` works without a prior
    // `yarn workspace @codemagic/patch-shared build` (production build still uses dist).
    alias: {
      "@codemagic/patch-shared": resolve(
        dashboardRoot,
        "../shared/src/index.ts",
      ),
    },
  },
  // @codemagic/patch-shared ships as CommonJS, and Vite does not pre-bundle linked
  // workspace deps by default — so the dev server's esbuild/ESM interop can't see
  // its transitively re-exported names (e.g. artifactToReleaseForm via export *),
  // which blanks the app at boot. Forcing it into dep optimization makes esbuild
  // pre-bundle it and expose the named exports. Production `vite build` (Rollup)
  // already resolves these, so this is a dev-server-only fix.
  optimizeDeps: { include: ["@codemagic/patch-shared"] },
  server: {
    proxy: {
      // 127.0.0.1, not localhost: the dev API binds IPv4 and localhost can
      // resolve to IPv6 ::1, which the proxy then can't reach.
      "/v1": "http://127.0.0.1:3000",
      "/health": "http://127.0.0.1:3000",
    },
  },
});
