import type {
  TemplateTreeIntent,
  TemplateTreeModel,
  TreeContextMenuItemModel,
  TreeContextMenuModel,
  TreeIcon,
  TreeOperationModel,
} from '@caelestis/ui/elements'

/**
 * What the tree shows on top of its rows: one context menu and one operation dialog at a time.
 * Workflows open them; the panel reads them into the tree model and routes their intents back.
 */

export type MenuEntry = {
  readonly icon: TreeIcon
  readonly label: string
  readonly run: () => void
  readonly returnToCanvas?: true
  readonly danger?: true
  readonly checked?: boolean
  readonly children?: readonly MenuEntry[]
}

/**
 * The one group order every row's menu follows, so the eye learns where a verb lives. A group
 * with nothing to show for this row simply disappears along with its separator.
 */
const MENU_GROUPS = [
  'navigate',
  'work',
  'organise',
  'publish',
  'state',
  'artwork',
  'edit',
  'danger',
] as const
type MenuGroup = (typeof MENU_GROUPS)[number]
export type MenuGroups = Partial<Record<MenuGroup, ReadonlyArray<MenuEntry | null>>>

type ContextAction = { readonly id: string; readonly run: () => void }
type OperationHandlers = {
  readonly onConfirm?: (value: string) => void
  /** `reason` is set when the tree itself is going away, rather than the person cancelling. */
  readonly onCancel?: (reason?: Error) => void
}
type OperationState = OperationHandlers & {
  model: TreeOperationModel
  readonly rerender: () => void
}

/** How many folders a destination picker lists before it says how many it left out. */
export const MAX_DESTINATIONS = 2_000

let contextMenu: TreeContextMenuModel | undefined
let contextActions: readonly ContextAction[] = []
let contextRerender: (() => void) | undefined
let operation: OperationState | undefined
let presentationId = 0

export const treeActionPresentation = (): Pick<TemplateTreeModel, 'contextMenu' | 'operation'> => ({
  ...(contextMenu === undefined ? {} : { contextMenu }),
  ...(operation === undefined ? {} : { operation: operation.model }),
})

const closeContextMenu = (rerender = true): void => {
  const changed = contextMenu !== undefined
  const refresh = contextRerender
  contextMenu = undefined
  contextActions = []
  contextRerender = undefined
  if (changed && rerender) refresh?.()
}

/** Replace any open menu with `groups` for the row `rowKey`, at the pointer. */
export const showContextMenu = (
  menu: { readonly rowKey: string; readonly x: number; readonly y: number },
  groups: MenuGroups,
  rerender: () => void,
): void => {
  closeContextMenu(false)
  const id = `tree-menu-${++presentationId}`
  const actions: ContextAction[] = []
  let itemCount = 0
  const toItem = (entry: MenuEntry, group: MenuGroup): TreeContextMenuItemModel => {
    const itemId = `${id}-${itemCount++}`
    if (entry.children === undefined) actions.push({ id: itemId, run: entry.run })
    return {
      id: itemId,
      label: entry.label,
      icon: entry.icon,
      group,
      ...(entry.returnToCanvas === true ? { returnToCanvas: true } : {}),
      ...(entry.danger === true ? { danger: true } : {}),
      ...(entry.checked === undefined ? {} : { checked: entry.checked }),
      ...(entry.children === undefined
        ? {}
        : { children: entry.children.map((child) => toItem(child, group)) }),
    }
  }
  contextMenu = {
    id,
    ...menu,
    items: MENU_GROUPS.flatMap((group) =>
      (groups[group] ?? []).flatMap((entry) => (entry === null ? [] : [toItem(entry, group)])),
    ),
  }
  contextActions = actions
  contextRerender = rerender
  rerender()
}

/** Open an operation dialog in place of any other, which is cancelled. Returns its id. */
export const showOperation = (
  model: Omit<TreeOperationModel, 'id'>,
  rerender: () => void,
  handlers: OperationHandlers = {},
): string => {
  operation?.onCancel?.()
  const id = `tree-operation-${++presentationId}`
  operation = { model: { ...model, id }, rerender, ...handlers }
  rerender()
  return id
}

/** Whether `id` is still the open operation: closing the panel or opening another revokes it. */
export const isOperationOpen = (id: string): boolean => operation?.model.id === id

export const updateOperation = (id: string, patch: Partial<TreeOperationModel>): void => {
  if (operation?.model.id !== id) return
  operation.model = { ...operation.model, ...patch, id }
  operation.rerender()
}

export const closeOperation = (id: string, rerender = true): void => {
  if (operation?.model.id !== id) return
  const refresh = operation.rerender
  operation = undefined
  if (rerender) refresh()
}

export const handleTreeActionPresentationIntent = (intent: TemplateTreeIntent): boolean => {
  if (intent.type === 'dismiss-context-menu') {
    if (contextMenu?.id === intent.menuId) closeContextMenu()
    return true
  }
  if (intent.type === 'context-menu-action') {
    if (contextMenu?.id !== intent.menuId) return true
    const action = contextActions.find((candidate) => candidate.id === intent.actionId)
    closeContextMenu()
    action?.run()
    return true
  }
  if (intent.type === 'tree-operation-cancel') {
    if (operation?.model.id !== intent.operationId) return true
    const current = operation
    operation = undefined
    current.onCancel?.()
    current.rerender()
    return true
  }
  if (intent.type === 'tree-operation-confirm') {
    if (operation?.model.id !== intent.operationId || operation.model.pending === true) return true
    operation.onConfirm?.(intent.value)
    return true
  }
  return false
}

/** Drop the menu and cancel the open operation with `reason`, because the tree is going away. */
export const cancelTreeActionSetup = (reason: Error): void => {
  operation?.onCancel?.(reason)
  operation = undefined
  closeContextMenu(false)
}
