import { MAX_TEMPLATE_SOURCE_BYTES, parseTemplateRecipe, sha256Hex } from '@caelestis/shared'
import { userscriptClientHeaders } from '../client-metrics.js'
import { serverEndpoint } from '../server-url.js'
import { activeServerToken, type ConnectedServer, getState } from '../state.js'
import { currentAuthoring, type TemplateAuthoring } from '../templates/authoring.js'
import { isServerTemplate, type PlacedTemplate } from '../templates/local-store.js'

const AUTHORING_FETCH_TIMEOUT_MS = 30_000

const serverGet = async (server: ConnectedServer, path: string): Promise<Response> => {
  const token = activeServerToken(server)
  return await fetch(serverEndpoint(server.url, path), {
    headers: {
      ...userscriptClientHeaders(),
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
    },
    signal: AbortSignal.timeout(AUTHORING_FETCH_TIMEOUT_MS),
  })
}

/**
 * The source and recipe behind a server version. Null for processed-only versions. The server is
 * not trusted: the source must hash to what the recipe names.
 */
export const readServerAuthoring = async (
  server: ConnectedServer,
  versionId: string,
  indices: Uint8Array,
): Promise<TemplateAuthoring | null> => {
  const recipeResponse = await serverGet(server, `/recipes/${versionId}`)
  if (recipeResponse.status === 404) return null
  if (!recipeResponse.ok) throw new Error(`Server said ${recipeResponse.status}.`)
  const body: unknown = await recipeResponse.json()
  const recipe = parseTemplateRecipe(
    typeof body === 'object' && body !== null && 'recipe' in body ? body.recipe : null,
  )
  if (recipe === null) throw new Error('The server returned an unreadable recipe.')
  const sourceResponse = await serverGet(server, `/sources/${recipe.source.sha256}`)
  if (!sourceResponse.ok) throw new Error(`Server said ${sourceResponse.status}.`)
  const bytes = new Uint8Array(await sourceResponse.arrayBuffer())
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
  if (!isServerTemplate(template)) return await currentAuthoring(template)
  const server = getState().servers.find((candidate) => candidate.url === template.serverUrl)
  if (server === undefined || template.serverVersion === undefined) return null
  return await readServerAuthoring(server, template.serverVersion, template.indices)
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
