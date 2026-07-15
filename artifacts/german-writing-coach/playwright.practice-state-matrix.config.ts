import { defineConfig, devices } from "@playwright/test";
import { resolve } from "node:path";
import { tmpdir } from "node:os";

const port = process.env.E2E_PRACTICE_MATRIX_PORT ?? "4182";
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: ["practice-state-matrix.spec.ts", "responsive-navigation.spec.ts"],
  outputDir: resolve(tmpdir(), "schreiben-practice-state-matrix-playwright"),
  preserveOutput: "never",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL,
    trace: "off",
    screenshot: "off",
    video: "off",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: `PORT=${port} E2E_PRACTICE_MATRIX_PORT=${port} VITE_SUPABASE_URL=http://127.0.0.1:54321 VITE_SUPABASE_ANON_KEY=fixture-public-key pnpm exec vite --config vite.practice-state-matrix.config.ts --host 127.0.0.1`,
    url: `${baseURL}/tests/e2e/fixtures/practice-state-matrix.html`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
