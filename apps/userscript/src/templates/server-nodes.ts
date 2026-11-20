import { type TemplateSurface, WORLD_TEMPLATE_SURFACE } from '@caelestis/shared'
import { manifestNodesRevision, manifestParents } from '../server-manifests.js'
import { isScopeVisible } from '../settings.js'
import { nodeScopeKey } from '../tree-keys.js'

/**
 * Whether a server folder, and everything above it, is switched on.
 *
 * A switch on a folder has to reach everything beneath it — the templates directly inside, and
 * every template inside every folder inside it. Answering that needs the parent chain, which lives
 * in the manifest store. The GL layer asks this sixty times a second, so it lives here rather than
 * in the tree that draws the switches.
 *
 * Wplace-owned trees, such as an official event's groups, have no manifest; their owners register
 * their fixed parent chain here instead.
 */

const wplaceOwnedParents = new Map<string, ReadonlyMap<string, string | null>>()
let wplaceOwnedRevision = 0

/** Register the fixed folder tree of a Wplace-owned row source, on the world surface. */
export const rememberWplaceOwnedNodes = (
  owner: string,
  nodes: readonly { id: string; parentId: string | null }[],
): void => {
  wplaceOwnedParents.set(owner, new Map(nodes.map((node) => [node.id, node.parentId])))
  wplaceOwnedRevision++
}

const parentsOf = (
  serverUrl: string,
  surface: TemplateSurface,
): ReadonlyMap<string, string | null> | undefined =>
  manifestParents(serverUrl, surface) ??
  (surface.kind === 'world' ? wplaceOwnedParents.get(serverUrl) : undefined)

/** Moves whenever any folder tree that {@link nodeChainVisible} reads does. */
export const serverNodesRevision = (): number => manifestNodesRevision() + wplaceOwnedRevision

/** Parent rows in manifest order, for consumers that need to reproduce the server tree. */
export const serverNodeParents = (
  serverUrl: string,
  surface: TemplateSurface = WORLD_TEMPLATE_SURFACE,
): readonly (readonly [id: string, parentId: string | null])[] => [
  ...(parentsOf(serverUrl, surface)?.entries() ?? []),
]

/**
 * Whether every folder from this one up to the server's root is switched on.
 *
 * A folder that is off keeps saying its contents are on, because they are — inside a group that is
 * not — and that is what makes switching the group back on restore the arrangement instead of
 * flattening it.
 *
 * Bounded by the number of nodes rather than trusting the tree to be one: a manifest is data from
 * somewhere else, and a parent cycle in it would otherwise be an infinite loop in the render path.
 */
export const nodeChainVisible = (
  serverUrl: string,
  nodeId: string | null,
  surface: TemplateSurface = WORLD_TEMPLATE_SURFACE,
): boolean => {
  const byId = parentsOf(serverUrl, surface)
  if (byId === undefined) return true
  let at = nodeId
  for (let depth = 0; at !== null && depth <= byId.size; depth++) {
    if (!isScopeVisible(nodeScopeKey(serverUrl, at))) return false
    at = byId.get(at) ?? null
  }
  return true
}
