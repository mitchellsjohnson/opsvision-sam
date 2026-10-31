import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

// The API allows the origin http://localhost:5173 by default, so the dev
// server binds to that exact host and port.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { host: 'localhost', port: 5173, strictPort: true },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    // CSS is not processed in tests, except that tokens.css can be read as
    // raw text (`?raw`) to check the design tokens' contrast.
    css: { include: /tokens\.css/ },
  },
})
