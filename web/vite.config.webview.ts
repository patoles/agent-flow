import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'path'

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
  ],
  resolve: {
    alias: {
      '@': resolve(__dirname),
    },
  },
  publicDir: false,
  build: {
    outDir: resolve(__dirname, '../extension/dist/webview'),
    emptyOutDir: true,
    lib: {
      entry: resolve(__dirname, 'webview-entry.tsx'),
      formats: ['iife'],
      name: 'AgentFlowWebview',
      fileName: () => 'index',
    },
    // @ts-expect-error — cssFileName is valid in Vite 8 but not yet in @types
    cssFileName: 'index',
    sourcemap: false,
    minify: true,
    rollupOptions: {
      output: {
        entryFileNames: 'index.js',
        assetFileNames: (info) => {
          if (info.names?.[0]?.endsWith('.css')) return 'index.css'
          return '[name].[ext]'
        },
      },
    },
  },
  define: {
    'process.env.NODE_ENV': '"production"',
    'process.env.NEXT_PUBLIC_DEMO': '"1"',
    'process.env.NEXT_PUBLIC_RELAY_PORT': '"3001"',
  },
})
