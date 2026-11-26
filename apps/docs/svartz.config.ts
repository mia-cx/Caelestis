import { defineConfig } from '@svartz/config'

export default defineConfig({
  version: '1.0.0',
  vaults: [
    {
      id: 'docs',
      path: 'vault',
      target: { type: 'host' },
      theme: { base: '@svartz/theme-wiki' },
      site: {
        title: 'Caelestis',
        description: 'Image templates and painting tools for Wplace.',
        url: 'https://docs.caelest.is',
      },
    },
    {
      id: 'wplace',
      path: 'wplace',
      target: {
        type: 'cloudflare-workers',
        name: 'wplace-docs',
        account_id: '492214885e7a580ccc1d141dfdb4dc5f',
        routes: [{ pattern: 'build.wikiplace.live', custom_domain: true }],
      },
      theme: {
        base: ['@svartz/theme-api-docs', '@svartz/theme-docs'],
        baseUrl: 'https://backend.wplace.live',
      },
      site: {
        title: 'Wplace developer guide',
        description: 'Unofficial docs for building apps, mods and userscripts for Wplace.',
        url: 'https://build.wikiplace.live',
      },
    },
  ],
})
