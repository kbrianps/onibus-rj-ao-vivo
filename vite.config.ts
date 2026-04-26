import { defineConfig, type Plugin } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

const BASE = process.env.PUBLIC_BASE ?? '/tools/onibus-rj-ao-vivo/';
const API_PREFIX = `${BASE.replace(/\/$/, '')}/api`;

function inlineCssPlugin(): Plugin {
  return {
    name: 'inline-css',
    enforce: 'post',
    apply: 'build',
    generateBundle(_options, bundle) {
      let cssFileName: string | null = null;
      let cssSource = '';
      for (const [name, asset] of Object.entries(bundle)) {
        if (asset.type === 'asset' && name.endsWith('.css')) {
          cssFileName = name;
          cssSource =
            typeof asset.source === 'string'
              ? asset.source
              : Buffer.from(asset.source).toString('utf8');
          delete bundle[name];
          break;
        }
      }
      if (!cssFileName) return;
      const cssBase = cssFileName.split('/').pop()!;
      const linkRe = new RegExp(
        `<link[^>]*rel=["']stylesheet["'][^>]*href=["'][^"']*${cssBase.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}["'][^>]*>`,
        'g',
      );
      const styleTag = `<style>${cssSource}</style>`;
      for (const [name, chunk] of Object.entries(bundle)) {
        if (chunk.type === 'asset' && name.endsWith('.html')) {
          const html =
            typeof chunk.source === 'string'
              ? chunk.source
              : Buffer.from(chunk.source).toString('utf8');
          chunk.source = html.replace(linkRe, styleTag);
        }
      }
    },
  };
}

function priorityHintsPlugin(): Plugin {
  return {
    name: 'priority-hints',
    enforce: 'post',
    apply: 'build',
    transformIndexHtml(html) {
      return html.replace(
        /<script type="module"([^>]*?)src="([^"]+\/index-[^"]+\.js)"([^>]*)>/,
        '<script type="module"$1src="$2" fetchpriority="high"$3>',
      );
    },
  };
}

export default defineConfig({
  base: BASE,
  server: {
    proxy: {
      [API_PREFIX]: {
        target: 'http://localhost:8787',
        changeOrigin: true,
      },
    },
  },
  build: {
    target: 'es2020',
    cssCodeSplit: false,
  },
  plugins: [
    priorityHintsPlugin(),
    inlineCssPlugin(),
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: 'inline',
      includeAssets: ['icons/icon-192.png', 'icons/icon-512.png'],
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
        cleanupOutdatedCaches: true,
        skipWaiting: true,
        clientsClaim: true,
        navigateFallback: null,
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/[abcd]\.basemaps\.cartocdn\.com\/.*/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'carto-tiles-v1',
              expiration: { maxEntries: 150, maxAgeSeconds: 60 * 60 * 24 * 7 },
            },
          },
          {
            urlPattern: /\/api\/lines$/i,
            handler: 'StaleWhileRevalidate',
            options: {
              cacheName: 'sppo-lines-v2',
              expiration: { maxEntries: 1, maxAgeSeconds: 60 * 60 },
            },
          },
          {
            urlPattern: /\/api\/route\?.*/i,
            handler: 'StaleWhileRevalidate',
            options: {
              cacheName: 'sppo-routes-v2',
              expiration: { maxEntries: 50, maxAgeSeconds: 60 * 60 * 24 * 7 },
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
