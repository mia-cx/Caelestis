import { type TemplateSurface, WORLD_TEMPLATE_SURFACE } from '@caelestis/shared'
import { uploadTemplate } from '../server-api.js'
import { isCurrentServerConnection } from '../server-connections.js'
import type { ServerConnection } from '../settings.js'
import { isCurrentTemplate, templateById } from '../templates/catalog.js'
import type { MoveReservation } from '../templates/move.js'
import { movingId } from '../templates/move.js'
import { templateAsPng } from '../templates/residency.js'
import {
  addLocalTemplate,
  removeLocalTemplate,
  unstageLocalTemplate,
} from '../templates/template-edits.js'
import type { ImportedTemplate } from '../templates/template-record.js'
import { authoringOf } from './template-authoring.js'
import { refreshEditedSurface } from './tree-server.js'

/** What uploading the admitted templates did. Each failure was kept in Local. */
export interface ServerUpload {
  readonly uploaded: number
  readonly failures: readonly string[]
}

/**
 * What an import to a server did. `failures` are templates Local refused to admit. A started import
 * uploads straight away, or once `placementStarted` finishes; `refusal` says why one did not start,
 * when the user can do something about it.
 */
export type ServerImport =
  | {
      readonly started: false
      readonly failures: readonly string[]
      readonly refusal: string | null
    }
  | {
      readonly started: true
      readonly failures: readonly string[]
      readonly placementStarted: boolean
      readonly upload: Promise<ServerUpload>
    }

const uploadAdmitted = async (
  server: ServerConnection,
  nodeId: string | null,
  templateIds: readonly string[],
  rerender: () => void,
  surface: TemplateSurface,
): Promise<ServerUpload> => {
  let uploaded = 0
  const failures: string[] = []

  try {
    for (const templateId of templateIds) {
      const template = templateById(templateId)
      if (template === undefined) continue
      if (movingId() === template.id) {
        failures.push(`${template.name}: placement is still open`)
        continue
      }

      const png = await templateAsPng(template)
      if (png === null) {
        failures.push(`${template.name}: could not encode the template`)
        continue
      }
      if (!isCurrentTemplate(template) || movingId() === template.id) {
        failures.push(`${template.name}: changed while it was being encoded`)
        continue
      }
      if (!isCurrentServerConnection(server)) {
        failures.push(`${template.name}: the server connection changed`)
        continue
      }

      const result = await uploadTemplate(server, {
        nodeId,
        name: template.name,
        originX: template.originX,
        originY: template.originY,
        png,
        surface,
        authoring: await authoringOf(template),
      })
      if (!result.ok) {
        failures.push(`${template.name}: ${result.message}`)
        continue
      }

      uploaded++
      if (!(await removeLocalTemplate(template.id))) {
        failures.push(
          `${template.name}: uploaded, but its temporary Local copy could not be removed`,
        )
      }
    }
  } finally {
    // Uploaded copies are gone; whatever remains is kept in Local, where the sidebar lists it.
    for (const templateId of templateIds) await unstageLocalTemplate(templateId)
  }
  if (uploaded > 0) await refreshEditedSurface(server, surface, rerender)
  rerender()
  return { uploaded, failures }
}

/** Stage file imports locally only long enough to place and upload them to their chosen server. */
export interface ServerImportOptions {
  /** The placement an image import waits for; released whatever happens. */
  readonly reservation: MoveReservation | null
  readonly rerender: () => void
  readonly surface?: TemplateSurface
  /** Cancels admission and the placement start; an upload that began runs to its end. */
  readonly signal?: AbortSignal
  /** Positioned in the template studio: upload straight away, without a placement. */
  readonly placed?: boolean
}

export const importTemplatesToServer = async (
  imported: readonly ImportedTemplate[],
  server: ServerConnection,
  nodeId: string | null,
  {
    reservation,
    rerender,
    surface = WORLD_TEMPLATE_SURFACE,
    signal,
    placed = false,
  }: ServerImportOptions,
): Promise<ServerImport> => {
  if (!server.isAdmin) {
    reservation?.release()
    return {
      started: false,
      failures: [],
      refusal: 'This server needs an admin code before it can accept templates.',
    }
  }

  const first = imported[0]
  if (first === undefined) {
    reservation?.release()
    return { started: false, failures: [], refusal: null }
  }
  const needsPlacement = first.source === 'image' && !placed
  if (needsPlacement && reservation === null) {
    return {
      started: false,
      failures: [],
      refusal: 'Finish the current placement, then import this image again.',
    }
  }

  const admitted: string[] = []
  const failures: string[] = []
  try {
    for (const template of imported) {
      signal?.throwIfAborted()
      try {
        // A placed copy is durable, so a failed upload keeps it in Local where it was put.
        await addLocalTemplate(template, surface, placed, true)
        admitted.push(template.id)
      } catch (error) {
        failures.push(`${template.name}: ${String(error)}`)
      }
    }
    signal?.throwIfAborted()
    rerender()
    if (!admitted.includes(first.id)) {
      for (const id of admitted) await unstageLocalTemplate(id)
      return { started: false, failures, refusal: null }
    }

    if (!needsPlacement) {
      const upload = uploadAdmitted(server, nodeId, admitted, rerender, surface)
      return { started: true, failures, placementStarted: false, upload }
    }

    signal?.throwIfAborted()
    let uploadAfterPlacement: (upload: Promise<ServerUpload>) => void = () => {}
    const upload = new Promise<ServerUpload>((resolve) => {
      uploadAfterPlacement = resolve
    })
    const started = reservation?.start(first.id, () => {
      rerender()
      uploadAfterPlacement(uploadAdmitted(server, nodeId, admitted, rerender, surface))
    })
    if (started !== true) {
      for (const templateId of admitted) await removeLocalTemplate(templateId)
      rerender()
      return {
        started: false,
        failures,
        refusal: 'Another placement started. Import the image again when it is finished.',
      }
    }
    return { started: true, failures, placementStarted: true, upload }
  } catch (error) {
    if (signal?.aborted) {
      for (const id of admitted) await removeLocalTemplate(id)
      rerender()
    }
    throw error
  } finally {
    reservation?.release()
  }
}
