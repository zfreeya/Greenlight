import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:1420",
    actionTimeout: 20_000,
    viewport: { width: 1280, height: 800 },
  },
  webServer: [
    {
      command: "npm run dev",
      url: "http://localhost:1420",
      reuseExistingServer: true,
      timeout: 60_000,
    },
    {
      command: "node tools-server/index.mjs --workspace ./workspace --port 8451",
      url: "http://127.0.0.1:8451/health",
      reuseExistingServer: true,
      timeout: 30_000,
    },
    {
      command: "node tools-server/godot-server.mjs --workspace ./workspace --port 8456",
      url: "http://127.0.0.1:8456/health",
      reuseExistingServer: true,
      timeout: 30_000,
    },
  ],
});