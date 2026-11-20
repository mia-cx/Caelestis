import type { TemplateSurface } from '@caelestis/shared'
import { refreshAllianceManifest } from '../alliance-server-sync.js'
import type { ServerNodesResult } from '../server-api.js'
import { serverByUrl } from '../server-connections.js'
import type { ServerConnection } from '../settings.js'
import { refreshServerSnapshot, type ServerSnapshotResult } from './tree-server-state.js'

/** Refresh with the connection that is configured now, never credentials captured before an await. */
export const refreshCurrentNodes = async (
  server: ServerConnection,
  rerender: () => void,
  force = false,
): Promise<ServerSnapshotResult | null> => {
  let current = serverByUrl(server.url)
  if (current === undefined) return null
  let result = await refreshServerSnapshot(current, rerender, force)
  while (result.status === 'superseded') {
    current = serverByUrl(server.url)
    if (current === undefined) return null
    result = await refreshServerSnapshot(current, rerender)
  }
  return result
}

/** Re-read the surface a tree edit changed, so its rows show what the server now holds. */
export const refreshEditedSurface = async (
  server: ServerConnection,
  surface: TemplateSurface,
  rerender: () => void,
): Promise<void> => {
  if (surface.kind === 'world') {
    await refreshCurrentNodes(server, rerender, true)
    return
  }
  await refreshAllianceManifest(server, surface)
  rerender()
}

export type RetriableMutationResult =
  | { readonly ok: true }
  | {
      readonly ok: false
      readonly message: string
      readonly retryable?: true
      readonly stop?: true
    }

/**
 * Retry a write the tree has already drawn as done. A row placed optimistically can race the
 * server's own view of it, which answers `retryable` until it catches up.
 */
export const retryOptimisticMutation = async (
  mutate: () => Promise<RetriableMutationResult>,
): Promise<RetriableMutationResult> => {
  const delays = [120, 300] as const
  let result = await mutate()
  for (const delay of delays) {
    if (result.ok || result.retryable !== true) return result
    await new Promise((resolve) => setTimeout(resolve, delay))
    result = await mutate()
  }
  return result
}

export const serverNodesFailure = (result: Exclude<ServerNodesResult, { status: 'ok' }>): string =>
  result.status === 'unreachable'
    ? 'Could not ask that server for its current folders.'
    : 'Cannot use those folders while connected server data exceeds the client safety limits.'
