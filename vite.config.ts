import tailwindcss from '@tailwindcss/postcss';
import vinext from 'vinext';
import { defineConfig } from 'vite';

// macOS Seatbelt blocks FSEvents, so Codex previews need polling for HMR.
const isCodexSeatbeltSandbox = process.env.CODEX_SANDBOX === 'seatbelt';

export default defineConfig({
  css: { postcss: { plugins: [tailwindcss()] } },
  clearScreen: false,
  server: {
    host: '127.0.0.1',
    port: 1420,
    strictPort: true,
    watch: isCodexSeatbeltSandbox
      ? { useFsEvents: false, usePolling: true }
      : undefined,
  },
  plugins: [vinext()],
});
