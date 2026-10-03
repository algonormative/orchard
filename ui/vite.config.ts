import { defineConfig } from "vite";

export default defineConfig({
  clearScreen: false,
  server: { strictPort: true },
  // The About window is a second page; the desktop shell opens it at /about.html.
  build: { rollupOptions: { input: { main: "index.html", about: "about.html" } } },
});
