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
  ],
})
