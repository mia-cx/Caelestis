import { type TemplateSurface, WORLD_TEMPLATE_SURFACE } from '@caelestis/shared'
import {
  admittedServerContentsFor,
  deleteTemplate as deleteTemplateOnServer,
  listServerContents,
  listServerNodes,
  patchTemplate,
  uploadTemplate,
} from '../server-api.js'
import type { ServerTemplate } from '../server-cache.js'
import { isCurrentServerConnection, serverLabel } from '../server-connections.js'
import type { TreeNode } from '../server-manifest.js'
import type { ServerConnection } from '../settings.js'
import { newTemplateId } from '../templates/import.js'
import {
  copyAsLocalTemplate,
  isCurrentTemplate,
  leaseLocalTemplate,
  type PlacedTemplate,
  setTemplateFolder,
  templateAsPng,
  templateById,
} from '../templates/local-store.js'
import { transferAuthoring } from './template-authoring.js'
import { templateBusy } from './template-busy.js'
import { refreshEditedSurface } from './tree-server.js'
import { serverTemplateAt } from './tree-server-state.js'

/**
 * What a transfer did, worded for the person who asked for it.
 *
 * Every failure here is one a person needs told in a sentence — a server refused a name, a template
 * has not finished loading — so transfers return this rather than throwing.
 */
export interface TransferResult {
  readonly ok: boolean
  readonly message: string
  readonly tone: 'info' | 'warning' | 'error'
  /** The destination copy's id, present once one exists, even if the source was kept. */
  readonly destinationId?: string
}

/** What can move under a transfer while it awaits. */
type Drift = 'connection' | 'source'

export interface TransferSteps {
  /**
   * Stop unless every connection is still current and the source is still the revision being
   * copied. `stops` holds the message for each drift to check, checked in the order written.
   */
  readonly checkpoint: (
    stops: Partial<Record<Drift, string>>,
    tone?: TransferResult['tone'],
  ) => void
  /** Keep `release` until the transfer ends. Releases run newest first. */
  readonly hold: (release: () => void) => void
}

export interface Transfer<Copied extends { readonly id: string }> {
  /** The server at either end. Each must stay the configured connection throughout. */
  readonly connections: readonly ServerConnection[]
  readonly sourceIsCurrent: () => boolean
  /** Make the destination copy. Nothing at the source is touched yet. */
  readonly copy: (steps: TransferSteps) => Promise<Copied>
  /** Prove the copy arrived and the source is still what was copied. */
  readonly verifySource: (copied: Copied, steps: TransferSteps) => Promise<void>
  /** Take the source away, and say what moved. */
  readonly removeSource: (copied: Copied, steps: TransferSteps) => Promise<string>
  /** Runs when the transfer stops after the copy exists, keeping the source. */
  readonly onKept?: () => void
}

class TransferStop extends Error {
  readonly result: TransferResult
  constructor(message: string, tone: TransferResult['tone']) {
    super(message)
    this.result = { ok: false, tone, message }
  }
}

/** Stop the running transfer with `message`. Throw what this returns. */
export const refuse = (message: string, tone: TransferResult['tone'] = 'error'): Error =>
  new TransferStop(message, tone)

/** A transfer refused before it began. */
export const refused = (
  message: string,
  tone: TransferResult['tone'] = 'error',
): TransferResult => ({ ok: false, tone, message })

export const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

/**
 * Copy to the destination, verify, then remove from the source.
 *
 * The source is only touched once the destination holds the whole copy and the source is still the
 * revision that was copied. A move that fails half way leaves the original intact and a partial copy
 * at the destination, which is recoverable by hand; the reverse — a deleted original and a partial
 * copy — is not.
 */
export const transferThenRemove = async <Copied extends { readonly id: string }>(
  transfer: Transfer<Copied>,
): Promise<TransferResult> => {
  const releases: Array<() => void> = []
  const steps: TransferSteps = {
    checkpoint: (stops, tone = 'warning') => {
      for (const [drift, message] of Object.entries(stops)) {
        const holds =
          drift === 'connection'
            ? transfer.connections.every((server) => isCurrentServerConnection(server))
            : transfer.sourceIsCurrent()
        if (!holds) throw refuse(message, tone)
      }
    },
    hold: (release) => {
      releases.push(release)
    },
  }
  let copied: Copied | undefined
  try {
    copied = await transfer.copy(steps)
    await transfer.verifySource(copied, steps)
    const message = await transfer.removeSource(copied, steps)
    return { ok: true, tone: 'info', message, destinationId: copied.id }
  } catch (error) {
    if (!(error instanceof TransferStop)) throw error
    if (copied === undefined) return error.result
    transfer.onKept?.()
    return { ...error.result, destinationId: copied.id }
  } finally {
    for (const release of releases.reverse()) release()
  }
}

/** What a destination must list, once admitted, for the source to be removed. */
export interface DestinationAdmission {
  readonly nodes: readonly TreeNode[]
  readonly templates: ReadonlyArray<{
    readonly id: string
    readonly nodeId: string | null
    readonly name: string
    readonly version: string
    readonly published: boolean
  }>
}

const destinationAdmissionControllers = new Map<string, Set<AbortController>>()

export const cancelDestinationAdmissions = (serverUrl: string): void => {
  const controllers = destinationAdmissionControllers.get(serverUrl)
  if (controllers === undefined) return
  for (const controller of controllers) controller.abort(new Error('destination disconnected'))
  destinationAdmissionControllers.delete(serverUrl)
}

/** The destination's folders, and its template rows by id, as freshly admitted. */
const admittedRows = async (
  server: ServerConnection,
  surface: TemplateSurface,
  signal: AbortSignal,
): Promise<{
  readonly nodes: readonly TreeNode[]
  readonly templateAt: (
    id: string,
  ) => Pick<ServerTemplate, 'nodeId' | 'name' | 'version' | 'published'> | undefined
} | null> => {
  if (surface.kind !== 'world') {
    const listed = await listServerNodes(server, signal, surface)
    if (listed.status !== 'ok') return null
    return {
      nodes: listed.nodes,
      templateAt: (id) => serverTemplateAt(server.url, id, surface) ?? undefined,
    }
  }
  if ((await listServerContents(server, signal)) === null) return null
  const admitted = admittedServerContentsFor(server)
  if (admitted === null) return null
  const templates = new Map(admitted.templates.map((template) => [template.id, template]))
  return { nodes: admitted.nodes, templateAt: (id) => templates.get(id) }
}

export const destinationIsAdmitted = async (
  server: ServerConnection,
  expected: DestinationAdmission,
  surface: TemplateSurface,
): Promise<boolean> => {
  const controller = new AbortController()
  const controllers = destinationAdmissionControllers.get(server.url) ?? new Set<AbortController>()
  controllers.add(controller)
  destinationAdmissionControllers.set(server.url, controllers)
  try {
    const admitted = await admittedRows(server, surface, controller.signal)
    if (admitted === null) return false
    const nodes = new Map(admitted.nodes.map((node) => [node.id, node]))
    const nodesArrived = expected.nodes.every((expectedNode) => {
      const node = nodes.get(expectedNode.id)
      return (
        node !== undefined &&
        node.parentId === expectedNode.parentId &&
        node.path === expectedNode.path &&
        node.name === expectedNode.name &&
        node.description === expectedNode.description &&
        node.createdAt === expectedNode.createdAt
      )
    })
    return (
      nodesArrived &&
      expected.templates.every((expectedTemplate) => {
        const template = admitted.templateAt(expectedTemplate.id)
        return (
          template !== undefined &&
          template.nodeId === expectedTemplate.nodeId &&
          template.name === expectedTemplate.name &&
          template.version === expectedTemplate.version &&
          template.published === expectedTemplate.published
        )
      })
    )
  } finally {
    controllers.delete(controller)
    if (controllers.size === 0 && destinationAdmissionControllers.get(server.url) === controllers) {
      destinationAdmissionControllers.delete(server.url)
    }
  }
}

export type LocalTemplateCopyResult =
  | { readonly ok: true; readonly id: string; readonly version: string }
  | {
      readonly ok: false
      readonly message: string
      readonly ambiguous?: true
      readonly cancelled?: true
      readonly missing?: true
      readonly retryable?: true
    }

/** Encode and upload one Local template while its placement and destination stay current. */
export const copyLocalTemplateToServer = async (
  template: PlacedTemplate,
  destination: ServerConnection,
  nodeId: string | null,
  rerender: () => void,
  options: { readonly beforeUpload?: (png: Blob) => boolean } = {},
): Promise<LocalTemplateCopyResult> => {
  const png = await templateAsPng(template)
  if (png === null) return { ok: false, message: 'Could not encode that template.' }
  const carried = await transferAuthoring(template)
  if ('message' in carried) return { ok: false, message: carried.message }
  if (!isCurrentTemplate(template) || templateBusy(template.id, 'placing')) {
    return {
      ok: false,
      message: `“${template.name}” changed while it was being encoded — try again.`,
      retryable: true,
    }
  }
  if (options.beforeUpload?.(png) === false) {
    return { ok: false, message: '', cancelled: true }
  }
  if (!isCurrentServerConnection(destination)) {
    return {
      ok: false,
      message: 'That destination server was disconnected or replaced.',
    }
  }
  const surface = template.surface ?? WORLD_TEMPLATE_SURFACE
  const uploaded = await uploadTemplate(destination, {
    nodeId,
    name: template.name,
    originX: template.originX,
    originY: template.originY,
    png,
    surface,
    authoring: carried.authoring,
  })
  // The write result is useful immediately. Reconciliation still belongs to this transaction, but
  // a slow manifest must not keep a completed upload looking stuck behind its 120-second timeout.
  void refreshEditedSurface(destination, surface, rerender)
  return uploaded
}

/** Resolve the installed Local snapshot at the start of each user-visible copy attempt. */
export const copyCurrentLocalTemplateToServer = async (
  templateId: string,
  templateName: string,
  destination: ServerConnection,
  nodeId: string | null,
  rerender: () => void,
  options: { readonly beforeUpload?: (png: Blob) => boolean },
): Promise<LocalTemplateCopyResult> => {
  const template = templateById(templateId)
  if (template === undefined) {
    return { ok: false, message: `“${templateName}” is no longer here.`, missing: true }
  }
  return copyLocalTemplateToServer(template, destination, nodeId, rerender, options)
}

/** Whether `latest` is still the server row a transfer began from. */
const sameRevision = (first: ServerTemplate, latest: ServerTemplate | null): boolean =>
  latest !== null &&
  first.id === latest.id &&
  first.nodeId === latest.nodeId &&
  first.name === latest.name &&
  first.version === latest.version &&
  first.published === latest.published &&
  first.updatedAt === latest.updatedAt

/**
 * The server row `drawn` was drawn from, while the two agree on its version. The pixels come from
 * the drawn copy, so a row that has moved on has nothing current to move yet.
 */
const sourceRow = (server: ServerConnection, drawn: PlacedTemplate, id: string) => {
  const row = serverTemplateAt(server.url, id, drawn.surface ?? WORLD_TEMPLATE_SURFACE)
  return row === null || drawn.serverVersion !== row.version ? null : row
}

/** Copy one server template into Local, verify its source revision, then remove the source. */
export const moveServerTemplateToLocal = async (
  source: ServerConnection,
  published: Pick<ServerTemplate, 'id' | 'name'>,
  drawn: PlacedTemplate,
  folderId: string | null,
  rerender: () => void,
): Promise<TransferResult> => {
  const surface = drawn.surface ?? WORLD_TEMPLATE_SURFACE
  if (!isCurrentServerConnection(source)) {
    return refused('That server connection changed before the move began.', 'warning')
  }
  const current = sourceRow(source, drawn, published.id)
  if (current === null) {
    return refused('That template has not finished loading its current version yet.', 'warning')
  }
  return await transferThenRemove({
    connections: [source],
    sourceIsCurrent: () =>
      sameRevision(current, serverTemplateAt(source.url, published.id, surface)),
    copy: async ({ hold }) => {
      const carried = await transferAuthoring(drawn)
      if ('message' in carried) throw refuse(carried.message)
      let copied: PlacedTemplate
      try {
        copied = await copyAsLocalTemplate(drawn, newTemplateId(), carried.authoring)
      } catch (error) {
        throw refuse(`Could not copy “${current.name}” into Local: ${errorText(error)}`)
      }
      if (!(await setTemplateFolder(copied.id, folderId))) {
        throw refuse('Copied into Local, but could not put it in that folder.')
      }
      const release = leaseLocalTemplate(copied.id)
      if (release === null) {
        throw refuse('Copied into Local, but could not keep the new copy for the move.')
      }
      hold(release)
      return copied
    },
    verifySource: async (_, { checkpoint }) =>
      checkpoint({
        source: 'Copied into Local, but the source changed and was kept.',
        connection: 'Copied into Local, but the source connection changed and was kept.',
      }),
    removeSource: async () => {
      const removed = await deleteTemplateOnServer(source, published.id, {
        version: current.version,
        updatedAt: current.updatedAt,
      })
      void refreshEditedSurface(source, surface, rerender)
      if (!removed.ok) throw refuse(`Copied into Local, but ${removed.message}`)
      return `Moved “${published.name}” into Local.`
    },
  })
}

/** Copy one server template across servers, verify admission, then remove its source revision. */
export const moveServerTemplateToServer = async (
  source: ServerConnection,
  destination: ServerConnection,
  nodeId: string | null,
  published: Pick<ServerTemplate, 'id' | 'name'>,
  drawn: PlacedTemplate,
  rerender: () => void,
): Promise<TransferResult> => {
  const surface = drawn.surface ?? WORLD_TEMPLATE_SURFACE
  const destinationName = serverLabel(destination)
  const reconcile = (server: ServerConnection) => refreshEditedSurface(server, surface, rerender)
  if (!isCurrentServerConnection(source) || !isCurrentServerConnection(destination)) {
    return refused('A server connection changed before the move began.', 'warning')
  }
  const current = sourceRow(source, drawn, published.id)
  if (current === null) {
    return refused('That template has not finished loading yet — try again in a moment.', 'warning')
  }
  const connectionKept = `Copied to ${destinationName}, but a server connection changed and the source was kept.`
  return await transferThenRemove({
    connections: [source, destination],
    sourceIsCurrent: () =>
      sameRevision(current, serverTemplateAt(source.url, published.id, surface)),
    copy: async ({ checkpoint }) => {
      const png = await templateAsPng(drawn)
      if (png === null) throw refuse('Could not encode that template.')
      const carried = await transferAuthoring(drawn)
      if ('message' in carried) throw refuse(carried.message)
      checkpoint({
        source: 'That template changed while it was being prepared.',
        connection: 'A server connection changed while the template was being prepared.',
      })
      const uploaded = await uploadTemplate(destination, {
        nodeId,
        name: current.name,
        originX: drawn.originX,
        originY: drawn.originY,
        png,
        surface,
        authoring: carried.authoring,
      })
      if (!uploaded.ok) {
        void reconcile(destination)
        throw refuse(uploaded.message)
      }
      return uploaded
    },
    verifySource: async (copied, { checkpoint }) => {
      checkpoint({
        connection: connectionKept,
        source: `Copied to ${destinationName} as a draft, but the source changed and was kept.`,
      })
      if (current.published) {
        const publishedAtDestination = await patchTemplate(destination, copied.id, {
          published: true,
        })
        if (!publishedAtDestination.ok) {
          throw refuse(
            `Copied to ${destinationName} as a draft, but could not publish it; the source was kept.`,
          )
        }
      }
      checkpoint({ connection: connectionKept })
      if (surface.kind !== 'world') await reconcile(destination)
      const admitted = await destinationIsAdmitted(
        destination,
        {
          nodes: [],
          templates: [
            {
              id: copied.id,
              nodeId,
              name: current.name,
              version: copied.version,
              published: current.published,
            },
          ],
        },
        surface,
      )
      if (!admitted) {
        throw refuse(
          `Copied to ${destinationName}, but its destination could not be admitted; the source was kept.`,
          'warning',
        )
      }
      checkpoint({
        connection: connectionKept,
        source: `Copied to ${destinationName}, but the source changed and was kept.`,
      })
    },
    removeSource: async () => {
      const removed = await deleteTemplateOnServer(source, published.id, {
        version: current.version,
        updatedAt: current.updatedAt,
      })
      void reconcile(source)
      if (!removed.ok) {
        throw refuse(
          `Copied to ${destinationName}, but could not remove it from ${serverLabel(source)}.`,
        )
      }
      void reconcile(destination)
      return `Moved “${published.name}” to ${destinationName}.`
    },
    // Whatever stopped the move after the upload, the destination now holds something the tree
    // has not drawn yet.
    onKept: () => void reconcile(destination),
  })
}
