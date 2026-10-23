import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const fromRoot = (path: string) => fileURLToPath(new URL(path, import.meta.url));

/** İndirilen eklenti paketinin sürümü; kurulu eklenti daha eskiyse arayüz güncellemeyi önerir. */
function extensionVersion(): string | null {
  try {
    return (JSON.parse(readFileSync(fromRoot('../browser-extension/manifest.json'), 'utf8')) as { version?: string }).version ?? null;
  } catch {
    return null;
  }
}

export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: { __EXTENSION_VERSION__: JSON.stringify(extensionVersion()) },
  resolve: {
    alias: {
      '@': fromRoot('./src'),
      '@contracts': fromRoot('../backend/src/contracts'),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: process.env.VITE_API_PROXY ?? 'http://localhost:8080', changeOrigin: true },
    },
  },
  build: { target: 'es2022', sourcemap: false },
  test: { environment: 'node', include: ['src/**/*.test.ts'] },
});
