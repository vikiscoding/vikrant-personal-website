// Pure static build. The Worker in worker/ serves dist/ and adds the only dynamic parts.
import { defineConfig } from "astro/config";

export default defineConfig({
  site: "https://vikrantsingh.fyi",
  output: "static",
  build: { format: "directory" },
});
