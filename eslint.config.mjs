import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

/**
 * The simulation boundary.
 *
 * src/sim/ runs in two places: the browser (optimistic prediction) and Node
 * route handlers (authoritative). Anything platform-specific in there breaks
 * the server half, and it breaks it at runtime in production rather than here.
 *
 * This rule is the whole reason a monorepo is not needed yet. If it ever stops
 * being sufficient, splitting src/sim into its own package - where Pixi simply
 * is not a dependency - is the structural version of the same guarantee.
 */
const simBoundary = {
  files: ["src/sim/**/*.ts"],
  rules: {
    "no-restricted-imports": [
      "error",
      {
        patterns: [
          { group: ["pixi.js", "pixi.js/*"], message: "src/sim must not depend on the renderer." },
          { group: ["react", "react-dom", "react/*"], message: "src/sim must not depend on React." },
          { group: ["next", "next/*"], message: "src/sim must not depend on Next." },
          { group: ["zustand", "zustand/*"], message: "src/sim owns no UI state." },
          { group: ["@supabase/*"], message: "src/sim must not perform I/O." },
        ],
      },
    ],
    "no-restricted-globals": [
      "error",
      { name: "window", message: "src/sim also runs on the server." },
      { name: "document", message: "src/sim also runs on the server." },
      { name: "localStorage", message: "src/sim also runs on the server." },
      { name: "fetch", message: "src/sim must be pure - no I/O." },
    ],
    "no-restricted-properties": [
      "error",
      {
        object: "Math",
        property: "random",
        message:
          "Use createRng(seed). Offline progress is recomputed server-side and must reproduce exactly.",
      },
    ],
  },
};

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  simBoundary,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Raw art. Kenney's Tiled export includes sampleSheet.tsx, which is XML
    // rather than JSX and fails every TypeScript parser that meets it.
    "assets/**",
    "public/atlas/**",
  ]),
]);

export default eslintConfig;
