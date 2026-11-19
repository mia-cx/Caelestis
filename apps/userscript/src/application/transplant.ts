import { type TemplateSurface, WORLD_TEMPLATE_SURFACE } from '@caelestis/shared'
import {
  addLocalFolders,
  leaseLocalFolder,
  nextLocalFolderId,
  removeLocalFolders,
} from '../local-folders.js'
import {
  createNode,
  deleteNode as deleteNodeOnServer,
  deleteTemplate as deleteTemplateOnServer,
  listServerNodes,
  patchTemplate,
  uploadTemplate,
} from '../server-api.js'
import type { ServerTemplate, TreeNode } from '../server-manifest.js'
import {
  getState,
  type LocalFolder,
  MAX_LOCAL_FOLDERS,
  type ServerConnection,
} from '../settings.js'
import { newTemplateId } from '../templates/import.js'
import {
  canCopyAsLocalTemplate,
  copyAsLocalTemplate,
  isCurrentTemplate,
  leaseLocalTemplate,
  localTemplates,
  type PlacedTemplate,
  removeLocalTemplate,
  setTemplateFolder,
  templateAsPng,
  templateById,
} from '../templates/local-store.js'
import { serverTemplateKey } from '../tree-keys.js'
import { plural } from './plural.js'
import { transferAuthoring } from './template-authoring.js'
import { templateBusy } from './template-busy.js'
import {
  type DestinationAdmission,
  destinationIsAdmitted,
  errorText,
  refuse,
  refused,
  type TransferResult,
  type TransferSteps,
  transferThenRemove,
} from './transfer.js'
import { refreshEditedSurface } from './tree-server.js'
import { templatesForServer } from './tree-server-state.js'

/**
 * Moving a whole branch of the tree somewhere else — to another server, or into Local.
 *
 * A template on its own is a single call either way. A folder is not: it is a structure plus
 * everything hanging off it, the two sides describe that structure differently (a server has nodes
 * addressed by materialized path, Local has folders addressed by parent), and the pixels have to be
 * re-uploaded because content addressing is per server.
 */

/** Where a branch is going. */
export type Destination =
  | { readonly kind: 'server'; readonly server: ServerConnection; readonly nodeId: string | null }
  | { readonly kind: 'local'; readonly folderId: string | null }

/** Where it came from. */
export type Source =
  | { readonly kind: 'server'; readonly server: ServerConnection; readonly nodeId: string }
  | { readonly kind: 'local'; readonly folderId: string }

/** One template inside a branch, and the folder directly holding it. */
interface CarriedTemplate {
  readonly folderId: string
  readonly template: PlacedTemplate
  readonly sourceId: string
  /** The server row it was read from. Null for a Local source, whose record is its own revision. */
  readonly revision: ServerTemplate | null
}

/** One branch, flattened: each folder with the templates directly inside it. */
interface Branch {
  readonly name: string
  readonly folders: ReadonlyArray<{
    id: string
    parentId: string | null
    sourceParentId: string | null
    name: string
    description?: string
  }>
  readonly templates: readonly CarriedTemplate[]
}

/**
 * The drawn copy of a server template, which is where its pixels are.
 *
 * A server template that has not finished syncing has no pixels here, and re-downloading its chunks
 * to move it would be a second copy of something already in memory. Missing means "not yet", and
 * the move is refused rather than half-made.
 */
const drawnFor = (
  serverUrl: string,
  template: ServerTemplate,
  surface: TemplateSurface,
): PlacedTemplate | undefined => {
  const drawn = templateById(serverTemplateKey(serverUrl, template.id, surface))
  return drawn?.serverVersion === template.version ? drawn : undefined
}

const serverBranch = async (
  server: ServerConnection,
  rootId: string,
  surface: TemplateSurface,
): Promise<Branch | { readonly error: string } | null> => {
  const listed = await listServerNodes(server, undefined, surface)
  if (listed.status !== 'ok') {
    return {
      error:
        listed.status === 'unreachable'
          ? 'Could not ask the source server for its current folders.'
          : 'Cannot use the source folders while connected server data exceeds the client safety limits.',
    }
  }
  const { nodes } = listed
  const root = nodes.find((node) => node.id === rootId)
  if (root === undefined) return null

  // Follow the hierarchy the manifest validated and the tree renders. Paths are compared with
  // SQLite's ASCII case fold on the wire, so a compatible server may spell a child prefix with
  // different ASCII case from its parent; a raw startsWith would silently leave that branch behind.
  const children = new Map<string, TreeNode[]>()
  for (const node of nodes) {
    if (node.parentId === null) continue
    const siblings = children.get(node.parentId) ?? []
    siblings.push(node)
    children.set(node.parentId, siblings)
  }
  const within: TreeNode[] = []
  const seen = new Set<string>()
  const stack = [root]
  while (stack.length > 0) {
    const node = stack.pop()
    if (node === undefined || seen.has(node.id)) continue
    seen.add(node.id)
    within.push(node)
    stack.push(...[...(children.get(node.id) ?? [])].reverse())
  }
  const folders = within.map((node: TreeNode) => ({
    id: node.id,
    parentId: node.id === rootId ? null : node.parentId,
    sourceParentId: node.parentId,
    name: node.name,
    ...(node.description === undefined ? {} : { description: node.description }),
  }))

  const templatesByNode = new Map<string, ServerTemplate[]>()
  for (const template of templatesForServer(server.url, surface)) {
    if (template.nodeId === null) continue
    const siblings = templatesByNode.get(template.nodeId) ?? []
    siblings.push(template)
    templatesByNode.set(template.nodeId, siblings)
  }
  const templates: CarriedTemplate[] = []
  for (const node of within) {
    for (const published of templatesByNode.get(node.id) ?? []) {
      const drawn = drawnFor(server.url, published, surface)
      if (drawn === undefined) return null
      templates.push({
        folderId: node.id,
        template: drawn,
        sourceId: published.id,
        revision: published,
      })
    }
  }
  return { name: root.name, folders, templates }
}

const localBranch = (rootId: string): Branch | null => {
  const all = getState().localFolders
  const root = all.find((folder) => folder.id === rootId)
  if (root === undefined) return null

  const children = new Map<string, string[]>()
  for (const folder of all) {
    if (folder.parentId === null) continue
    const siblings = children.get(folder.parentId) ?? []
    siblings.push(folder.id)
    children.set(folder.parentId, siblings)
  }
  const within = new Set<string>()
  const stack = [rootId]
  while (stack.length > 0) {
    const id = stack.pop()
    if (id === undefined || within.has(id)) continue
    within.add(id)
    for (const child of children.get(id) ?? []) stack.push(child)
  }

  const folders = all
    .filter((folder) => within.has(folder.id))
    .map((folder) => ({
      id: folder.id,
      parentId: folder.id === rootId ? null : folder.parentId,
      sourceParentId: folder.parentId,
      name: folder.name,
    }))
  const templates = localTemplates().flatMap((template) =>
    template.folderId !== null && within.has(template.folderId)
      ? [{ folderId: template.folderId, template, sourceId: template.id, revision: null }]
      : [],
  )
  return { name: root.name, folders, templates }
}

/** Folders first, parents before children, so a destination parent always exists when needed. */
const inCreationOrder = (branch: Branch): Branch['folders'] => {
  const children = new Map<string | null, Array<Branch['folders'][number]>>()
  for (const folder of branch.folders) {
    const siblings = children.get(folder.parentId) ?? []
    siblings.push(folder)
    children.set(folder.parentId, siblings)
  }
  const out: Array<Branch['folders'][number]> = []
  const seen = new Set<string>()
  const stack = [...(children.get(null) ?? [])].reverse()
  while (stack.length > 0) {
    const folder = stack.pop()
    if (folder === undefined || seen.has(folder.id)) continue
    seen.add(folder.id)
    out.push(folder)
    const descendants = children.get(folder.id) ?? []
    for (let at = descendants.length - 1; at >= 0; at--) {
      const child = descendants[at]
      if (child !== undefined) stack.push(child)
    }
  }
  return out
}

/** What the branch's copy made at the destination. */
interface CopiedBranch extends DestinationAdmission {
  /** The root folder's identity at the destination. */
  readonly id: string
  readonly folders: number
  readonly copiedTemplates: number
}

/** Read `source` as a branch, then copy it to `destination` and take it off the source. */
const transferBranch = async (
  source: Source,
  destination: Destination,
  surface: TemplateSurface,
  rerender: () => void,
): Promise<TransferResult> => {
  const branch =
    source.kind === 'local'
      ? localBranch(source.folderId)
      : await serverBranch(source.server, source.nodeId, surface)
  if (branch !== null && 'error' in branch) return refused(branch.error)
  if (branch === null) {
    return refused(
      'Some templates in that folder have not finished loading yet — try again in a moment.',
    )
  }
  if (destination.kind === 'local') {
    const described = branch.folders.find((folder) => folder.description !== undefined)
    if (described !== undefined) {
      return refused(
        `“${described.name}” has a server description that Local folders cannot preserve.`,
      )
    }
    const wrapped = branch.templates.find(({ template }) => !canCopyAsLocalTemplate(template))
    if (wrapped !== undefined) {
      return refused(
        `“${wrapped.template.name}” wraps across the world edge and cannot be moved into Local yet.`,
      )
    }
  }

  let indexedServerTemplates: readonly ServerTemplate[] | null = null
  let serverTemplateById = new Map<string, ServerTemplate>()
  const currentServerTemplate = (server: ServerConnection, id: string) => {
    const current = templatesForServer(server.url, surface)
    if (current !== indexedServerTemplates) {
      indexedServerTemplates = current
      serverTemplateById = new Map(current.map((template) => [template.id, template]))
    }
    return serverTemplateById.get(id)
  }
  const sourceTemplateIsCurrent = (carried: CarriedTemplate): boolean => {
    if (source.kind === 'local') {
      return isCurrentTemplate(carried.template) && !templateBusy(carried.template.id, 'placing')
    }
    const current = currentServerTemplate(source.server, carried.sourceId)
    const revision = carried.revision
    return (
      current !== undefined &&
      current.nodeId === carried.folderId &&
      current.version === carried.template.serverVersion &&
      (revision === null ||
        (current.name === revision.name &&
          current.published === revision.published &&
          current.updatedAt === revision.updatedAt))
    )
  }
  const templateChanged = (carried: CarriedTemplate): string =>
    `The source version of “${carried.template.name}” changed, so the move stopped before the next write.`
  const sourceFolderIds = new Set(branch.folders.map((folder) => folder.id))
  const sourceTemplateIds = new Set(branch.templates.map((carried) => carried.sourceId))
  let checkedLocalFolders: readonly LocalFolder[] | null = null
  let checkedLocalFoldersAreCurrent = false
  const sourceFoldersAreCurrent = (): boolean => {
    const folders = getState().localFolders
    if (folders === checkedLocalFolders) return checkedLocalFoldersAreCurrent
    checkedLocalFolders = folders
    const byId = new Map(folders.map((folder) => [folder.id, folder]))
    checkedLocalFoldersAreCurrent =
      branch.folders.every((folder) => {
        const current = byId.get(folder.id)
        return (
          current !== undefined &&
          current.parentId === folder.sourceParentId &&
          current.name === folder.name
        )
      }) &&
      !folders.some(
        (folder) =>
          folder.parentId !== null &&
          sourceFolderIds.has(folder.parentId) &&
          !sourceFolderIds.has(folder.id),
      )
    return checkedLocalFoldersAreCurrent
  }
  const sourceBranchIsCurrent = (): boolean => {
    if (source.kind === 'server') return branch.templates.every(sourceTemplateIsCurrent)
    return (
      sourceFoldersAreCurrent() &&
      branch.templates.every(sourceTemplateIsCurrent) &&
      !localTemplates().some(
        (template) =>
          template.folderId !== null &&
          sourceFolderIds.has(template.folderId) &&
          !sourceTemplateIds.has(template.id),
      )
    )
  }

  const branchChanged = `The source branch “${branch.name}” changed, so the move stopped before the next write.`
  const connectionChanged =
    'A server connection changed during the move, so it stopped before the next write.'
  /** Every stop here is an error: a branch move that stops part way needs tidying by hand. */
  const stopUnless = (
    { checkpoint }: TransferSteps,
    stops: { readonly source?: string; readonly connection?: string },
  ) => checkpoint(stops, 'error')

  return await transferThenRemove<CopiedBranch>({
    connections: [source, destination].flatMap((end) =>
      end.kind === 'server' ? [end.server] : [],
    ),
    sourceIsCurrent: sourceBranchIsCurrent,
    copy: async (steps) => {
      /** Source folder id to the id it now has at the destination. */
      const mapped = new Map<string, string>()
      let folders = 0
      let copiedTemplates = 0
      const nodes: TreeNode[] = []
      const templates: DestinationAdmission['templates'][number][] = []

      // Local folders are built in memory and written once. `setState` serialises the whole state,
      // so one write per folder costs the square of the branch: a server branch of any real size
      // locked the tab up before any of it appeared.
      const madeLocally: LocalFolder[] = []

      // A Local destination is built synchronously below. Nothing can change the server source
      // during that batch, so one check protects the whole loop without rescanning a large manifest
      // per folder.
      if (destination.kind === 'local') stopUnless(steps, { source: branchChanged })
      for (const folder of inCreationOrder(branch)) {
        const parent =
          folder.parentId === null
            ? destination.kind === 'server'
              ? destination.nodeId
              : destination.folderId
            : (mapped.get(folder.parentId) ?? null)
        if (destination.kind === 'server') {
          stopUnless(steps, { source: branchChanged, connection: connectionChanged })
          const created = await createNode(
            destination.server,
            folder.name,
            parent,
            folder.description,
            surface,
          )
          if (!created.ok) throw refuse(created.message)
          stopUnless(steps, { source: branchChanged })
          mapped.set(folder.id, created.node.id)
          nodes.push(created.node)
        } else {
          const id = nextLocalFolderId()
          madeLocally.push({ id, parentId: parent, name: folder.name, visible: true, surface })
          mapped.set(folder.id, id)
        }
        folders++
      }

      if (!addLocalFolders(madeLocally)) {
        throw refuse(`That branch has more folders than Local can hold (${MAX_LOCAL_FOLDERS}).`)
      }
      // `addLocalFolders` notifies the tree, which makes this new skeleton visible while templates
      // are copied one at a time. Pin every new folder synchronously before the first await, so
      // deleting a row mid-copy cannot invalidate a later assignment. No user event can run between
      // the batch and these leases.
      for (const folder of madeLocally) {
        const release = leaseLocalFolder(folder.id)
        if (release === null) {
          throw refuse(`The new Local folder “${folder.name}” could not be kept for the move.`)
        }
        steps.hold(release)
      }

      for (const carried of branch.templates) {
        const target = mapped.get(carried.folderId)
        if (target === undefined) continue
        const { template } = carried
        if (destination.kind === 'server') {
          stopUnless(steps, { source: branchChanged, connection: connectionChanged })
          const png = await templateAsPng(template)
          if (png === null) throw refuse(`Could not encode “${template.name}”.`)
          const authoring = await transferAuthoring(template)
          if ('message' in authoring) throw refuse(authoring.message)
          if (!isCurrentTemplate(template) || templateBusy(template.id, 'placing')) {
            throw refuse(`“${template.name}” changed while it was being copied.`)
          }
          if (!sourceTemplateIsCurrent(carried)) throw refuse(templateChanged(carried))
          stopUnless(steps, { connection: connectionChanged })
          const name = carried.revision?.name ?? template.name
          const uploaded = await uploadTemplate(destination.server, {
            nodeId: target,
            name,
            originX: template.originX,
            originY: template.originY,
            png,
            surface: template.surface ?? WORLD_TEMPLATE_SURFACE,
            authoring: authoring.authoring,
          })
          if (!uploaded.ok) throw refuse(uploaded.message)
          const published = carried.revision?.published === true
          if (published) {
            stopUnless(steps, { source: branchChanged, connection: connectionChanged })
            const patched = await patchTemplate(destination.server, uploaded.id, {
              published: true,
            })
            if (!patched.ok) {
              throw refuse(
                `Copied “${template.name}” as a draft, but could not publish it at the destination.`,
              )
            }
          }
          templates.push({
            id: uploaded.id,
            nodeId: target,
            name,
            version: uploaded.version,
            published,
          })
        } else {
          stopUnless(steps, { source: branchChanged })
          const authoring = await transferAuthoring(template)
          if ('message' in authoring) throw refuse(authoring.message)
          let copied: PlacedTemplate
          try {
            copied = await copyAsLocalTemplate(template, newTemplateId(), authoring.authoring)
          } catch (error) {
            throw refuse(`Could not copy “${template.name}” into Local: ${errorText(error)}`)
          }
          const release = leaseLocalTemplate(copied.id)
          if (release === null) {
            throw refuse(`Copied “${template.name}”, but could not keep the new Local copy.`)
          }
          steps.hold(release)
          if (!(await setTemplateFolder(copied.id, target))) {
            throw refuse(`Copied “${template.name}”, but could not put it in its Local folder.`)
          }
        }
        // The source can advance while the destination write itself awaits. Stop before beginning
        // the next template rather than discovering the changed earlier row only during cleanup.
        stopUnless(steps, { source: branchChanged })
        copiedTemplates++
      }

      const id = mapped.get(source.kind === 'local' ? source.folderId : source.nodeId)
      if (id === undefined) throw refuse('The moved folder has no destination identity.')
      return { id, nodes, templates, folders, copiedTemplates }
    },
    verifySource: async (copied, steps) => {
      if (destination.kind !== 'server') return
      stopUnless(steps, { connection: connectionChanged })
      await refreshEditedSurface(destination.server, surface, rerender)
      if (!(await destinationIsAdmitted(destination.server, copied, surface))) {
        throw refuse(
          'Copied the branch, but its destination could not be admitted, so the source was kept.',
        )
      }
      stopUnless(steps, { source: branchChanged, connection: connectionChanged })
    },
    removeSource: async (copied, steps) => {
      if (source.kind === 'server') {
        for (const carried of branch.templates) {
          stopUnless(steps, { connection: connectionChanged })
          if (!sourceTemplateIsCurrent(carried)) throw refuse(templateChanged(carried))
          const revision = carried.revision
          if (revision === null) throw refuse(templateChanged(carried))
          const removed = await deleteTemplateOnServer(source.server, carried.sourceId, {
            version: revision.version,
            updatedAt: revision.updatedAt,
          })
          if (!removed.ok) {
            throw refuse(`Copied, but could not remove “${carried.template.name}” from the source.`)
          }
        }
        // Deepest first, because a server refuses to delete a node that still holds anything.
        for (const folder of [...inCreationOrder(branch)].reverse()) {
          stopUnless(steps, { connection: connectionChanged })
          const removed = await deleteNodeOnServer(source.server, folder.id)
          if (!removed.ok) {
            throw refuse(
              `Moved the templates, but could not remove source folder “${folder.name}”: ${removed.message}`,
            )
          }
        }
      } else {
        stopUnless(steps, { connection: connectionChanged })
        const foldersChanged = `Copied, but Local source folder “${branch.name}” changed and was kept.`
        if (!sourceFoldersAreCurrent()) throw refuse(foldersChanged)
        for (const carried of branch.templates) {
          if (!sourceFoldersAreCurrent()) throw refuse(foldersChanged)
          if (!sourceTemplateIsCurrent(carried)) {
            throw refuse(
              `Copied, but “${carried.template.name}” changed at the source and was kept.`,
            )
          }
          if (!(await removeLocalTemplate(carried.sourceId))) {
            throw refuse(`Copied, but could not remove “${carried.template.name}” from Local.`)
          }
        }
        if (!sourceFoldersAreCurrent()) throw refuse(foldersChanged)
        if (
          localTemplates().some(
            (template) => template.folderId !== null && sourceFolderIds.has(template.folderId),
          )
        ) {
          throw refuse(
            `Moved the original templates, but Local source folder “${branch.name}” received new content and was kept.`,
          )
        }
        if (!removeLocalFolders(sourceFolderIds)) {
          throw refuse(
            `Moved the templates, but could not remove Local source folder “${branch.name}”.`,
          )
        }
      }
      return `Moved “${branch.name}” — ${plural(copied.folders, 'folder')}, ${plural(copied.copiedTemplates, 'template')}.`
    },
  })
}

const activeSources = new Set<string>()

const sourceKey = (source: Source): string =>
  source.kind === 'local'
    ? `local:${source.folderId}`
    : `server:${source.server.url}:${source.nodeId}`

/**
 * Move a whole branch: copy it to `destination`, verify, then take it off `source`.
 *
 * A Local destination folder is kept present from the source read through the final source
 * deletion.
 */
export const transplant = async (
  source: Source,
  destination: Destination,
  rerender: () => void,
  surface: TemplateSurface = WORLD_TEMPLATE_SURFACE,
): Promise<TransferResult> => {
  const key = sourceKey(source)
  if (activeSources.has(key)) return refused('That folder is already being moved.')
  const releaseDestination =
    destination.kind === 'local' && destination.folderId !== null
      ? leaseLocalFolder(destination.folderId)
      : undefined
  if (releaseDestination === null) return refused('The destination Local folder no longer exists.')
  activeSources.add(key)
  try {
    const result = await transferBranch(source, destination, surface, rerender)
    const servers = new Map<string, ServerConnection>()
    if (source.kind === 'server') servers.set(source.server.url, source.server)
    if (destination.kind === 'server') servers.set(destination.server.url, destination.server)
    void Promise.all(
      [...servers.values()].map((server) => refreshEditedSurface(server, surface, rerender)),
    )
    return result
  } finally {
    releaseDestination?.()
    activeSources.delete(key)
  }
}
