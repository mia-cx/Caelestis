import { execFileSync } from 'node:child_process'
import { copyFileSync, cpSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { build, context } from 'esbuild'
import {
  INSTALLER_URL,
  LATEST_RELEASE_API_URL,
  REPOSITORY_URL,
  USERSCRIPT_BUNDLE,
  WPLACE_MATCH,
} from './build-config.mjs'
import { ditherettePlugin, ditheretteResources } from './ditherette-plugin.mjs'
import { workerPlugin } from './worker-plugin.mjs'

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))
const backendPkg = JSON.parse(
  readFileSync(new URL('../backend/package.json', import.meta.url), 'utf8'),
)
const development = process.argv.includes('--watch') || process.argv.includes('--development')
/**
 * The commit this build comes from, and whether it had uncommitted changes. A source archive has no
 * Git metadata, so the release writes `build-revision.json` into it, and a rebuild from the archive
 * matches the released build byte for byte. Without either, reports keep an explicit unknown.
 */
const gitRevision = () => {
  try {
    return {
      revision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      dirty:
        execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], {
          encoding: 'utf8',
        }).trim() !== '',
    }
  } catch {
    return { revision: null, dirty: null }
  }
}
const revisionFile = new URL('./build-revision.json', import.meta.url)
const { revision, dirty } = existsSync(revisionFile)
  ? JSON.parse(readFileSync(revisionFile, 'utf8'))
  : gitRevision()

/**
 * The Violentmonkey metadata block. It must be the first thing in the output file, so it rides in
 * as a banner rather than a source comment esbuild would be free to move.
 *
 * `@run-at document-start` matters: the tile-fetch shim has to be installed before wplace's own
 * bundle gets a chance to capture `fetch`.
 *
 * `@namespace` keeps its old repository URL until v1.0.0. Userscript managers identify a script by
 * name and namespace, so changing it installs a separate script with empty GM storage.
 *
 * A release carries Ditherette's binaries as `@resource`s and a development build inlines them, so
 * the dev harness runs without a userscript manager.
 */
const resources = development
  ? ''
  : ditheretteResources()
      .map(({ name, url }) => `// @resource     ${name} ${url}\n`)
      .join('')
const metadata = `// ==UserScript==
// @name         Caelestis
// @namespace    https://github.com/mia-riezebos/wplace-template-server
// @version      ${pkg.version}
// @description  Shared pixel-art templates for wplace.live, overlaid from one or more alliance servers
// @author       mia-riezebos
// @copyright    2026, Mia Riezebos (https://mia.cx)
// @license      ${REPOSITORY_URL}/blob/main/LICENSE
// @compatible   chrome Tampermonkey, Violentmonkey, or another userscript manager
// @compatible   firefox Tampermonkey, Violentmonkey, or another userscript manager
// @compatible   edge Tampermonkey, Violentmonkey, or another userscript manager
// @homepageURL  ${REPOSITORY_URL}
// @supportURL   ${REPOSITORY_URL}/issues
// @downloadURL  ${INSTALLER_URL}
// @updateURL    ${INSTALLER_URL}
// @match        ${WPLACE_MATCH}
// @run-at       document-start
// @inject-into  page
${resources}// @grant        GM_getResourceURL
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_listValues
// @grant        GM_addValueChangeListener
// @connect      *
// ==/UserScript==
`

// The OFL requires each copy of the font to carry its copyright notice and licence, and the woff2
// binary has no such metadata, so the licence rides along as a legal comment at the end.
const ofl = readFileSync(new URL('./src/fonts/OFL.txt', import.meta.url), 'utf8')
const oflNotice = `/*! FalseType font, bundled under the SIL Open Font License 1.1:\n\n${ofl}*/`

/**
 * The userscript is one named function, so the manager's copy can put the same source into the
 * page as `(${caelestis})('page')` without carrying it twice. See `src/entry.ts`.
 */
const options = {
  entryPoints: ['src/entry.ts'],
  outfile: USERSCRIPT_BUNDLE,
  bundle: true,
  format: 'iife',
  target: 'es2022',
  loader: { '.woff2': 'dataurl', '.png': 'dataurl' },
  plugins: [
    ditherettePlugin({ minify: !development, wasm: development ? 'inline' : 'resource' }),
    workerPlugin({ minify: !development }),
  ],
  define: {
    __CAELESTIS_USERSCRIPT_VERSION__: JSON.stringify(pkg.version),
    __CAELESTIS_EXPECTED_BACKEND_VERSION__: JSON.stringify(backendPkg.version),
    __CAELESTIS_BUILD__: JSON.stringify({ revision, dirty, development }),
    __CAELESTIS_RELEASE__: JSON.stringify({
      installerUrl: INSTALLER_URL,
      latestReleaseApiUrl: LATEST_RELEASE_API_URL,
    }),
  },
  banner: { js: `${metadata};(function caelestis(world) {` },
  footer: { js: `${oflNotice}\n})('manager')` },
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

/** The community's 16px moon, scaled by whole pixels to each size the stores and browsers ask for. */
const icons = Object.fromEntries(
  [16, 32, 48, 128].map((size) => [String(size), `icons/icon-${size}.png`]),
)

const manifest = {
  manifest_version: 3,
  name: 'Caelestis',
  version: pkg.version,
  /** The store summary on Chrome, Edge, and AMO; keep it in step with store/listing.md. */
  description:
    'Template overlay for Wplace. Place your pixel art on the map, find the pixels left to paint, and paint with your alliance.',
  homepage_url: REPOSITORY_URL,
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
  icons,
  permissions: ['storage'],
  action: { default_title: 'Caelestis', default_popup: 'popup.html', default_icon: icons },
  content_scripts: [
    {
      matches: [WPLACE_MATCH],
      js: ['bridge.js'],
      run_at: 'document_start',
    },
    {
      matches: [WPLACE_MATCH],
      js: ['caelestis.js'],
      run_at: 'document_start',
      world: 'MAIN',
    },
  ],
}

const extensionPlugins = [
  ditherettePlugin({ minify: !development, wasm: 'inline' }),
  workerPlugin({ minify: !development }),
]

const extensionOptions = [
  {
    ...options,
    entryPoints: ['src/extension/page.ts'],
    outfile: `${extensionDir}/caelestis.js`,
    plugins: extensionPlugins,
    banner: undefined,
    footer: { js: oflNotice },
  },
  {
    ...options,
    entryPoints: ['src/extension/popup.ts'],
    outfile: `${extensionDir}/popup.js`,
    plugins: extensionPlugins,
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
  cpSync('src/extension/icons', `${extensionDir}/icons`, { recursive: true })
  writeFileSync(`${extensionDir}/manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`)
}
