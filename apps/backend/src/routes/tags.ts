import { isUuidV7, tagName, uuidV7 } from '@caelestis/shared'
import { Hono } from 'hono'
import type { BackendRuntime } from '../runtime/backend-runtime.js'
import { runBackendHttp } from '../runtime/hono.js'
import type { TagMutation } from '../tags/store.js'
import { mutateTag, readTags } from '../tags/use-cases.js'

const INVALID_NAME = 'Use 1–64 characters without control characters.'

const bodyName = async (request: { json(): Promise<unknown> }) => {
  const body: unknown = await request.json().catch(() => null)
  return tagName(typeof body === 'object' && body !== null && 'name' in body ? body.name : null)
}

/** Tags share the admin boundary of server template metadata. */
export const createTagRoutes = (runtime: BackendRuntime, currentSeason: number) => {
  const routes = new Hono()
  const mutate = (mutation: TagMutation) => mutateTag(mutation, currentSeason)

  routes.get('/', async (c) => {
    const templateId = c.req.query('templateId')
    const folderId = c.req.query('folderId')
    if (folderId !== undefined && (!isUuidV7(folderId) || templateId !== undefined))
      return c.json({ error: 'Choose one valid template or folder ID.' }, 400)
    if (templateId !== undefined && !isUuidV7(templateId))
      return c.json({ error: 'Invalid template ID.' }, 400)
    return runBackendHttp(c, runtime, readTags(templateId, folderId), (result) => c.json(result))
  })
  routes.post('/', async (c) => {
    const name = await bodyName(c.req)
    if (name === null) return c.json({ error: INVALID_NAME }, 400)
    return runBackendHttp(c, runtime, mutate({ type: 'create', id: uuidV7(), name }), (result) =>
      c.json(result, 201),
    )
  })
  // Matches `/:id` itself as well as everything below it.
  routes.use('/:id/*', async (c, next) => {
    if (!isUuidV7(c.req.param('id'))) return c.json({ error: 'Invalid tag ID.' }, 400)
    await next()
  })
  routes.patch('/:id', async (c) => {
    const name = await bodyName(c.req)
    if (name === null) return c.json({ error: INVALID_NAME }, 400)
    return runBackendHttp(
      c,
      runtime,
      mutate({ type: 'rename', id: c.req.param('id'), name }),
      (result) => c.json(result),
    )
  })
  routes.delete('/:id', async (c) =>
    runBackendHttp(c, runtime, mutate({ type: 'delete', id: c.req.param('id') }), () =>
      c.body(null, 204),
    ),
  )

  const assignments = { PUT: true, DELETE: false } as const
  for (const [method, attached] of Object.entries(assignments)) {
    routes.on(method, '/:id/folders/:folderId', async (c) => {
      const folderId = c.req.param('folderId')
      if (!isUuidV7(folderId)) return c.json({ error: 'Invalid tag or folder ID.' }, 400)
      return runBackendHttp(
        c,
        runtime,
        mutate({ type: 'assign-folder', id: c.req.param('id'), folderId, attached }),
        () => c.body(null, 204),
      )
    })
    routes.on(method, '/:id/templates/:templateId', async (c) => {
      const templateId = c.req.param('templateId')
      if (!isUuidV7(templateId)) return c.json({ error: 'Invalid tag or template ID.' }, 400)
      return runBackendHttp(
        c,
        runtime,
        mutate({ type: 'assign', id: c.req.param('id'), templateId, attached }),
        () => c.body(null, 204),
      )
    })
  }
  return routes
}
