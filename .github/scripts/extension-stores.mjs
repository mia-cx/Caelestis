/**
 * Submits a released extension to one store. A store without its credentials is skipped with a
 * notice, so a release goes to whichever stores are set up.
 *
 *   node .github/scripts/extension-stores.mjs chrome <extension.zip>
 *   node .github/scripts/extension-stores.mjs edge <extension.zip>
 *   node .github/scripts/extension-stores.mjs firefox <extension.zip> <source.zip>
 *
 * Chrome: CHROME_SERVICE_ACCOUNT_KEY, CHROME_PUBLISHER_ID, CHROME_ITEM_ID. A submission still in
 * review is cancelled in favour of this one.
 * Edge: EDGE_PRODUCT_ID, EDGE_CLIENT_ID, EDGE_API_KEY. A store still reviewing the previous version
 * is skipped.
 * Firefox: AMO_JWT_ISSUER, AMO_JWT_SECRET. Skipped until the add-on exists on addons.mozilla.org.
 *
 * Each store publishes the version once its review approves it.
 */
import { execFileSync } from 'node:child_process'
import { createHmac, createSign, randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { releaseNotesFor } from './release-notes.mjs'

const POLL_MS = 5_000
const POLL_LIMIT = 60
const WEB_EXT = 'web-ext@10.8.0'
const ADDON_ID = 'caelestis@mia.cx'

const notice = (message) => console.log(`::notice::${message}`)
const wait = () => new Promise((resolve) => setTimeout(resolve, POLL_MS))
const seconds = () => Math.floor(Date.now() / 1000)
const jwtPart = (value) => Buffer.from(JSON.stringify(value)).toString('base64url')

/** The named variables, or null with a notice when any is missing. */
const credentials = (store, names) => {
  const values = names.map((name) => process.env[name])
  if (values.every(Boolean)) return values
  notice(`${store} credentials are not set up; skipping ${store}.`)
  return null
}

const request = async (url, init) => {
  const response = await fetch(url, init)
  const text = await response.text()
  if (!response.ok) throw new Error(`${init.method} ${url} failed with ${response.status}: ${text}`)
  return { response, body: text === '' ? {} : JSON.parse(text) }
}

const chrome = async (zip) => {
  const found = credentials('Chrome Web Store', [
    'CHROME_SERVICE_ACCOUNT_KEY',
    'CHROME_PUBLISHER_ID',
    'CHROME_ITEM_ID',
  ])
  if (found === null) return
  const [serviceAccount, publisher, itemId] = found
  const key = JSON.parse(serviceAccount)
  const api = 'https://chromewebstore.googleapis.com'
  const item = `publishers/${publisher}/items/${itemId}`

  // Google's service-account flow: trade a self-signed JWT for an access token.
  const now = seconds()
  const unsigned = `${jwtPart({ alg: 'RS256', typ: 'JWT' })}.${jwtPart({
    iss: key.client_email,
    scope: 'https://www.googleapis.com/auth/chromewebstore',
    aud: key.token_uri,
    iat: now,
    exp: now + 3600,
  })}`
  const signature = createSign('RSA-SHA256').update(unsigned).sign(key.private_key, 'base64url')
  const { body: token } = await request(key.token_uri, {
    method: 'POST',
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${unsigned}.${signature}`,
    }),
  })
  const call = (method, path, init = {}) =>
    request(`${api}${path}`, {
      ...init,
      method,
      headers: { authorization: `Bearer ${token.access_token}`, ...init.headers },
    }).then(({ body }) => body)
  const status = () => call('GET', `/v2/${item}:fetchStatus`)

  if ((await status()).submittedItemRevisionStatus?.state === 'PENDING_REVIEW') {
    await call('POST', `/v2/${item}:cancelSubmission`)
    notice('Cancelled the Chrome Web Store submission still in review.')
  }

  const upload = await call('POST', `/upload/v2/${item}:upload`, {
    headers: { 'content-type': 'application/zip' },
    body: readFileSync(zip),
  })
  let state = upload.uploadState
  // The API reference names the in-progress state both ways.
  const uploading = () => state === 'IN_PROGRESS' || state === 'UPLOAD_IN_PROGRESS'
  for (let poll = 0; uploading() && poll < POLL_LIMIT; poll++) {
    await wait()
    state = (await status()).lastAsyncUploadState ?? state
  }
  if (state !== 'SUCCEEDED') throw new Error(`Chrome Web Store upload ended in state ${state}`)

  const published = await call('POST', `/v2/${item}:publish`, {
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ publishType: 'DEFAULT_PUBLISH' }),
  })
  console.log(`Submitted ${upload.crxVersion ?? zip} to the Chrome Web Store: ${published.state}`)
  for (const warning of published.warningInfo?.warnings ?? []) {
    console.log(`::warning::${warning.description}`)
  }
}

const edge = async (zip) => {
  const found = credentials('Microsoft Edge Add-ons', [
    'EDGE_PRODUCT_ID',
    'EDGE_CLIENT_ID',
    'EDGE_API_KEY',
  ])
  if (found === null) return
  const [product, clientId, apiKey] = found
  const base = `https://api.addons.microsoftedge.microsoft.com/v1/products/${product}/submissions`
  const headers = { authorization: `ApiKey ${apiKey}`, 'x-clientid': clientId }
  const call = async (method, path, init = {}) => {
    const response = await fetch(`${base}${path}`, {
      ...init,
      method,
      headers: { ...headers, ...init.headers },
    })
    if (response.status === 401) {
      console.log(
        '::warning::Edge rejected EDGE_API_KEY. Keys expire: create a new one under Publish API in Partner Center and update the extension-stores secret.',
      )
    }
    if (!response.ok) {
      throw new Error(`${method} ${path} failed with ${response.status}: ${await response.text()}`)
    }
    return response
  }
  /** Follows an accepted operation until it settles, and returns its final status. */
  const settle = async (path, accepted) => {
    const operation = accepted.headers.get('location')?.split('/').pop()
    for (let poll = 0; poll < POLL_LIMIT; poll++) {
      const result = await (await call('GET', `${path}/operations/${operation}`)).json()
      if (result.status !== 'InProgress') return result
      await wait()
    }
    throw new Error(`Edge operation ${operation} is still in progress`)
  }

  /** Whether the operation went through; false when Edge is still reviewing the previous version. */
  const succeeded = (step, result) => {
    if (result.errorCode === 'InProgressSubmission') {
      notice('Edge is still reviewing the previous version; skipping Edge.')
      return false
    }
    if (result.status === 'Succeeded') return true
    throw new Error(`Edge ${step} failed: ${result.message} ${JSON.stringify(result.errors)}`)
  }

  const upload = await settle(
    '/draft/package',
    await call('POST', '/draft/package', {
      headers: { 'content-type': 'application/zip' },
      body: readFileSync(zip),
    }),
  )
  if (!succeeded('upload', upload)) return
  const published = await settle(
    '',
    await call('POST', '', {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ notes: 'Built from the GitHub release of Caelestis.' }),
    }),
  )
  if (succeeded('submission', published)) {
    console.log(`Submitted to Microsoft Edge Add-ons: ${published.message}`)
  }
}

const firefox = async (zip, source) => {
  const found = credentials('addons.mozilla.org', ['AMO_JWT_ISSUER', 'AMO_JWT_SECRET'])
  if (found === null) return
  const [issuer, secret] = found

  // addons.mozilla.org's API takes a JWT signed with the API secret on every request.
  const now = seconds()
  const unsigned = `${jwtPart({ alg: 'HS256', typ: 'JWT' })}.${jwtPart({ iss: issuer, jti: randomUUID(), iat: now, exp: now + 60 })}`
  const jwt = `${unsigned}.${createHmac('sha256', secret).update(unsigned).digest('base64url')}`
  const addon = await fetch(`https://addons.mozilla.org/api/v5/addons/addon/${ADDON_ID}/`, {
    headers: { authorization: `JWT ${jwt}` },
  })
  if (addon.status === 404) {
    notice(`${ADDON_ID} has no addons.mozilla.org listing yet; skipping Firefox.`)
    return
  }
  if (!addon.ok)
    throw new Error(`addons.mozilla.org answered ${addon.status}: ${await addon.text()}`)

  const work = mkdtempSync(join(tmpdir(), 'caelestis-amo-'))
  const extension = join(work, 'extension')
  execFileSync('unzip', ['-q', zip, '-d', extension])
  const { version } = JSON.parse(readFileSync(join(extension, 'manifest.json'), 'utf8'))
  const changelog = readFileSync(
    new URL('../../apps/userscript/CHANGELOG.md', import.meta.url),
    'utf8',
  )
  const notes = releaseNotesFor(changelog, version)
    .split('\n')
    .filter((line) => !line.startsWith('#'))
    .map((line) => line.replace(/^- [0-9a-f]{7,}: /, '- '))
    .join('\n')
    .trim()
  const metadata = join(work, 'amo.json')
  writeFileSync(
    metadata,
    JSON.stringify({
      version: {
        approval_notes:
          'Built with esbuild and minified. BUILD-EXTENSION.md at the root of the attached source archive gives the Node.js and pnpm versions and the one build command.',
        release_notes: { 'en-US': notes },
      },
    }),
  )
  execFileSync(
    'npx',
    [
      '--yes',
      WEB_EXT,
      'sign',
      '--channel=listed',
      `--source-dir=${extension}`,
      `--artifacts-dir=${join(work, 'signed')}`,
      `--upload-source-code=${source}`,
      `--amo-metadata=${metadata}`,
      '--approval-timeout=0',
    ],
    {
      stdio: 'inherit',
      env: { ...process.env, WEB_EXT_API_KEY: issuer, WEB_EXT_API_SECRET: secret },
    },
  )
}

const stores = { chrome, edge, firefox }
const [store, ...files] = process.argv.slice(2)
const submit = stores[store]
if (submit === undefined || files.length === 0) {
  throw new Error('Usage: extension-stores.mjs chrome|edge <zip> | firefox <zip> <source.zip>')
}
await submit(...files)
