import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
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
      // resolve to IPv6 ::1, which the proxy then can't reach. Overridable
      // for a dev API on a non-default port (e.g. a port-shifted eval stack).
      "/v1": process.env.VITE_API_PROXY_TARGET ?? "http://127.0.0.1:3000",
    },
  },
});
