import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: { alias: { "@": path.resolve(process.cwd(), "src") } },
  test: {
    include: ["tests/**/*.test.ts"],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
    setupFiles: ["tests/setup.ts"],
  },
});
