import { createReadStream } from 'node:fs'
import { appendFile, readFile, rm, stat, truncate, writeFile } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { pathToFileURL } from 'node:url'

/**
 * Command-line client for server archives. It streams files line by line, so memory stays bounded
 * by one page, and it resumes an interrupted export or restore from where the server says it is.
 *
 *   node dist/archive/cli.js export  <server-api-url> <file>
 *   node dist/archive/cli.js import  <server-api-url> <file>
 *   node dist/archive/cli.js finish-export | discard | status <server-api-url>
 *
 * The URL is the API root, such as https://example.com/backend/v1. ADMIN_TOKEN holds the token.
 */
export interface ArchiveClient {
  /** The API root, without a trailing slash. */
  readonly api: string
  readonly token: string
  readonly fetch?: (input: string, init?: RequestInit) => Promise<Response>
  readonly wait?: (milliseconds: number) => Promise<void>
  readonly log?: (message: string) => void
}

const NEXT_HEADER = 'caelestis-archive-next'
const BATCH_LINES = 500
const BATCH_BYTES = 8 * 1024 * 1024
const ATTEMPTS = 5

const sleep = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds))

const LEASE_BUSY = 'archive request is running'
/** Longest wait for another archive request's lease to end or expire. */
const LEASE_ATTEMPTS = 70

/** One request, retried across dropped connections, gateway errors, and a held archive lease. */
const request = async (client: ArchiveClient, path: string, init: RequestInit = {}) => {
  const send = client.fetch ?? fetch
  const wait = client.wait ?? sleep
  let leaseWait = 0
  for (let attempt = 1; ; attempt += 1) {
    try {
      const response = await send(`${client.api}/admin/archive${path}`, {
        ...init,
        headers: { authorization: `Bearer ${client.token}`, ...init.headers },
      })
      if (response.status === 409 && (await response.clone().text()).includes(LEASE_BUSY)) {
        if (leaseWait < LEASE_ATTEMPTS) {
          leaseWait += 1
          await wait(2_000)
          continue
        }
      }
      if (![502, 503, 504].includes(response.status) || attempt === ATTEMPTS) return response
    } catch (error) {
      if (attempt === ATTEMPTS) throw error
    }
    await wait(attempt * 2_000)
  }
}

const json = async <T>(response: Response, expected: readonly number[]): Promise<T> => {
  const body = await response.text()
  if (!expected.includes(response.status)) {
    const message = (() => {
      try {
        return (JSON.parse(body) as { error?: string }).error ?? body
      } catch {
        return body
      }
    })()
    throw new Error(`Server answered ${response.status}: ${message}`)
  }
  return (body ? JSON.parse(body) : null) as T
}

const waitUntil = async (client: ArchiveClient, readyAt: number) => {
  const remaining = readyAt - Date.now()
  if (remaining <= 0) return
  client.log?.(`Waiting ${Math.ceil(remaining / 1_000)}s for in-flight writes to settle`)
  await (client.wait ?? sleep)(remaining)
}

interface ExportProgress {
  readonly cursor: string
  readonly bytes: number
}

/**
 * Download the server's complete archive into `file`. Writes stay paused on the source afterwards,
 * so nothing accepted later is missing from a migration; `finishExport` resumes them.
 */
export const exportToFile = async (client: ArchiveClient, file: string): Promise<void> => {
  const progressFile = `${file}.cursor`
  const saved = await readFile(progressFile, 'utf8').then(
    (text) => JSON.parse(text) as ExportProgress,
    () => null,
  )
  let cursor: string | null = null
  if (saved === null) {
    const started = await json<{ readyAt: number }>(
      await request(client, '/export', { method: 'POST' }),
      [201],
    )
    await writeFile(file, '')
    await waitUntil(client, started.readyAt)
  } else {
    // The page after the saved cursor may have been half written when the client stopped.
    await truncate(file, saved.bytes)
    cursor = saved.cursor
  }
  for (let pages = 0; ; pages += 1) {
    const response = await request(
      client,
      `/export${cursor === null ? '' : `?cursor=${encodeURIComponent(cursor)}`}`,
    )
    if (response.status === 409 && response.headers.has('retry-after')) {
      await (client.wait ?? sleep)(Number(response.headers.get('retry-after')) * 1_000)
      continue
    }
    if (response.status !== 200) await json(response, [200])
    await appendFile(file, Buffer.from(await response.arrayBuffer()))
    cursor = response.headers.get(NEXT_HEADER)
    if (cursor === null) break
    const { size } = await stat(file)
    await writeFile(progressFile, JSON.stringify({ cursor, bytes: size } satisfies ExportProgress))
    if (pages % 20 === 0) client.log?.(`Exported ${size} bytes`)
  }
  await rm(progressFile, { force: true })
  client.log?.(`Archive written to ${file}. Writes stay paused on this server until finish-export.`)
}

export const finishExport = async (client: ArchiveClient): Promise<void> => {
  await json(await request(client, '/export', { method: 'DELETE' }), [204])
}

/** Restore `file` into a new server, resuming at the record the server expects. */
export const importFromFile = async (client: ArchiveClient, file: string) => {
  const lines = createInterface({ input: createReadStream(file), crlfDelay: Infinity })[
    Symbol.asyncIterator
  ]()
  const header = await lines.next()
  if (header.done) throw new Error(`${file} is empty`)
  const begun = await json<{ position: number; readyAt: number }>(
    await request(client, '/import', { method: 'POST', body: header.value }),
    [200, 201],
  )
  await waitUntil(client, begun.readyAt)
  /** The record the server expects next; the header is record 0. */
  let next = begun.position
  let index = 0
  let batch: string[] = []
  let bytes = 0
  const send = async () => {
    while (batch.length > 0) {
      const response = await request(client, `/import/records?position=${next}`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-ndjson' },
        body: `${batch.join('\n')}\n`,
      })
      if (response.status === 409) {
        // A retried request may have committed before its reply was lost; trust the server.
        const status = await json<{ operation: { position?: number } | null }>(
          await request(client, ''),
          [200],
        )
        const resumed = status.operation?.position ?? next
        if (resumed > next && resumed <= next + batch.length) {
          batch = batch.slice(resumed - next)
          next = resumed
          continue
        }
      }
      next = (await json<{ position: number }>(response, [200])).position
      batch = []
    }
    bytes = 0
  }
  for await (const line of { [Symbol.asyncIterator]: () => lines }) {
    if (line.length === 0) continue
    index += 1
    if (index < next) continue
    batch.push(line)
    bytes += line.length
    if (batch.length < BATCH_LINES && bytes < BATCH_BYTES) continue
    await send()
    if (index % (BATCH_LINES * 20) === 0) client.log?.(`Restored ${index} records`)
  }
  await send()
  const activated = await json<{ sourceServerId: string; counts: Record<string, number> }>(
    await request(client, '/import/activate', { method: 'POST' }),
    [200],
  )
  client.log?.(`Restored ${index} records from server ${activated.sourceServerId}`)
  return activated
}

/** Remove a partial restore so the server is empty and open again. */
export const discardImport = async (client: ArchiveClient): Promise<void> => {
  for (;;) {
    const { done } = await json<{ done: boolean }>(
      await request(client, '/import', { method: 'DELETE' }),
      [200],
    )
    if (done) return
  }
}

const main = async (argv: readonly string[]) => {
  const [command, api, file] = argv
  const token = process.env.ADMIN_TOKEN
  if (!command || !api || !token)
    throw new Error(
      'Usage: ADMIN_TOKEN=... node apps/backend/dist/archive/cli.js <export|import|finish-export|discard|status> <api-url> [file]',
    )
  const client: ArchiveClient = {
    api: api.replace(/\/$/, ''),
    token,
    log: (message) => console.error(message),
  }
  if ((command === 'export' || command === 'import') && !file)
    throw new Error(`${command} needs an archive file path`)
  if (command === 'export') await exportToFile(client, file as string)
  else if (command === 'import') await importFromFile(client, file as string)
  else if (command === 'finish-export') await finishExport(client)
  else if (command === 'discard') await discardImport(client)
  else if (command === 'status')
    console.info(JSON.stringify(await json(await request(client, ''), [200]), null, 2))
  else throw new Error(`Unknown command ${command}`)
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
}
