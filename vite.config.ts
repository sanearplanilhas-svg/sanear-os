import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return;

          if (id.includes('/react/') || id.includes('/react-dom/')) {
            return 'vendor-react';
          }

          if (id.includes('/firebase/')) {
            return 'vendor-firebase';
          }

          if (id.includes('/@supabase/')) {
            return 'vendor-supabase';
          }

          if (id.includes('/recharts/') || id.includes('/d3-')) {
            return 'vendor-charts';
          }

          if (id.includes('/pdfjs-dist/')) {
            return 'vendor-pdf';
          }

          if (id.includes('/jszip/')) {
            return 'vendor-zip';
          }
        },
      },
    },
  },
  plugins: [
    react({
      babel: {
        plugins: [['babel-plugin-react-compiler']],
      },
    }),
    VitePWA({
      registerType: 'prompt',
      injectRegister: false,
      devOptions: {
        // Em desenvolvimento o Service Worker fica desligado.
        // Isso evita erro procurando dev-dist/sw.js e reduz problema de cache no localhost.
        enabled: false,
      },
      workbox: {
        cleanupOutdatedCaches: true,
      },
      includeAssets: [
        'favicon.svg',
        'watermark.png',
        'robots.txt',
      ],
      manifest: {
        name: 'SANEAR Operacional',
        short_name: 'SANEAR OS',
        description: 'Aplicativo operacional de ordens de serviço da SANEAR',
        theme_color: '#0f172a',
        background_color: '#0f172a',
        display: 'standalone',
        scope: '/',
        start_url: '/',
        icons: [
          {
            src: '/pwa-192x192.png',
            sizes: '192x192',
            type: 'image/png',
          },
          {
            src: '/pwa-512x512.png',
            sizes: '512x512',
            type: 'image/png',
          },
          {
            src: '/pwa-512x512-maskable.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
    }),
  ],
})
