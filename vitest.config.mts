import { defineConfig } from "vitest/config";

// Backend unit tests live in test/ (kept out of src/ so they never compile into
// dist/ or the Docker image). Node environment — these exercise pure logic and
// mocked flows, not the browser.
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
