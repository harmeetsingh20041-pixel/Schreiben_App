import path from "node:path";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

const root = path.resolve(import.meta.dirname);
const port = Number.parseInt(
  process.env.E2E_PRACTICE_MATRIX_PORT ?? "4182",
  10,
);

export default defineConfig({
  root,
  plugins: [react(), tailwindcss()],
  optimizeDeps: {
    entries: [
      "tests/e2e/fixtures/practice-state-matrix.html",
      "tests/e2e/fixtures/objective-worksheet.html",
      "tests/e2e/fixtures/responsive-navigation-harness.tsx",
    ],
  },
  resolve: {
    alias: [
      {
        find: /^@\/lib\/auth$/,
        replacement: path.resolve(
          root,
          "tests/e2e/fixtures/practice-state-matrix-auth.ts",
        ),
      },
      {
        find: /^@\/lib\/studentClassContext$/,
        replacement: path.resolve(
          root,
          "tests/e2e/fixtures/responsive-navigation-class-context.ts",
        ),
      },
      { find: "@", replacement: path.resolve(root, "src") },
    ],
    dedupe: ["react", "react-dom"],
  },
  server: {
    host: "127.0.0.1",
    port,
    strictPort: true,
    fs: { strict: true },
  },
});
