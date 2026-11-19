import { MAX_TEMPLATE_SOURCE_BYTES, parseTemplateRecipe, sha256Hex } from '@caelestis/shared'
import { serverRequest } from '../server-request.js'
import type { ServerRead } from '../server-transport.js'
import { getState, type ServerConnection } from '../settings.js'
import { currentAuthoring, type TemplateAuthoring } from '../templates/authoring.js'
import { isServerTemplate, type PlacedTemplate, templatePixels } from '../templates/local-store.js'

const serverGet = <Read extends ServerRead>(server: ServerConnection, path: string, read: Read) =>
  serverRequest(server, path, { limits: 'interactive', read })

/**
 * The source and recipe behind a server version. Null for processed-only versions. The server is
 * not trusted: the source must hash to what the recipe names.
 */
export const readServerAuthoring = async (
  server: ServerConnection,
  versionId: string,
  indices: Uint8Array,
): Promise<TemplateAuthoring | null> => {
  const recipeRead = await serverGet(server, `/recipes/${versionId}`, 'json')
  if (recipeRead.response.status === 404) return null
  if (!recipeRead.response.ok) throw new Error(`Server said ${recipeRead.response.status}.`)
  const body = recipeRead.body
  const recipe = parseTemplateRecipe(
    typeof body === 'object' && body !== null && 'recipe' in body ? body.recipe : null,
  )
  if (recipe === null) throw new Error('The server returned an unreadable recipe.')
  const source = await serverGet(server, `/sources/${recipe.source.sha256}`, 'bytes')
  if (!source.response.ok) throw new Error(`Server said ${source.response.status}.`)
  const bytes = source.body
  if (
    bytes.byteLength > MAX_TEMPLATE_SOURCE_BYTES ||
    (await sha256Hex(bytes)) !== recipe.source.sha256
  )
    throw new Error('The server returned a source that does not match its recipe.')
  // A version's chunks are the artwork its recipe produced, so these indices are that artwork.
  return {
    source: new Blob([bytes], { type: 'image/png' }),
    recipe,
    artwork: await sha256Hex(indices),
  }
}

/**
 * The source and recipe that still describe a template's pixels, wherever it lives: on the local
 * record, or on the server version it was loaded from.
 */
export const authoringOf = async (template: PlacedTemplate): Promise<TemplateAuthoring | null> => {
  if (!isServerTemplate(template)) {
    if (template.authoring === undefined) return null
    return await currentAuthoring({ ...template, indices: await templatePixels(template) })
  }
  const server = getState().servers.find((candidate) => candidate.url === template.serverUrl)
  if (server === undefined || template.serverVersion === undefined) return null
  return await readServerAuthoring(server, template.serverVersion, await templatePixels(template))
}

/**
 * `authoringOf` for copies and moves. A failed read stops the transfer instead of letting a move
 * delete the only copy of the source.
 */
export const transferAuthoring = async (
  template: PlacedTemplate,
): Promise<{ readonly authoring: TemplateAuthoring | null } | { readonly message: string }> => {
  try {
    return { authoring: await authoringOf(template) }
  } catch (error) {
    return {
      message: `Could not read the source image of “${template.name}”: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}
