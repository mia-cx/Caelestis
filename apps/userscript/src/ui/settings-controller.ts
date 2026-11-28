import { assignShortcutBinding } from '@caelestis/shared'
import type { SettingsIntent, SettingsModel } from '@caelestis/ui/elements'
import { prefetchAccessTokens } from '../application/token-inventory.js'
import { importFromOtherBuild, otherBuild, sendToOtherBuild } from '../build-transfer.js'
import {
  backendVersionOutdated,
  expectedBackendVersion,
  userscriptVersion,
} from '../client-metrics.js'
import { log } from '../debug.js'
import { applyGlobalSettingsIntent, globalSettingsModel } from '../global-settings.js'
import { consumeInvite } from '../invite.js'
import { notifyListeners } from '../listeners.js'
import { redraw } from '../map-view.js'
import { runningBuild } from '../page-claim.js'
import { isProfileEnabled, profileReport, profileSnapshot, resetProfile } from '../profile.js'
import {
  connectServer,
  onServerRemoved,
  removeServer,
  serverByUrl,
  serverLabel,
} from '../server-connections.js'
import { getState, MAX_CONNECTED_SERVERS, setState } from '../settings.js'
import { activeShortcutBindings, currentShortcutPlatform } from '../shortcuts.js'
import {
  accessTokensModel,
  createServerAccessToken,
  loadMoreAccessTokens,
  reloadAccessTokens,
  revokeServerAccessToken,
} from './access-tokens.js'
import { requestConfirmation, showAmbientToast, showToast } from './notification-host.js'
import { syncPanelButtons } from './rail.js'

/**
 * The panel's settings view: its model, what its intents do, and the state only it keeps — which
 * server rows are open, what each is waiting on, and the last shortcut change.
 */

/** Which servers' rows are open. Kept across re-renders, which rebuild the whole pane. */
const expandedServers = new Set<string>()

/** Servers whose row has already been opened for them, so it is done once and not fought over. */
const autoExpanded = new Set<string>()

onServerRemoved((url) => {
  expandedServers.delete(url)
  autoExpanded.delete(url)
})

const settingsMessages = new Map<string, string>()
/** The last recorded chord and the actions it displaced, shown until the next change. */
let shortcutChange: NonNullable<SettingsModel['shortcuts']['lastChange']> | undefined
const pendingServers = new Set<string>()
let addServerPending = false
let addServerMessage: string | undefined
let profileStatus: string | undefined

const formatBytes = (value: number | null): string => {
  if (value === null) return 'Unavailable'
  if (value < 1024) return `${value} B`
  const units = ['KiB', 'MiB', 'GiB']
  let amount = value / 1024
  let unit = units[0] ?? 'KiB'
  for (let index = 1; index < units.length && amount >= 1024; index++) {
    amount /= 1024
    unit = units[index] ?? unit
  }
  return `${amount.toFixed(amount >= 100 ? 0 : amount >= 10 ? 1 : 2)} ${unit}`
}

const formatMilliseconds = (value: number): string => `${value.toFixed(value >= 10 ? 1 : 2)} ms`

/**
 * Open the row of each server asking for a token, the first time the settings view is shown with
 * it asking: the one thing it needs is inside. Only the first time, or it could never be closed.
 */
export const openServersAskingForToken = (): void => {
  for (const server of getState().servers) {
    if (server.status === 'needs-token' && !autoExpanded.has(server.url)) {
      autoExpanded.add(server.url)
      expandedServers.add(server.url)
    }
  }
}

/** The settings view's model. */
export const settingsModel = (): SettingsModel => {
  const state = getState()
  const snapshot = isProfileEnabled() ? profileSnapshot() : null
  const extension = runningBuild() === 'extension'
  return {
    userscriptVersion,
    build: runningBuild(),
    otherBuild: otherBuild() ?? undefined,
    servers: state.servers.map((server) => {
      const message = settingsMessages.get(server.url)
      const info = server.info
      const version = [info?.version, info?.build].filter(Boolean).join(' · ')
      return {
        url: server.url,
        name: server.info?.name ?? server.url,
        status: server.status,
        ...(version === '' ? {} : { version }),
        ...(backendVersionOutdated(info?.version, expectedBackendVersion)
          ? { outdated: { expected: expectedBackendVersion } }
          : {}),
        ...(server.error === undefined ? {} : { error: server.error }),
        expanded: expandedServers.has(server.url),
        tokenSaved: server.token !== null,
        ...(server.tokenUsable === undefined ? {} : { tokenUsable: server.tokenUsable }),
        isAdmin: server.isAdmin,
        ...(server.isAdmin && expandedServers.has(server.url)
          ? { accessTokens: accessTokensModel(server, refreshSettings) }
          : {}),
        ...(pendingServers.has(server.url) ? { pending: true } : {}),
        ...(message === undefined ? {} : { message }),
      }
    }),
    ...(addServerPending ? { addServerPending: true } : {}),
    ...(addServerMessage === undefined ? {} : { addServerMessage }),
    colourNavigationOrder: state.colourNavigationOrder,
    ...globalSettingsModel('tab'),
    // The extension's store updates it, so there is no update notification to switch.
    notifyUpdates: extension ? undefined : state.notifyUpdates,
    shortcuts: {
      platform: currentShortcutPlatform(),
      bindings: activeShortcutBindings(),
      customised: Object.keys(state.shortcutOverrides).length > 0,
      ...(shortcutChange === undefined ? {} : { lastChange: shortcutChange }),
    },
    ...(snapshot === null
      ? {}
      : {
          profile: {
            note: 'CPU and GPU cover measured Caelestis work. Frame timing, long tasks and heap cover the whole tab.',
            metrics: [
              {
                id: 'main',
                label: 'Measured CPU',
                value: `${snapshot.cpu.main.dutyPercent.toFixed(2)}%`,
              },
              {
                id: 'worker',
                label: 'Worker CPU',
                value: `${snapshot.cpu.worker.dutyPercent.toFixed(2)}%`,
              },
              {
                id: 'gpu',
                label: 'Overlay GPU',
                value:
                  snapshot.gpu.supported === false
                    ? 'Unavailable'
                    : snapshot.gpu.count === 0
                      ? 'Waiting for a frame'
                      : formatMilliseconds(snapshot.gpu.averageMs),
              },
              {
                id: 'buffers',
                label: 'Known buffers',
                value: formatBytes(snapshot.memory.knownTotalBytes),
              },
              {
                id: 'heap',
                label: 'Page JS heap',
                value: formatBytes(snapshot.memory.pageUsedJSHeapBytes),
              },
              {
                id: 'frames',
                label: 'Frame p95',
                value:
                  snapshot.frames.count === 0
                    ? 'Waiting for a frame'
                    : `${formatMilliseconds(snapshot.frames.p95Ms)} · ${snapshot.frames.estimatedFps?.toFixed(0) ?? '0'} fps`,
              },
              {
                id: 'long-tasks',
                label: 'Page long tasks',
                value: !snapshot.longTasks.supported
                  ? 'Unsupported'
                  : !snapshot.longTasks.observing
                    ? 'Observer unavailable'
                    : `${snapshot.longTasks.count} · ${formatMilliseconds(snapshot.longTasks.totalMs)}`,
              },
            ],
            ...(profileStatus === undefined ? {} : { status: profileStatus }),
          },
        }),
  }
}

const listeners = new Set<() => void>()

/** Ask the settings view, if it is showing, to redraw from `settingsModel`. */
const refreshSettings = (): void => notifyListeners(listeners, 'settings view listener failed')

/** Follow changes the settings view shows that only this controller knows about. */
export const onSettingsViewChange = (listener: () => void): void => {
  listeners.add(listener)
}

let profileTimer: number | null = null

/**
 * Tell the controller whether the settings view is on screen. While it is and profiling is on, it
 * redraws every second: the profile's numbers have no change event of their own.
 */
export const setSettingsVisible = (visible: boolean): void => {
  const wanted = visible && isProfileEnabled()
  if (wanted && profileTimer === null) {
    profileTimer = window.setInterval(refreshSettings, 1_000)
  } else if (!wanted && profileTimer !== null) {
    window.clearInterval(profileTimer)
    profileTimer = null
  }
}

const SERVER_LIMIT_MESSAGE = `Already connected to ${MAX_CONNECTED_SERVERS} servers. Disconnect one first.`

const addServer = async (value: string): Promise<void> => {
  if (addServerPending) return
  addServerPending = true
  addServerMessage = 'Connecting…'
  refreshSettings()
  try {
    const outcome = await connectServer(value, null)
    switch (outcome.kind) {
      case 'connected':
        addServerMessage = undefined
        break
      case 'superseded':
        break
      case 'already':
        addServerMessage = `${outcome.server.url} is already connected.`
        break
      case 'busy':
        addServerMessage = `${outcome.disconnecting ? 'Still disconnecting' : 'Still connecting to'} ${outcome.url}. Try again in a moment.`
        break
      case 'unreachable':
      case 'refused':
        addServerMessage = `Could not reach ${outcome.server.url}. Check the address and that the server allows this origin.`
        break
      case 'full':
        addServerMessage = SERVER_LIMIT_MESSAGE
        break
    }
  } finally {
    addServerPending = false
    refreshSettings()
  }
}

const updateServerToken = async (url: string, token: string): Promise<void> => {
  if (serverByUrl(url) === undefined || pendingServers.has(url)) return
  pendingServers.add(url)
  settingsMessages.set(url, 'Checking…')
  refreshSettings()
  try {
    const outcome = await connectServer(url, token)
    switch (outcome.kind) {
      case 'connected':
      case 'full':
        expandedServers.delete(url)
        settingsMessages.delete(url)
        break
      case 'already':
      case 'superseded':
        settingsMessages.delete(url)
        break
      case 'busy':
        settingsMessages.set(
          url,
          `${outcome.disconnecting ? 'Still disconnecting' : 'Still connecting'}. Try again in a moment.`,
        )
        break
      case 'refused':
        settingsMessages.set(
          url,
          'That token was not accepted. Ask whoever runs the server for a current one.',
        )
        break
      case 'unreachable':
        settingsMessages.set(
          url,
          `Could not reach the server. ${outcome.server.error ?? ''}`.trim(),
        )
        break
    }
  } finally {
    pendingServers.delete(url)
    refreshSettings()
  }
}

/**
 * Disconnect: take the server out of the list, and everything it put on this machine with it.
 * The connection's own teardown (`removeServer`) clears every per-server cache.
 */
const disconnectServer = async (url: string): Promise<void> => {
  if (serverByUrl(url) === undefined) return
  await removeServer(url)
  redraw()
  refreshSettings()
}

/**
 * Consume an invite fragment left in the address bar, at startup and on `hashchange`.
 *
 * `history.replaceState` clears it without reloading, firing `hashchange` again, or disturbing
 * Wplace's own query string and history state. The outcome always shows, whatever the activity
 * preference and whether the panel has mounted: a painter who opened a link sees nothing else.
 */
export const openInviteFromLocation = async (): Promise<void> => {
  const outcome = await consumeInvite(location.hash, () =>
    history.replaceState(history.state, '', location.pathname + location.search),
  )
  switch (outcome?.kind) {
    case 'malformed':
      showAmbientToast("That invite link isn't valid.", 'error')
      break
    case 'busy':
      showAmbientToast(
        `Still connecting to ${outcome.url}. Open the invite again in a moment.`,
        'error',
      )
      break
    case 'already':
      showAmbientToast(`Already connected to ${serverLabel(outcome.server)}.`, 'info')
      break
    case 'connected':
      showAmbientToast(`Connected to ${serverLabel(outcome.server)}.`, 'info')
      break
    case 'full':
      showAmbientToast(SERVER_LIMIT_MESSAGE, 'error')
      break
    case 'refused':
      showAmbientToast(`${outcome.server.url} didn't accept the invite's token.`, 'error')
      break
    case 'unreachable':
      showAmbientToast(`Could not reach ${outcome.server.url}.`, 'error')
      break
  }
  refreshSettings()
}

/** Import from or send to the other build, after one confirmation. */
const moveSettings = async (
  direction: 'import-from-other-build' | 'send-to-other-build',
): Promise<void> => {
  const other = otherBuild()
  if (other === null) return
  const importing = direction === 'import-from-other-build'
  const confirmed = await requestConfirmation({
    title: importing ? `Import from the ${other}?` : `Send to the ${other}?`,
    body: importing
      ? `Your servers and settings here are replaced with the ${other}'s. Wplace then reloads.`
      : `The ${other}'s servers and settings are replaced with the ones here.`,
    note: 'Templates stay as they are; both share them.',
    confirmLabel: importing ? 'Import' : 'Send',
  })
  if (!confirmed) return
  try {
    if (importing) await importFromOtherBuild()
    else {
      await sendToOtherBuild()
      showToast(`Sent to the ${other}.`)
    }
  } catch (error) {
    showToast(
      importing ? `Could not import from the ${other}.` : `Could not send to the ${other}.`,
      'error',
    )
    log('moving settings failed', String(error))
  }
}

/** Carry out one intent from the settings view. */
export const handleSettingsIntent = (intent: SettingsIntent): void => {
  switch (intent.type) {
    case 'add-server':
      void addServer(intent.url)
      break
    case 'disconnect-server':
      void disconnectServer(intent.url)
      break
    case 'toggle-server':
      if (intent.expanded) {
        expandedServers.add(intent.url)
        const server = serverByUrl(intent.url)
        if (server?.isAdmin === true) reloadAccessTokens(server, refreshSettings)
      } else expandedServers.delete(intent.url)
      refreshSettings()
      break
    case 'prefetch-server': {
      const server = serverByUrl(intent.url)
      if (server !== undefined) prefetchAccessTokens(server)
      break
    }
    case 'update-server-token':
      void updateServerToken(intent.url, intent.token)
      break
    case 'load-more-access-tokens': {
      const server = serverByUrl(intent.url)
      if (server?.isAdmin === true) loadMoreAccessTokens(server, refreshSettings)
      break
    }
    case 'create-access-token': {
      const server = serverByUrl(intent.url)
      if (server?.isAdmin === true)
        createServerAccessToken(server, intent.label, intent.scope, refreshSettings)
      break
    }
    case 'revoke-access-token': {
      const server = serverByUrl(intent.url)
      if (server?.isAdmin === true)
        revokeServerAccessToken(server, intent.tokenHash, intent.label, refreshSettings)
      break
    }
    case 'set-colour-navigation-order':
      setState({ colourNavigationOrder: intent.value })
      break
    case 'set-simulated-input':
    case 'set-boolean':
      applyGlobalSettingsIntent(intent, 'tab')
      refreshSettings()
      break
    case 'import-from-other-build':
    case 'send-to-other-build':
      void moveSettings(intent.type)
      break
    case 'set-wplace-patch':
      // Redraws this view through the change listener installed with the panel.
      applyGlobalSettingsIntent(intent, 'tab')
      break
    case 'set-shortcut-binding': {
      const { overrides, displaced } = assignShortcutBinding(
        getState().shortcutOverrides,
        intent.id,
        intent.binding,
      )
      shortcutChange = intent.binding === null ? undefined : { id: intent.id, displaced }
      setState({ shortcutOverrides: overrides })
      syncPanelButtons()
      refreshSettings()
      break
    }
    case 'reset-shortcut-bindings':
      shortcutChange = undefined
      setState({ shortcutOverrides: {} })
      syncPanelButtons()
      refreshSettings()
      break
    case 'reset-profile':
      resetProfile()
      profileStatus = 'Reset'
      refreshSettings()
      break
    case 'copy-profile':
      if (navigator.clipboard === undefined) {
        profileStatus = 'Clipboard unavailable'
        refreshSettings()
        break
      }
      void navigator.clipboard.writeText(profileReport()).then(
        () => {
          profileStatus = 'Copied'
          refreshSettings()
        },
        () => {
          profileStatus = 'Clipboard unavailable'
          refreshSettings()
        },
      )
      break
  }
}
