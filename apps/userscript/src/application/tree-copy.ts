import { WORLD_TEMPLATE_SURFACE } from '@caelestis/shared'
import { runWhileBusy } from '../concurrency.js'
import { listServerNodes, type ServerNodesResult } from '../server-api.js'
import { serverLabel } from '../server-connections.js'
import { getState, type ServerConnection } from '../settings.js'
import { templateById } from '../templates/local-store.js'
import { toast } from '../ui/toast.js'
import { plural } from './plural.js'
import { serverDestinations } from './server-destinations.js'
import { busyRefusal } from './template-busy.js'
import { copyCurrentLocalTemplateToServer } from './transfer.js'
import {
  closeOperation,
  isOperationOpen,
  MAX_DESTINATIONS,
  showOperation,
  updateOperation,
} from './tree-presentation.js'

let copySetupRunning = false
/** The servers the running copy setup is asking for folders, so their disconnect can stop it. */
let copySetupTargets: ReadonlySet<string> | null = null
const COPY_SETUP_TIMEOUT_MS = 120_000

/** Whether finding copy destinations is waiting on `serverUrl`. */
export const treeActionUsesServer = (serverUrl: string): boolean =>
  copySetupTargets?.has(serverUrl) === true

/**
 * Copy a local template onto a server.
 *
 * Only servers where the code is admin can receive one. The placement travels with it — the whole
 * point of getting it right locally first is not having to do it again on the other side.
 */
export const copyToServer = async (
  templateId: string,
  rerender: () => void,
  onlyServerUrl?: string,
): Promise<void> => {
  const template = templateById(templateId)
  if (template === undefined) return
  const surface = template.surface ?? WORLD_TEMPLATE_SURFACE
  if (copySetupRunning) return
  const targets = getState().servers.filter(
    (server) => server.isAdmin && (onlyServerUrl === undefined || server.url === onlyServerUrl),
  )
  if (targets.length === 0) {
    toast('No server here accepts uploads — you need an admin code on one.', 'warning')
    return
  }

  copySetupRunning = true
  const setupController = new AbortController()
  const setupTargets = new Set(targets.map((server) => server.url))
  copySetupTargets = setupTargets
  let setupCancelled = false
  let setupTimedOut = false
  const setupId = showOperation(
    {
      label: `Finding destinations for “${template.name}”…`,
      pending: true,
      cancellable: true,
    },
    rerender,
    {
      onCancel: (reason) => {
        setupCancelled = true
        setupController.abort(reason ?? new Error('copy setup cancelled'))
      },
    },
  )
  const setupTimeout = setTimeout(() => {
    setupTimedOut = true
    setupController.abort(new Error('copy setup timed out'))
  }, COPY_SETUP_TIMEOUT_MS)
  let listed: Array<readonly [ServerConnection, ServerNodesResult]>
  try {
    listed = await Promise.all(
      targets.map(
        async (server) =>
          [server, await listServerNodes(server, setupController.signal, surface)] as const,
      ),
    )
  } finally {
    clearTimeout(setupTimeout)
    if (copySetupTargets === setupTargets) copySetupTargets = null
    copySetupRunning = false
  }
  if (setupController.signal.aborted) {
    if (!setupCancelled && isOperationOpen(setupId)) {
      toast(
        setupTimedOut
          ? 'Finding server folders took too long. Try Copy again.'
          : 'Copy setup stopped because a server connection changed.',
        'warning',
      )
    }
    closeOperation(setupId)
    return
  }
  if (!isOperationOpen(setupId)) return
  const unreachable = listed.filter(([, result]) => result.status === 'unreachable').length
  const notAdmitted = listed.filter(([, result]) => result.status === 'not-admitted').length
  let offered = 0
  let available = 0
  const options: Array<{ value: string; label: string }> = []
  for (const [server, result] of listed) {
    if (result.status !== 'ok') continue
    const destinations = serverDestinations(result.nodes)
    available += destinations.length
    for (const destination of destinations) {
      if (offered >= MAX_DESTINATIONS) break
      options.push({
        value: `${server.url}|${destination.nodeId ?? ''}`,
        label: `${serverLabel(server)} · ${destination.label}`,
      })
      offered++
    }
  }
  if (options.length === 0) {
    closeOperation(setupId)
    toast(
      unreachable > 0
        ? 'Could not ask any of those servers where their folders are.'
        : notAdmitted > 0
          ? 'Cannot use those folders while connected server data exceeds the client safety limits.'
          : 'No upload destination is available.',
      unreachable > 0 || notAdmitted > 0 ? 'error' : 'warning',
    )
    return
  }

  let note: string | undefined
  if (available > offered) {
    note = `Showing the first ${offered} of ${available} folders.`
  } else if (unreachable > 0) {
    note = `${plural(unreachable, 'server')} could not be asked.`
  }

  let cancelled = false
  let id = ''
  id = showOperation(
    {
      label: `Copy “${template.name}” to:`,
      options,
      ...(note === undefined ? {} : { note }),
      confirmLabel: 'Copy',
    },
    rerender,
    {
      onCancel: () => {
        cancelled = true
      },
      onConfirm: (chosen) => {
        // Split at the last separator, not the first: a node id is a UUID and never contains one, but a
        // server URL legally can — `new URL` leaves `|` in a path exactly as typed.
        const cut = chosen.lastIndexOf('|')
        const url = cut === -1 ? '' : chosen.slice(0, cut)
        const encodedNodeId = cut === -1 ? undefined : chosen.slice(cut + 1)
        const server = targets.find((candidate) => candidate.url === url)
        if (server === undefined || encodedNodeId === undefined) return
        const nodeId = encodedNodeId === '' ? null : encodedNodeId
        // This dialog stays open while the map is used, so a placement may have started since.
        const busy = busyRefusal(template, 'copying it')
        if (busy !== null) {
          toast(busy, 'warning')
          return
        }
        updateOperation(id, { label: 'Encoding…', pending: true })
        void runWhileBusy(`template:copy:${templateId}`, async () => {
          const result = await copyCurrentLocalTemplateToServer(
            templateId,
            template.name,
            server,
            nodeId,
            rerender,
            {
              beforeUpload: (png) => {
                if (cancelled || !isOperationOpen(id)) return false
                updateOperation(id, {
                  label: `Uploading ${Math.round(png.size / 1024)} KB…`,
                  cancellable: false,
                })
                return true
              },
            },
          )
          if (!result.ok && result.cancelled === true) return
          if (!result.ok && result.missing === true) {
            closeOperation(id)
            toast(result.message, 'error')
            return
          }
          if (!result.ok && result.retryable === true) {
            updateOperation(id, {
              label: `Copy “${template.name}” to:`,
              pending: false,
              cancellable: true,
            })
            toast(result.message, 'warning')
            return
          }
          closeOperation(id)
          if (result.ok) toast(`Copied “${template.name}” to ${serverLabel(server)}.`)
          else toast(result.message, 'error')
        })
      },
    },
  )
}
