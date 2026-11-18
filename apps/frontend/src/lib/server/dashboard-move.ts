/**
 * The official dashboard moved from caelestis.mia.cx to caelest.is. Browsers keep the saved server,
 * access token, and view preferences per origin, so a page visit to the old host hands them over:
 * the old host serves a page that posts its `caelestis:` localStorage entries to {@link MOVE_PATH}
 * on the new host, which stores them and continues to the same path. The credential travels in a
 * POST body to our own origin, never in a URL. Every other old-host request gets a plain 308.
 */
export const DASHBOARD_ORIGIN = 'https://caelest.is'
export const FORMER_DASHBOARD_ORIGIN = 'https://caelestis.mia.cx'
export const MOVE_PATH = '/moved'

const STORAGE_PREFIX = 'caelestis:'
/** The server and its token belong together: a token must never reach a server it wasn't made for. */
const CONNECTION_KEYS = ['caelestis:server', 'caelestis:token']

/** JSON that cannot close the inline `<script>` it is placed in. */
const scriptJson = (value: unknown): string => JSON.stringify(value).replace(/</g, '\\u003c')

const page = (head: string, script: string): Response =>
  new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8">${head}<title>Caelestis</title></head><body><script>${script}</script></body></html>`,
    // No `no-referrer` policy: it would send the handoff POST with `Origin: null`.
    { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } },
  )

/** Answer a request to the former host: page visits carry browser state over, the rest redirect. */
export const leaveFormerHost = (request: Request, url: URL): Response => {
  const target = `${DASHBOARD_ORIGIN}${url.pathname}${url.search}`
  const pageVisit = request.method === 'GET' && request.headers.get('sec-fetch-dest') === 'document'
  if (!pageVisit) return Response.redirect(target, 308)

  const href = target.replaceAll('&', '&amp;').replaceAll('"', '&quot;')
  return page(
    `<link rel="canonical" href="${href}"><noscript><meta http-equiv="refresh" content="0;url=${href}"></noscript>`,
    `let stored = {}
try {
  for (const key of Object.keys(localStorage)) {
    if (key.startsWith(${scriptJson(STORAGE_PREFIX)})) stored[key] = localStorage.getItem(key)
  }
} catch {}
if (Object.keys(stored).length === 0) location.replace(${scriptJson(target)})
else {
  const form = document.createElement('form')
  form.method = 'post'
  form.action = ${scriptJson(`${DASHBOARD_ORIGIN}${MOVE_PATH}`)}
  for (const [name, value] of [['storage', JSON.stringify(stored)], ['to', ${scriptJson(`${url.pathname}${url.search}`)}]]) {
    const input = document.createElement('input')
    input.type = 'hidden'
    input.name = name
    input.value = value
    form.append(input)
  }
  document.body.append(form)
  form.submit()
}`,
  )
}

const storedEntries = (raw: FormDataEntryValue | null): [string, string][] => {
  if (typeof raw !== 'string') return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return []
    return Object.entries(parsed).filter(
      (entry): entry is [string, string] =>
        entry[0].startsWith(STORAGE_PREFIX) && typeof entry[1] === 'string',
    )
  } catch {
    return []
  }
}

/**
 * Store what the former host posted, then continue to the page the visitor asked for. Entries
 * this origin already holds win; the server and token move only together.
 */
export const receiveMove = async (request: Request): Promise<Response> => {
  if (request.headers.get('origin') !== FORMER_DASHBOARD_ORIGIN) {
    return new Response('Forbidden', { status: 403 })
  }
  const form = await request.formData()
  const to = new URL(String(form.get('to') ?? '/'), DASHBOARD_ORIGIN)
  const path = to.origin === DASHBOARD_ORIGIN ? `${to.pathname}${to.search}` : '/'
  return page(
    '',
    `const connection = ${scriptJson(CONNECTION_KEYS)}
try {
  const hasConnection = connection.some((key) => localStorage.getItem(key) !== null)
  for (const [key, value] of ${scriptJson(storedEntries(form.get('storage')))}) {
    const held = connection.includes(key) ? hasConnection : localStorage.getItem(key) !== null
    if (!held) localStorage.setItem(key, value)
  }
} catch {}
location.replace(${scriptJson(path)})`,
  )
}
