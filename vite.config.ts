import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

const BASE = process.env.PUBLIC_BASE ?? '/tools/onibus-rj-ao-vivo/';

export default defineConfig({
  base: BASE,
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:8787',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
  build: {
    target: 'es2020',
    cssCodeSplit: false,
  },
  plugins: [
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg', 'icons/icon-192.png', 'icons/icon-512.png'],
      manifest: {
        name: 'Ônibus RJ - Ao Vivo',
        short_name: 'Ônibus RJ',
        description: 'Ônibus do Rio de Janeiro em tempo real',
        theme_color: '#0f172a',
        background_color: '#0f172a',
        display: 'standalone',
        orientation: 'portrait',
        id: BASE,
        start_url: BASE,
        scope: BASE,
        lang: 'pt-BR',
        icons: [
          {
            src: 'icons/icon-192.png',
            sizes: '192x192',
            type: 'image/png',
            purpose: 'any maskable',
          },
          {
            src: 'icons/icon-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any maskable',
          },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,webmanifest}'],
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/[abcd]\.basemaps\.cartocdn\.com\/.*/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'carto-tiles',
              expiration: { maxEntries: 300, maxAgeSeconds: 60 * 60 * 24 * 30 },
            },
          },
          {
            urlPattern: /\/api\/sppo.*/i,
            handler: 'NetworkOnly',
          },
        ],
      },
    }),
  ],
});
