import react from "@vitejs/plugin-react";
import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./tests/setup.ts"],
    include: ["./tests/unit/**/*.test.{ts,tsx}"],
    // JSDOM + accessibility checks are memory/CPU heavy. File-level concurrency
    // made unrelated, otherwise-fast tests exceed Vitest's per-test timeout
    // only during the full suite. A single worker keeps the checked-in release
    // gate deterministic; browser and server suites remain separately parallel.
    maxWorkers: 1,
    testTimeout: 10_000,
    clearMocks: true,
    restoreMocks: true,
    mockReset: true,
    coverage: {
      provider: "v8",
      reportsDirectory: "../../coverage/german-writing-coach",
      reporter: ["text", "json", "html"],
      exclude: ["tests/**", "**/*.config.ts", "**/*.d.ts"],
    },
  },
});
