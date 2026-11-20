import type { CaelestisElement, CaelestisIntent, CaelestisTag } from '@caelestis/ui/elements'
import { deepActiveElement } from './focus.js'
import { applyWplaceTheme } from './theme.js'

/** Elements built on ui's Modal: an `open` model field, and a `closed` intent once the exit ends. */
export type ModalTag = {
  [Tag in CaelestisTag]: CaelestisElement<Tag> extends { model: { readonly open: boolean } }
    ? 'closed' extends CaelestisIntent<Tag>['type']
      ? Tag
      : never
    : never
}[CaelestisTag]

type ModalModel<Tag extends ModalTag> = CaelestisElement<Tag>['model']
type HostIntent<Tag extends ModalTag> = Exclude<
  CaelestisIntent<Tag>,
  { readonly type: 'close' } | { readonly type: 'closed' }
>

export interface ModalHost<Tag extends ModalTag> {
  /** The model as last sent to the element. */
  readonly model: ModalModel<Tag>
  /** True from `close()` on; updates and intents are ignored from then. */
  readonly closed: boolean
  update(patch: Partial<ModalModel<Tag>>): void
  /** Start the exit. The element removes itself and returns focus once the exit ends. */
  close(): void
}

/** The close of the open dialog per tag, so opening another replaces it. */
const openHosts = new Map<ModalTag, () => void>()

/**
 * Mount a ui Modal element and own its lifecycle: one open dialog per tag, `open: true` on the
 * model, `close()` on the close intent, and on `closed` removal plus focus back to what had it at
 * open. The host keeps only its own intents.
 */
export const openModalHost = <Tag extends ModalTag>(
  tag: Tag,
  initial: Omit<ModalModel<Tag>, 'open'>,
  handlers: {
    readonly onIntent: (intent: HostIntent<Tag>) => void
    /** Runs once as the exit starts: stop work that would update the dialog. */
    readonly onClose?: () => void
    /** Runs once the element is gone. */
    readonly onClosed?: () => void
  },
): ModalHost<Tag> => {
  openHosts.get(tag)?.()
  // Looks through open shadow roots, so a row inside the panel counts.
  const restoreFocus = deepActiveElement()
  const element = document.createElement(tag)
  // TypeScript cannot rebuild a generic model from `Omit` plus the omitted field.
  let model = { ...initial, open: true } as ModalModel<Tag>
  let closed = false
  const update = (patch: Partial<ModalModel<Tag>>): void => {
    if (closed) return
    model = { ...model, ...patch }
    element.model = model
  }
  const close = (): void => {
    if (closed) return
    // `update` ignores patches once closed, so the dialog hears `open: false` first.
    update({ open: false } as Partial<ModalModel<Tag>>)
    closed = true
    if (openHosts.get(tag) === close) openHosts.delete(tag)
    handlers.onClose?.()
  }
  openHosts.set(tag, close)
  element.model = model
  applyWplaceTheme(element)
  element.addEventListener(`${tag}-intent`, (event) => {
    const intent = (event as CustomEvent<CaelestisIntent<Tag>>).detail
    if (intent.type === 'closed') {
      element.remove()
      handlers.onClosed?.()
      if (restoreFocus?.isConnected) restoreFocus.focus()
      return
    }
    if (closed) return
    if (intent.type === 'close') close()
    else handlers.onIntent(intent as HostIntent<Tag>)
  })
  document.body.appendChild(element)
  return {
    get model() {
      return model
    },
    get closed() {
      return closed
    },
    update,
    close,
  }
}
