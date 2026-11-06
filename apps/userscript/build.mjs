import { execFileSync } from 'node:child_process'
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs'
import { build, context } from 'esbuild'
import { ditherettePlugin } from './ditherette-plugin.mjs'

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))
const backendPkg = JSON.parse(
  readFileSync(new URL('../backend/package.json', import.meta.url), 'utf8'),
)
const development = process.argv.includes('--watch') || process.argv.includes('--development')
let revision = null
let dirty = null
try {
  revision = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  dirty =
    execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], {
      encoding: 'utf8',
    }).trim() !== ''
} catch {
  // Source archives may have no Git metadata. Reports retain an explicit unknown value.
}

/**
 * The Violentmonkey metadata block. It must be the first thing in the output file, so it rides in
 * as a banner rather than a source comment esbuild would be free to move.
 *
 * `@run-at document-start` matters: the tile-fetch shim has to be installed before wplace's own
 * bundle gets a chance to capture `fetch`.
 *
 * `@namespace` keeps its old repository URL until v1.0.0. Userscript managers identify a script by
 * name and namespace, so changing it installs a separate script with empty GM storage.
 */
const metadata = `// ==UserScript==
// @name         Caelestis
// @namespace    https://github.com/mia-riezebos/wplace-template-server
// @version      ${pkg.version}
// @description  Shared pixel-art templates for wplace.live, overlaid from one or more alliance servers
// @author       mia-riezebos
// @copyright    2026, Mia Riezebos (https://mia.cx)
// @license      https://github.com/mia-cx/Caelestis/blob/main/LICENSE
// @compatible   chrome Tampermonkey, Violentmonkey, or another userscript manager
// @compatible   firefox Tampermonkey, Violentmonkey, or another userscript manager
// @compatible   edge Tampermonkey, Violentmonkey, or another userscript manager
// @homepageURL  https://github.com/mia-cx/Caelestis
// @supportURL   https://github.com/mia-cx/Caelestis/issues
// @downloadURL  https://github.com/mia-cx/Caelestis/releases/latest/download/caelestis.user.js
// @updateURL    https://github.com/mia-cx/Caelestis/releases/latest/download/caelestis.user.js
// @match        https://wplace.live/*
// @run-at       document-start
// @inject-into  page
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @connect      *
// ==/UserScript==
`

// The OFL requires each copy of the font to carry its copyright notice and licence, and the woff2
// binary has no such metadata, so the licence rides along as a legal comment at the end.
const ofl = readFileSync(new URL('./src/fonts/OFL.txt', import.meta.url), 'utf8')

const options = {
  entryPoints: ['src/entry.ts'],
  outfile: 'dist/wplace-template-server.user.js',
  bundle: true,
  format: 'iife',
  target: 'es2022',
  loader: { '.woff2': 'dataurl', '.png': 'dataurl' },
  plugins: [ditherettePlugin({ minify: !development })],
  define: {
    __CAELESTIS_USERSCRIPT_VERSION__: JSON.stringify(pkg.version),
    __CAELESTIS_EXPECTED_BACKEND_VERSION__: JSON.stringify(backendPkg.version),
    __CAELESTIS_BUILD__: JSON.stringify({ revision, dirty, development }),
  },
  banner: { js: metadata },
  footer: { js: `/*! FalseType font, bundled under the SIL Open Font License 1.1:\n\n${ofl}*/` },
  legalComments: 'eof',
  // Keep watch output readable for browser debugging. Release builds should not make every user
  // download and parse the development representation of the same program.
  minify: !development,
  logLevel: 'info',
}

/**
 * The browser extension, unpacked in `dist/extension/`. Its page-world script is the same program
 * without the metadata block; `bridge.js` is the isolated-world script that owns its storage. The
 * bridge is listed first so its handoff listener exists before the page-world script posts.
 * `popup.html` is the toolbar popup with the settings that apply to every Wplace tab.
 */
const extensionDir = 'dist/extension'

const manifest = {
  manifest_version: 3,
  name: 'Caelestis',
  version: pkg.version,
  description:
    'Shared pixel-art templates for wplace.live, overlaid from one or more alliance servers',
  homepage_url: 'https://github.com/mia-cx/Caelestis',
  minimum_chrome_version: '111',
  browser_specific_settings: {
    gecko: {
      id: 'caelestis@mia.cx',
      strict_min_version: '140.0',
      data_collection_permissions: {
        required: [
          'authenticationInfo',
          'personallyIdentifyingInfo',
          'websiteActivity',
          'websiteContent',
        ],
      },
    },
    gecko_android: { strict_min_version: '142.0' },
  },
  permissions: ['storage'],
  action: { default_title: 'Caelestis', default_popup: 'popup.html' },
  content_scripts: [
    {
      matches: ['https://wplace.live/*'],
      js: ['bridge.js'],
      run_at: 'document_start',
    },
    {
      matches: ['https://wplace.live/*'],
      js: ['caelestis.js'],
      run_at: 'document_start',
      world: 'MAIN',
    },
  ],
}

const extensionOptions = [
  {
    ...options,
    entryPoints: ['src/extension/page.ts'],
    outfile: `${extensionDir}/caelestis.js`,
    banner: undefined,
  },
  {
    ...options,
    entryPoints: ['src/extension/popup.ts'],
    outfile: `${extensionDir}/popup.js`,
    banner: undefined,
    footer: undefined,
  },
  {
    entryPoints: ['src/extension/bridge.ts'],
    outfile: `${extensionDir}/bridge.js`,
    bundle: true,
    format: 'iife',
    target: 'es2022',
    minify: !development,
    logLevel: 'info',
  },
]

if (process.argv.includes('--watch')) {
  const ctx = await context(options)
  await ctx.watch()
} else {
  await Promise.all([options, ...extensionOptions].map((each) => build(each)))
  copyFileSync('src/extension/popup.html', `${extensionDir}/popup.html`)
  writeFileSync(`${extensionDir}/manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`)
}
