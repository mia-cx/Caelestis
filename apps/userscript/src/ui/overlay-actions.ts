import type { OverlayControlsModel, RailControlModel } from '@caelestis/ui/elements'
import { refreshAllianceManifest } from '../alliance-server-sync.js'
import { transferAuthoring } from '../application/template-authoring.js'
import { holdDeleting, templateBusy } from '../application/template-busy.js'
import { warn } from '../debug.js'
import {
  deleteTemplate as deleteTemplateOnServer,
  patchTemplate,
  uploadTemplateVersion,
} from '../server-api.js'
import { activeServerToken, hasServerAdminToken, serverByUrl } from '../server-connections.js'
import { admittedManifest, readManifest } from '../server-manifests.js'
import {
  getState,
  getSurfaceAppearance,
  removeTreeStateKeys,
  type ServerConnection,
} from '../settings.js'
import { ownsGroup, type PlacedTemplate, type ServerCopy } from '../templates/catalog.js'
import { hiddenColoursFor } from '../templates/colour-filter.js'
import {
  abort as abortMove,
  beginMove,
  beginServerMove,
  isFinishing,
  isMoving,
  movingId,
  placementSeq,
} from '../templates/move.js'
import { templateAsPng } from '../templates/residency.js'
import { forgetTemplateCopy } from '../templates/template-copies.js'
import { removeLocalTemplate, setLocalVisible } from '../templates/template-edits.js'
import { localTemplateKey } from '../tree-keys.js'
import { appearanceEditorModel } from './appearance.js'
import { requestConfirmation } from './notification-host.js'
import { type OverlayFailureKey, overlayFailures } from './overlay-failures.js'
import {
  appearanceFor,
  commitVisible,
  draftedAppearanceFor,
  intendVisible,
  nameFor,
  releaseVisible,
  settle,
  templateFor,
  visibleFor,
} from './overlay-writes.js'

/**
 * What a template's overlay menu offers, and what each offer does: the action rail beside the
 * gear (lifecycle, Hide, Move, Delete), the menu's own model, and the flows behind them.
 */

/** What an action needs from the menu that offered it. */
export interface MenuHost {
  readonly rerender: () => void
  /** The template whose menu is open, if any. */
  readonly openFor: () => string | null
  readonly close: () => void
  /** Put the keyboard back on `id`'s gear, unless something is being placed. */
  readonly handBack: (id: string) => void
  /** Focus one of the menu's controls, if the menu is still built for `id`. */
  readonly refocus: (id: string, control: string) => void
}

/** One button on the action rail: what it shows, its focus key, and what pressing it does. */
export interface OverlayAction {
  readonly model: RailControlModel
  readonly control: string
  readonly activate: () => void
}

const isDeleting = (id: string): boolean => templateBusy(id, 'deleting')

interface ServerActionTarget {
  readonly server: ServerConnection
  readonly templateId: string
  readonly published: boolean
  readonly version: string
  readonly updatedAt: number
}

/** The manifest row behind one server overlay, on the surface it is drawn on. */
const remoteRowFor = (template: ServerCopy, server: ServerConnection) =>
  admittedManifest(server, template.surface)?.templates.find(
    (candidate) => candidate.id === template.serverTemplateId,
  )

/** The current admin-owned manifest row behind one rendered server overlay. */
const serverActionTargetFor = (template: PlacedTemplate): ServerActionTarget | null => {
  if (template.origin !== 'server') return null
  const { url } = template.server
  const server = getState().servers.find(
    (candidate) => candidate.url === url && hasServerAdminToken(candidate),
  )
  const remote = server === undefined ? undefined : remoteRowFor(template, server)
  return server === undefined || remote === undefined
    ? null
    : {
        server,
        templateId: template.serverTemplateId,
        published: remote.published,
        version: remote.version,
        updatedAt: remote.updatedAt,
      }
}

/** Lifecycle mutations require both confirmed admin scope and a usable credential. */
const serverLifecycleTargetFor = (template: PlacedTemplate): ServerActionTarget | null => {
  const target = serverActionTargetFor(template)
  return target !== null && activeServerToken(target.server) !== null ? target : null
}

/** Lifecycle state is visible to read-scoped users too; only the mutation target is admin-gated. */
const serverLifecycleFor = (
  template: PlacedTemplate,
): { readonly finished: boolean; readonly frozen: boolean } | null => {
  if (template.origin !== 'server') return null
  const server = serverByUrl(template.server.url)
  const remote = server === undefined ? undefined : remoteRowFor(template, server)
  return remote === undefined
    ? null
    : { finished: remote.finished, frozen: remote.timelapseFrozen === true }
}

const currentServerActionTargetFor = (id: string): ServerActionTarget | null => {
  const current = templateFor(id)
  return current === undefined ? null : serverActionTargetFor(current)
}

const NO_ADMIN = 'Admin access to this server is no longer available.'

/** Why a server template refuses `action` (such as "moving it"), or null when it may proceed. */
const serverRefusal = (target: ServerActionTarget | null, action: string): string | null =>
  target === null ? NO_ADMIN : target.published ? `Unpublish this template before ${action}.` : null

const refreshServerTemplateSurface = async (
  server: ServerConnection,
  template: PlacedTemplate,
): Promise<void> => {
  const surface = template.surface
  if (surface.kind === 'world') await readManifest(server)
  else await refreshAllianceManifest(server, surface)
}

/** Record a refusal and show it. */
const refuse = (
  id: string,
  key: OverlayFailureKey,
  message: (name: string) => string,
  host: MenuHost,
  satisfied?: () => boolean,
): void => {
  overlayFailures.record(id, key, message, satisfied)
  host.rerender()
}

const pendingLifecycle = new Map<string, 'finished' | 'frozen'>()

// The first refresh can join a manifest read that started before the mutation.
const LIFECYCLE_REFRESH_ATTEMPTS = 2

const commitLifecycle = (
  id: string,
  field: 'finished' | 'frozen',
  value: boolean,
  host: MenuHost,
): void => {
  if (isDeleting(id) || pendingLifecycle.has(id)) return
  const template = templateFor(id)
  const target = template === undefined ? null : serverLifecycleTargetFor(template)
  const lifecycle = template === undefined ? null : serverLifecycleFor(template)
  if (template === undefined || target === null || lifecycle === null) {
    refuse(id, field, () => 'Admin access to this template is no longer available.', host)
    return
  }
  if (field === 'frozen' && !value && lifecycle.finished && lifecycle.frozen) {
    refuse(id, field, () => 'Reopen the template before thawing.', host)
    return
  }
  pendingLifecycle.set(id, field)
  const confirmed = (): boolean => {
    const current = templateFor(id)
    return current !== undefined && serverLifecycleFor(current)?.[field] === value
  }
  let message = 'Could not update this template. Try again.'
  settle(
    id,
    {
      keys: [field],
      run: async () => {
        const result = await patchTemplate(
          target.server,
          target.templateId,
          field === 'finished' ? { finished: value } : { timelapseFrozen: value },
        )
        message = result.ok
          ? 'Change saved, but its current state could not be confirmed. Refresh the server before trying again.'
          : result.message
        for (let attempt = 0; attempt < LIFECYCLE_REFRESH_ATTEMPTS; attempt++) {
          const server = serverByUrl(target.server.url)
          if (server === undefined) return false
          await refreshServerTemplateSurface(server, template)
          if (!result.ok || confirmed()) return result.ok
        }
        return false
      },
      refused: () => message,
      release: () => pendingLifecycle.delete(id),
      satisfied: confirmed,
      serialise: false,
    },
    host.rerender,
  )
}

/** Store a server draft's new canvas origin as a new immutable pixel version. */
const moveServerDraft = async (id: string, originX: number, originY: number): Promise<boolean> => {
  const refused = (message: string): false => {
    overlayFailures.record(id, 'move', () => message)
    return false
  }
  const before = templateFor(id)
  if (before === undefined) return refused(NO_ADMIN)
  const refusal = serverRefusal(serverActionTargetFor(before), 'moving it')
  if (refusal !== null) return refused(refusal)
  const png = await templateAsPng(before)
  // Moving keeps the pixels, so the new version keeps the source and recipe that made them.
  const carried = await transferAuthoring(before)
  if ('message' in carried) return refused(carried.message)
  const current = templateFor(id)
  const currentTarget = current === undefined ? null : serverActionTargetFor(current)
  if (
    png === null ||
    current === undefined ||
    currentTarget === null ||
    current.origin !== 'server' ||
    before.origin !== 'server' ||
    current.version !== before.version
  )
    return refused('This template changed while it was being prepared. Try again.')
  if (currentTarget.published) return refused('Unpublish this template before moving it.')
  const result = await uploadTemplateVersion(currentTarget.server, currentTarget.templateId, {
    originX,
    originY,
    name: current.name,
    png,
    authoring: carried.authoring,
  })
  if (!result.ok) return refused(result.message)
  overlayFailures.clear(id, 'move')
  // The manifest coordinator updates both the tree and the rendered server copy. The placement
  // engine accepts its local preview immediately; this read supplies the new immutable version.
  void refreshServerTemplateSurface(currentTarget.server, current)
  return true
}

const activateVisible = (id: string, host: MenuHost): void => {
  if (isDeleting(id)) return
  commitVisible(id, !visibleFor(id), host.rerender)
}

/** Templates being made visible so they can be placed: one such request at a time each. */
const showingToMove = new Set<string>()
/** Placements we have asked to stop, so the ask is not repeated every frame while it settles. */
const aborting = new Set<string>()
/**
 * Cancellations we drove ourselves for a hidden placement.
 *
 * A revert that keeps failing must not be retried forever, and the budget is per *hidden spell*:
 * showing the overlay again restores it, so a transient failure never permanently disarms the watch.
 */
const abortAttempts = new Map<string, number>()
const MAX_ABORT_ATTEMPTS = 2

const startPlacement = (id: string, host: MenuHost): void => {
  host.close()
  const moving = templateFor(id)
  const started =
    moving !== undefined && moving.origin !== 'local'
      ? beginServerMove(
          id,
          () => abortAttempts.delete(id),
          (x, y) => moveServerDraft(id, x, y),
        )
      : beginMove(id, () => abortAttempts.delete(id))
  host.handBack(id)
  if (!started || movingId() !== id) host.rerender()
}

const ANOTHER_PLACEMENT = 'Finish the placement already in progress first.'

const activateMove = (id: string, host: MenuHost): void => {
  if (isDeleting(id)) return
  const current = templateFor(id)
  if (current !== undefined && current.origin !== 'local') {
    const refusal = serverRefusal(serverActionTargetFor(current), 'moving it')
    if (refusal !== null) {
      refuse(
        id,
        'server-move',
        () => refusal,
        host,
        () => {
          const target = currentServerActionTargetFor(id)
          return target !== null && !target.published
        },
      )
      return
    }
    overlayFailures.clear(id, 'server-move')
  }
  if (isMoving()) {
    overlayFailures.unannounce(id, 'move')
    refuse(id, 'move', () => ANOTHER_PLACEMENT, host)
    return
  }
  overlayFailures.clear(id, 'move', 'move-ready', 'move-stopped')
  if (showingToMove.has(id)) return
  if (templateFor(id)?.visible && visibleFor(id)) {
    startPlacement(id, host)
    return
  }
  showingToMove.add(id)
  const seq = intendVisible(id, true)
  overlayFailures.clear(id, 'visible')
  host.rerender()
  const refused = (name: string): string => `Could not show “${name}” to move it.`
  void setLocalVisible(id, true).then(
    (shown) => {
      showingToMove.delete(id)
      releaseVisible(id, seq)
      if (!shown) {
        refuse(id, 'visible', refused, host, () => templateFor(id)?.visible === true)
        return
      }
      // A hide clicked while this show was in flight is the later action, and it wins.
      if (!visibleFor(id) || templateFor(id)?.visible !== true) {
        host.rerender()
        return
      }
      overlayFailures.clear(id, 'visible')
      if (isMoving()) refuse(id, 'move', () => ANOTHER_PLACEMENT, host)
      else if (host.openFor() !== null && host.openFor() !== id)
        refuse(id, 'move-ready', (name) => `“${name}” is ready to move — press Move again.`, host)
      else if (isDeleting(id)) host.rerender()
      else startPlacement(id, host)
    },
    () => {
      showingToMove.delete(id)
      releaseVisible(id, seq)
      refuse(id, 'visible', refused, host)
    },
  )
}

/**
 * The placement we have seen over a visible overlay, if it is still running.
 *
 * `writeInOrder` serialises writes but publishes no queue, so a Hide the tree row already had in
 * flight is invisible to any check made before the placement starts. Watching for it afterwards is
 * the only reliable answer: if the overlay we are placing goes away, the placement goes with it.
 *
 * Read from what is on screen rather than from this menu having done the showing, because the panel
 * starts placements too and they need the same watch, and it holds *which placement*, not which
 * template. A template's id matches its own next placement just as well as this one, so anything
 * that leaves this set behind (a frame that never came because the map was detached, a completion
 * this module does not own) arms the watch for a placement nobody watched.
 */
let watchedPlacement: number | null = null

/**
 * Abandon a placement whose overlay was hidden under it. Runs every frame.
 *
 * A hide that was already queued elsewhere lands after the placement has started, leaving the user
 * positioning something invisible. The later action wins: the placement is abandoned.
 */
export const stopHiddenPlacement = (rerender: () => void): void => {
  const placing = movingId()
  // Seen while visible, whoever started it: the panel's Move is the same placement over the same
  // overlay, and a hide landing under it strands the user just as completely. Forgotten the moment
  // the placement ends, so a template placed again later (hidden this time, and so deliberately
  // unwatched) does not inherit the watch from the placement before it.
  const placement = placementSeq()
  if (placement === null) watchedPlacement = null
  else if (placing !== null && templateFor(placing)?.visible === true) watchedPlacement = placement
  // Both null is not a match: nothing is being placed, so there is nothing to watch.
  if (placing === null || placement === null || watchedPlacement !== placement) return
  const stopping = placing
  if (templateFor(stopping)?.visible !== false) {
    // Visible again, so whatever failed before is behind us and the next hide starts fresh.
    abortAttempts.delete(stopping)
    return
  }
  if (
    aborting.has(stopping) ||
    // An Apply already saving owns the ending: `abort()` is a no-op while `move.ts` is finishing,
    // so attempting one here would spend the budget on calls that never ran and then blame the
    // revert. Its completion callback clears the watch; a failure resumes the session and this
    // reconciliation comes back around with the budget untouched.
    isFinishing() ||
    (abortAttempts.get(stopping) ?? 0) >= MAX_ABORT_ATTEMPTS
  )
    return
  aborting.add(stopping)
  // Counted before the call, so the bound is the number of cancellations actually performed.
  abortAttempts.set(stopping, (abortAttempts.get(stopping) ?? 0) + 1)
  void abortMove().then(() => {
    aborting.delete(stopping)
    if (!isMoving()) {
      abortAttempts.delete(stopping)
      overlayFailures.record(
        stopping,
        'move-stopped',
        (name) => `“${name}” was hidden, so its placement stopped.`,
        // It is about *this* template's placement ending over a hidden overlay. Showing it again,
        // or placing it again, is the user having moved past it; another template moving says
        // nothing about this one and leaves the message standing.
        () => templateFor(stopping)?.visible !== false || movingId() === stopping,
      )
      rerender()
      return
    }
    // The revert failed and `move.ts` resumed the same session, so the placement is still live
    // over an overlay nobody can see. Nothing else is guaranteed to bring us back here (a static
    // map produces no frames), so ask for one while the budget lasts.
    if ((abortAttempts.get(stopping) ?? 0) < MAX_ABORT_ATTEMPTS) {
      rerender()
      return
    }
    // Out of self-driven attempts. The watch stays armed (a later hide, or the same one after the
    // overlay is shown again, must still be able to stop this), and what is left is a message the
    // user can act on rather than a loop.
    overlayFailures.record(
      stopping,
      'move-stopped',
      (name) => `“${name}” is hidden and its placement could not be stopped. Cancel it to undo.`,
      // It claims a live placement over a hidden overlay. Either half becoming false retires it.
      () => movingId() !== stopping || templateFor(stopping)?.visible !== false,
    )
    rerender()
  })
}

/** Retire refusals whose subject has since become true, and a Move refusal once nothing is placed. */
export const expireFailures = (id: string): void => {
  if (!isMoving() && overlayFailures.has(id, 'move')) overlayFailures.clear(id, 'move')
  overlayFailures.expire(id)
}

/** Templates awaiting the shared deletion dialog's answer. */
const confirming = new Set<string>()

const refusedWhilePlacing = (id: string, host: MenuHost): boolean => {
  if (movingId() !== id) return false
  refuse(
    id,
    'delete',
    (name) => `Finish placing “${name}” before deleting it.`,
    host,
    () => movingId() !== id,
  )
  return true
}

/** Refuse a delete of a server template this connection may not, or must not yet, remove. */
const refusedOnServer = (template: PlacedTemplate, host: MenuHost): boolean => {
  if (template.origin === 'local') return false
  const refusal = serverRefusal(serverActionTargetFor(template), 'deleting it here')
  if (refusal === null) return false
  refuse(template.id, 'delete', () => refusal, host)
  return true
}

const requestDelete = (id: string, host: MenuHost): void => {
  if (isDeleting(id)) return
  const current = templateFor(id)
  if (current === undefined) return
  if (refusedOnServer(current, host) || refusedWhilePlacing(id, host)) return
  if (confirming.has(id)) return
  confirming.add(id)
  void requestConfirmation({
    title: current.origin !== 'local' ? 'Delete published template?' : 'Delete template?',
    body: `${current.name} will be permanently removed.`,
    note:
      current.origin !== 'local'
        ? 'Everyone connected to this server will stop seeing it.'
        : 'It is stored in this browser only.',
    confirmLabel: 'Delete',
  }).then((confirmed) => {
    confirming.delete(id)
    host.refocus(id, 'delete')
    if (confirmed) confirmDelete(id, host)
  })
}

const confirmDelete = (id: string, host: MenuHost): void => {
  if (isDeleting(id) || refusedWhilePlacing(id, host)) return
  const current = templateFor(id)
  if (current === undefined || refusedOnServer(current, host)) return
  const serverTarget = serverActionTargetFor(current)
  const releaseDeleting = holdDeleting(id)
  overlayFailures.clear(id, 'delete')
  host.rerender()
  let serverRemovalFailure: string | null = null
  const removal =
    serverTarget === null
      ? removeLocalTemplate(id)
      : deleteTemplateOnServer(serverTarget.server, serverTarget.templateId, {
          version: serverTarget.version,
          updatedAt: serverTarget.updatedAt,
        }).then(async (result) => {
          if (!result.ok) {
            serverRemovalFailure = result.message
            return false
          }
          await forgetTemplateCopy(id)
          void refreshServerTemplateSurface(serverTarget.server, current)
          return true
        })
  void removal.then(
    (removed) => {
      releaseDeleting()
      if (!removed) {
        refuse(
          id,
          'delete',
          serverRemovalFailure === null
            ? (name) => `Could not delete “${name}”.`
            : () => serverRemovalFailure ?? 'Could not delete this template.',
          host,
        )
        return
      }
      if (serverTarget === null) removeTreeStateKeys(new Set([localTemplateKey(id)]))
      if (host.openFor() === id) host.close()
      host.rerender()
    },
    (error: unknown) => {
      releaseDeleting()
      warn(`delete for ${nameFor(id)} threw`, error)
      refuse(id, 'delete', (name) => `Could not delete “${name}”.`, host)
    },
  )
}

/** Whether the shared deletion dialog is open for any template. */
export const isConfirmingDelete = (): boolean => confirming.size > 0

/** The action rail beside an open menu's gear, top to bottom. */
export const overlayActions = (template: PlacedTemplate, host: MenuHost): OverlayAction[] => {
  const { id } = template
  const deleting = isDeleting(id)
  const visible = visibleFor(id)
  const serverTarget = serverActionTargetFor(template)
  const serverProtected = serverTarget?.published === true
  const lifecycle = serverLifecycleFor(template)
  const pending = pendingLifecycle.get(id)
  const actions: OverlayAction[] = []
  if (serverLifecycleTargetFor(template) !== null && lifecycle !== null) {
    const { finished, frozen } = lifecycle
    actions.push(
      {
        model: {
          id: 'overlay-finished',
          control: 'finished',
          label:
            pending === 'finished'
              ? 'Saving completion…'
              : finished
                ? 'Reopen template'
                : 'Mark as complete',
          pressed: finished,
          disabled: deleting || pending !== undefined,
          busy: pending === 'finished',
        },
        control: 'finished',
        activate: () => commitLifecycle(id, 'finished', !finished, host),
      },
      {
        model: {
          id: 'overlay-frozen',
          control: 'frozen',
          label:
            pending === 'frozen'
              ? 'Saving timelapse state…'
              : frozen
                ? 'Thaw timelapse'
                : 'Freeze timelapse',
          ...(finished && frozen ? { title: 'Reopen the template before thawing' } : {}),
          pressed: frozen,
          disabled: deleting || pending !== undefined || (finished && frozen),
          busy: pending === 'frozen',
        },
        control: 'frozen',
        activate: () => commitLifecycle(id, 'frozen', !frozen, host),
      },
    )
  }
  actions.push({
    model: {
      id: 'overlay-visible',
      control: 'hide',
      label: visible ? 'Hide this overlay' : 'Show this overlay',
      ...(visible ? {} : { pressed: true }),
      disabled: deleting,
    },
    control: 'hide',
    activate: () => activateVisible(id, host),
  })
  if (template.origin !== 'local' && serverTarget === null) return actions
  actions.push(
    {
      model: {
        id: 'overlay-move',
        control: 'move',
        label: serverProtected ? 'Unpublish before moving this overlay' : 'Move this overlay',
        pressed: false,
        disabled: deleting || serverProtected,
      },
      control: 'move',
      activate: () => activateMove(id, host),
    },
    {
      model: {
        id: 'overlay-delete',
        control: 'delete',
        label: serverProtected ? 'Unpublish before deleting this template' : 'Delete this template',
        pressed: false,
        disabled: deleting || movingId() === id || serverProtected,
        busy: deleting,
        danger: true,
      },
      control: 'delete',
      activate: () => requestDelete(id, host),
    },
  )
  return actions
}

/** The menu's own content: its heading, artwork update, lifecycle, refusals and appearance. */
export const overlayModel = (template: PlacedTemplate): OverlayControlsModel => {
  const { id } = template
  const surface = template.surface
  const deleting = isDeleting(id)
  const lifecycle = serverLifecycleFor(template)
  return {
    name: template.name,
    ...(template.origin === 'local' || serverActionTargetFor(template) !== null
      ? {
          updateArtwork: {
            pending: templateBusy(id, 'updating'),
            disabled: deleting || movingId() === id,
          },
        }
      : {}),
    ...(lifecycle === null
      ? {}
      : { lifecycle: { finished: lifecycle.finished, frozen: lifecycle.frozen, griefed: false } }),
    failures: overlayFailures.render(id, template.name).map((failure) => ({
      id: failure.key,
      message: failure.message,
      announce: failure.announce,
    })),
    appearance: {
      ...appearanceEditorModel({
        values: draftedAppearanceFor(id),
        defaults: getSurfaceAppearance(surface),
        hidden: new Set(hiddenColoursFor(appearanceFor(id), surface)),
        disabled: deleting,
      }),
      onlySelectedColour: false,
      showOnlySelectedColour: false,
      showMarkers: true,
      groups: {
        pixels: { owned: ownsGroup(template, 'pixels') },
        markers: { owned: ownsGroup(template, 'markers') },
        colours: { owned: ownsGroup(template, 'colours') },
      },
      disabled: deleting,
    },
  }
}

/**
 * What the menu and its action rail draw, as one comparable string.
 *
 * Every input to {@link overlayModel} and {@link overlayActions} appears here, so "the menu is
 * stale" and "the signature did not change" cannot come apart.
 */
export const menuSignature = (template: PlacedTemplate): string => {
  const { id } = template
  const appearance = draftedAppearanceFor(id)
  const serverTarget = serverActionTargetFor(template)
  const lifecycle = serverLifecycleFor(template)
  // Serialised, not joined on a separator. Ids and names are arbitrary strings, so a `|` they can
  // both contain lets two different templates produce one signature (`{id:"a|b", name:"c"}` and
  // `{id:"a", name:"b|c"}`), and the menu is then reused for the wrong one, handlers and all.
  return JSON.stringify([
    id,
    template.name,
    visibleFor(id),
    lifecycle?.finished ?? false,
    lifecycle?.frozen ?? false,
    serverLifecycleTargetFor(template) !== null,
    pendingLifecycle.get(id),
    appearance.radius,
    appearance.translateX,
    appearance.translateY,
    appearance.rotation,
    // A drag's value lives in the drafts and survives a rebuild; the drag guard keeps the element
    // itself from being replaced under the pointer.
    appearance.size,
    appearance.opacity,
    [...appearance.hiddenColours].sort((a, b) => a - b).join('.'),
    [...hiddenColoursFor(appearance, template.surface)].sort((a, b) => a - b).join('.'),
    appearance.markMismatch,
    appearance.markUnpainted,
    appearance.unpaintedLimit,
    appearance.markerColour,
    appearance.markerSize,
    appearance.dimOthers,
    appearance.otherOpacity,
    appearance.otherColour,
    [...(template.owns ?? [])].sort().join('.'),
    templateBusy(id, 'updating'),
    isDeleting(id),
    // Delete's `aria-disabled`: a placement beginning or ending while the menu is open otherwise
    // leaves the button announcing the opposite of what it will do.
    movingId() === id,
    serverTarget === null ? null : [serverTarget.server.url, serverTarget.published],
    overlayFailures.signature(id, template.name),
  ])
}

/** Drop the action-side memory of a template that has gone. */
export const forgetActions = (id: string): void => {
  showingToMove.delete(id)
  // An armed auto-abort watch outliving its template would fire on a later placement of the id.
  aborting.delete(id)
  abortAttempts.delete(id)
  pendingLifecycle.delete(id)
  confirming.delete(id)
}

/** Every template with an action in flight. */
export const actionIds = (): readonly string[] => [...pendingLifecycle.keys(), ...confirming]
