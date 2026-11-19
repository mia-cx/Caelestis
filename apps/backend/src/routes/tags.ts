import { isUuidV7, tagName, uuidV7 } from '@caelestis/shared'
import { Hono } from 'hono'
import { type AuthOptions, requireScopeEffect } from '../auth/middleware.js'
import type { BackendRuntime } from '../runtime/backend-runtime.js'
import { runBackendHttp } from '../runtime/hono.js'
import { mutateTag, readTags } from '../tags/use-cases.js'

/** Tags share the admin boundary of server template metadata. */
export const createTagRoutes = (
  runtime: BackendRuntime,
  auth: AuthOptions,
  currentSeason: number,
) => {
  const routes = new Hono()
  routes.use('/*', requireScopeEffect(runtime, auth, 'admin'))
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
    const body: unknown = await c.req.json().catch(() => null)
    const name = tagName(
      typeof body === 'object' && body !== null && 'name' in body ? body.name : null,
    )
    if (name === null)
      return c.json({ error: 'Use 1–64 characters without control characters.' }, 400)
    return runBackendHttp(
      c,
      runtime,
      mutateTag({ type: 'create', id: uuidV7(), name }, currentSeason),
      (result) => c.json(result, 201),
    )
  })
  routes.use('/:id/*', async (c, next) => {
    if (!isUuidV7(c.req.param('id'))) return c.json({ error: 'Invalid tag ID.' }, 400)
    await next()
  })
  routes.patch('/:id', async (c) => {
    const id = c.req.param('id')
    if (!isUuidV7(id)) return c.json({ error: 'Invalid tag ID.' }, 400)
    const body: unknown = await c.req.json().catch(() => null)
    const name = tagName(
      typeof body === 'object' && body !== null && 'name' in body ? body.name : null,
    )
    if (name === null)
      return c.json({ error: 'Use 1–64 characters without control characters.' }, 400)
    return runBackendHttp(
      c,
      runtime,
      mutateTag({ type: 'rename', id, name }, currentSeason),
      (result) => c.json(result),
    )
  })
  routes.delete('/:id', async (c) => {
    const id = c.req.param('id')
    if (!isUuidV7(id)) return c.json({ error: 'Invalid tag ID.' }, 400)
    return runBackendHttp(c, runtime, mutateTag({ type: 'delete', id }, currentSeason), () =>
      c.body(null, 204),
    )
  })
  for (const attached of [true, false]) {
    routes.on(attached ? 'PUT' : 'DELETE', '/:id/folders/:folderId', async (c) => {
      const id = c.req.param('id')
      const folderId = c.req.param('folderId')
      if (!isUuidV7(id) || !isUuidV7(folderId))
        return c.json({ error: 'Invalid tag or folder ID.' }, 400)
      return runBackendHttp(
        c,
        runtime,
        mutateTag({ type: 'assign-folder', id, folderId, attached }, currentSeason),
        () => c.body(null, 204),
      )
    })
    routes.on(attached ? 'PUT' : 'DELETE', '/:id/templates/:templateId', async (c) => {
      const id = c.req.param('id')
      const templateId = c.req.param('templateId')
      if (!isUuidV7(id) || !isUuidV7(templateId))
        return c.json({ error: 'Invalid tag or template ID.' }, 400)
      return runBackendHttp(
        c,
        runtime,
        mutateTag({ type: 'assign', id, templateId, attached }, currentSeason),
        () => c.body(null, 204),
      )
    })
  }
  return routes
}
