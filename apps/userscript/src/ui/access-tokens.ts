import type { AccessTokenScope, SettingsAccessTokensModel } from '@caelestis/ui/elements'
import {
  fetchTokens,
  isCurrentInventory,
  type TokenInventory,
  tokenInventory,
  tokenKey,
} from '../application/token-inventory.js'
import { encodeInvite } from '../invite.js'
import { createAccessToken, revokeAccessToken } from '../server-api.js'
import type { ServerConnection } from '../settings.js'
import { requestConfirmation, showOneTimeSecret, showToast } from './notification-host.js'

/**
 * The tokens a server will accept, for the admin who can change them.
 *
 * Everything here is what the server says about a token *except* the token: a label, what it may
 * do, when it was made, and whether it still works. The secret is shown once, by the dialog that
 * mints it, and after that there is nothing to show — the server keeps a hash. So this list can
 * never be a place to look one up, which is why it does not pretend to be one.
 *
 * Lives inside the server's own row in settings rather than in a view of its own. A token belongs to
 * one server the same way its address and your own token do, and separating them would mean holding
 * "which server am I looking at" in your head across two places.
 */
interface TokensView {
  /** Zero until the first reload, which decides whether the list starts out loading. */
  reloadGeneration: number
  status: 'loading' | 'ready' | 'error'
  loadingMore: boolean
  creating: boolean
  createError?: string
  created: number
  readonly revoking: Set<string>
  onChange?: () => void
}

// Keyed by inventory, so a disconnect or reconnect starts the view over with the cache.
const views = new WeakMap<TokenInventory, TokensView>()

const viewOf = (server: ServerConnection): { inventory: TokenInventory; view: TokensView } => {
  const inventory = tokenInventory(server)
  let view = views.get(inventory)
  if (view === undefined) {
    view = {
      reloadGeneration: 0,
      status: 'loading',
      loadingMore: false,
      creating: false,
      created: 0,
      revoking: new Set(),
    }
    views.set(inventory, view)
  }
  return { inventory, view }
}

const notify = (view: TokensView): void => view.onChange?.()

/** Refresh the first page; a row opening is also a background refresh of any cached inventory. */
export const reloadAccessTokens = (
  server: ServerConnection,
  onChange: () => void,
  supersede = false,
): void => {
  const { inventory, view } = viewOf(server)
  view.onChange = onChange
  if (view.reloadGeneration === 0)
    view.status = inventory.cached === undefined ? 'loading' : 'ready'
  const generation = ++view.reloadGeneration
  void fetchTokens(server, null, supersede).then((page) => {
    if (!isCurrentInventory(inventory) || generation !== view.reloadGeneration) return
    if (page !== null) view.status = 'ready'
    else if (inventory.cached === undefined) view.status = 'error'
    else {
      view.status = 'ready'
      showToast('Could not refresh the token list — showing the last result.', 'error')
    }
    notify(view)
  })
}

/** Presentation-ready token state for a server's settings row. */
export const accessTokensModel = (
  server: ServerConnection,
  onChange: () => void,
): SettingsAccessTokensModel => {
  const { inventory, view } = viewOf(server)
  view.onChange = onChange
  if (view.reloadGeneration === 0) reloadAccessTokens(server, onChange)
  const cached = inventory.cached
  return {
    status: view.status,
    tokens: (cached?.tokens ?? []).map((token) => ({
      tokenHash: tokenKey(token),
      label: token.label,
      scope: token.bootstrap === true ? 'admin' : token.scope,
      createdAt: token.createdAt,
      bootstrap: token.bootstrap === true,
      ...(token.bootstrap !== true && view.revoking.has(token.tokenHash) ? { pending: true } : {}),
    })),
    hasMore: cached?.nextCursor !== null && cached?.nextCursor !== undefined,
    ...(server.info?.capture === 1 ? { eventRunners: true } : {}),
    ...(view.loadingMore ? { loadingMore: true } : {}),
    ...(view.creating ? { creating: true } : {}),
    ...(view.createError === undefined ? {} : { createError: view.createError }),
    created: view.created,
  }
}

export const loadMoreAccessTokens = (server: ServerConnection, onChange: () => void): void => {
  const { inventory, view } = viewOf(server)
  const cursor = inventory.cached?.nextCursor
  if (cursor === null || cursor === undefined || view.loadingMore) return
  view.onChange = onChange
  view.loadingMore = true
  notify(view)
  void fetchTokens(server, cursor).then((page) => {
    if (!isCurrentInventory(inventory)) return
    view.loadingMore = false
    if (page === null) showToast('Could not load more tokens — try again.', 'error')
    notify(view)
  })
}

/** Create credentials and show both the token and invite before refreshing the inventory. */
export const createServerAccessToken = (
  server: ServerConnection,
  label: string,
  scope: AccessTokenScope,
  onChange: () => void,
): void => {
  const { inventory, view } = viewOf(server)
  if (view.creating) return
  view.onChange = onChange
  view.creating = true
  delete view.createError
  notify(view)
  void createAccessToken(server, label, scope).then(async (result) => {
    if (!isCurrentInventory(inventory)) return
    view.creating = false
    if (!result.ok) {
      view.createError = result.message
      notify(view)
      return
    }
    view.created += 1
    notify(view)
    await showOneTimeSecret(
      label,
      result.token,
      `https://wplace.live/#${encodeInvite(server.url, result.token)}`,
      scope === 'event_runner',
    )
    if (!isCurrentInventory(inventory)) return
    reloadAccessTokens(server, onChange, true)
  })
}

export const revokeServerAccessToken = (
  server: ServerConnection,
  tokenHash: string,
  label: string,
  onChange: () => void,
): void => {
  const { inventory, view } = viewOf(server)
  if (view.revoking.has(tokenHash)) return
  void (async () => {
    const sure = await requestConfirmation({
      title: 'Delete this token?',
      body: `${label} will stop working immediately.`,
      note: 'Anyone using it will lose access to this server. This cannot be undone.',
      confirmLabel: 'Delete',
    })
    if (!sure || !isCurrentInventory(inventory)) return
    view.onChange = onChange
    view.revoking.add(tokenHash)
    notify(view)
    const result = await revokeAccessToken(server, tokenHash)
    if (!isCurrentInventory(inventory)) return
    view.revoking.delete(tokenHash)
    if (!result.ok) showToast(result.message, 'error')
    reloadAccessTokens(server, onChange, true)
  })()
}
