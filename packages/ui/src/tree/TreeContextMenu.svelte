<script lang="ts">
  import { onDestroy, tick } from 'svelte'
  import Icon from '../foundations/Icon.svelte'
  import { cancelSurfaceClose, closeSurface, openSurface } from '../foundations/motion.js'
  import { type Anchor, anchorPopover, pointAnchor } from '../foundations/popover.js'
  import type { TemplateTreeIntent, TreeContextMenuItemModel, TreeContextMenuModel } from './model.js'

  /**
   * A row's actions at the pointer, with submenus. It takes focus when it opens and returns it to
   * whatever had it when it closes, unless focus has moved on; a press outside it asks the host to
   * dismiss it.
   */
  let { menu, emit }: { menu: TreeContextMenuModel | undefined; emit: (intent: TemplateTreeIntent) => void } = $props()

  let element = $state<HTMLElement>()
  let openSubmenuId = $state<string>()

  /**
   * The menu keeps its last model while the exit transition runs, so the `{#if}` does not
   * unmount it mid-close. `closeSurface` owns the timing and clears the held model when it ends.
   */
  let closingMenu = $state<TreeContextMenuModel>()
  let lastMenu: TreeContextMenuModel | undefined
  const shownMenu = $derived(menu ?? closingMenu)

  $effect(() => {
    if (menu !== undefined) {
      lastMenu = menu
      closingMenu = menu
      if (element !== undefined) openSurface(element)
      return
    }
    // Consume the last model so the effect cannot start the same close twice.
    if (lastMenu !== undefined && element?.isConnected === true) {
      closingMenu = lastMenu
      lastMenu = undefined
      closeSurface(element, () => { closingMenu = undefined })
    }
  })
  onDestroy(() => {
    if (element !== undefined) cancelSurfaceClose(element)
  })

  /** The focused element, looking through open shadow roots. */
  const activeElement = (): HTMLElement | null => {
    let active = document.activeElement
    while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement
    return active instanceof HTMLElement ? active : null
  }

  let admittedId: string | undefined
  let invoker: HTMLElement | null = null
  $effect(() => {
    const next = menu?.id
    if (next === admittedId) return
    const previous = admittedId
    admittedId = next
    openSubmenuId = undefined
    if (next !== undefined) {
      invoker = activeElement()
      void tick().then(() => {
        const opened = element
        if (menu?.id !== next || opened?.isConnected !== true) return
        // A hidden, still-opening menu cannot take focus. Focus already inside it (an open submenu) stays.
        openSurface(opened, () => {
          if (menu?.id === next && !opened.contains(activeElement())) opened.querySelector<HTMLButtonElement>('button')?.focus()
        })
      })
    } else if (previous !== undefined) {
      const target = invoker
      invoker = null
      // Focus that already moved on, such as a press elsewhere or a rename field, stays put.
      const active = activeElement()
      if (active === null || active === document.body || element?.contains(active) === true) target?.focus()
    }
  })

  /**
   * Hand focus back before the host runs the action, so whatever the action opens (a rename field,
   * a dialog) starts from the row that opened the menu.
   */
  const choose = (menuId: string, item: TreeContextMenuItemModel): void => {
    invoker?.focus()
    emit({ type: 'context-menu-action', menuId, actionId: item.id, returnToCanvas: item.returnToCanvas === true })
  }

  const dismiss = (event: PointerEvent): void => {
    if (menu === undefined || (element !== undefined && event.composedPath().includes(element))) return
    emit({ type: 'dismiss-context-menu', menuId: menu.id })
  }

  /** The rows of one menu level, leaving an open submenu's rows to their own list. */
  const menuRows = (level: Element): HTMLButtonElement[] =>
    Array.from(level.querySelectorAll<HTMLButtonElement>('button')).filter((button) => button.closest('[role="menu"]') === level)

  const openSubmenu = async (id: string, focusFirst: boolean): Promise<void> => {
    openSubmenuId = id
    if (!focusFirst) return
    await tick()
    element?.querySelector<HTMLButtonElement>(`[data-submenu="${id}"] [role="menu"] button`)?.focus()
  }

  const closeSubmenu = (restoreFocus: boolean): void => {
    const id = openSubmenuId
    openSubmenuId = undefined
    if (restoreFocus && id !== undefined) element?.querySelector<HTMLButtonElement>(`[data-submenu="${id}"] > button`)?.focus()
  }

  /** Mouse hover opens a submenu and closes any sibling's; touch and pen wait for the tap. */
  const hoverRow = (event: PointerEvent, item: TreeContextMenuItemModel): void => {
    if (event.pointerType !== 'mouse') return
    if (item.children === undefined) openSubmenuId = undefined
    else void openSubmenu(item.id, false)
  }

  const toggleSubmenu = (id: string): void => {
    if (openSubmenuId === id) closeSubmenu(true)
    else void openSubmenu(id, true)
  }

  const navigate = (event: KeyboardEvent): void => {
    const target = event.target instanceof HTMLElement ? event.target : null
    const level = target?.closest('[role="menu"]')
    if (target === null || !level) return
    if (openSubmenuId !== undefined && (event.key === 'ArrowLeft' || event.key === 'Escape')) {
      event.preventDefault()
      event.stopPropagation()
      closeSubmenu(true)
      return
    }
    const submenu = target.parentElement?.dataset.submenu
    if (level === element && event.key === 'ArrowRight' && submenu !== undefined) {
      event.preventDefault()
      void openSubmenu(submenu, true)
      return
    }
    const buttons = menuRows(level)
    const current = buttons.indexOf(target as HTMLButtonElement)
    let index: number
    if (event.key === 'ArrowDown') index = (current + 1) % buttons.length
    else if (event.key === 'ArrowUp') index = (current - 1 + buttons.length) % buttons.length
    else if (event.key === 'Home') index = 0
    else if (event.key === 'End') index = buttons.length - 1
    else return
    event.preventDefault()
    buttons[index]?.focus()
  }

  /**
   * Show the mounted menu in the top layer, which keeps viewport coordinates through animated,
   * clipping panel ancestors, and keep it placed against its anchor.
   */
  const float = (node: HTMLElement, anchor: () => Anchor): { update: (next: () => Anchor) => void; destroy: () => void } => {
    node.showPopover()
    let current = anchor
    const placement = anchorPopover(node, { anchor: () => current() })
    return {
      update(next) {
        current = next
        placement.place()
      },
      destroy: placement.stop,
    }
  }

  /** A submenu sits beside its trigger, its first row level with the trigger past the menu's padding. */
  const MENU_PADDING = 4
  const floatSubmenu = (node: HTMLElement): { destroy: () => void } | undefined => {
    const trigger = node.parentElement?.querySelector('button')
    if (!trigger) return
    node.showPopover()
    const placement = anchorPopover(node, {
      side: 'beside',
      anchor: () => {
        const { left, right, top, bottom } = trigger.getBoundingClientRect()
        return { left, right, top: top - MENU_PADDING, bottom }
      },
    })
    return { destroy: placement.stop }
  }
</script>

<svelte:window onpointerdown={dismiss} />

{#if shownMenu !== undefined}
  <div
    bind:this={element}
    popover="manual"
    data-caelestis-context-menu
    data-surface
    class="context-menu caelestis-menu caelestis-dropdown"
    role="menu"
    tabindex="-1"
    onkeydown={navigate}
    use:float={() => pointAnchor(shownMenu.x, shownMenu.y)}
  >
    {#each shownMenu.items as item, index (item.id)}
      {#if index > 0 && item.group !== shownMenu.items[index - 1]?.group}
        <div class="caelestis-menu-separator" role="separator"></div>
      {/if}
      {#if item.children === undefined}
        {@render row(item, shownMenu.id, true)}
      {:else}
        <div class="submenu-host" data-submenu={item.id}>
          <button class="caelestis-menu-item" type="button" role="menuitem" aria-haspopup="menu" aria-expanded={openSubmenuId === item.id} onclick={() => toggleSubmenu(item.id)} onpointerenter={(event) => hoverRow(event, item)}>
            <Icon name={item.icon} />
            <span>{item.label}</span>
            <Icon name="chevronRight" class="menu-trailing" />
          </button>
          {#if openSubmenuId === item.id}
            <div class="submenu caelestis-menu" popover="manual" role="menu" aria-label={item.label} tabindex="-1" use:floatSubmenu>
              {#each item.children as child (child.id)}
                {@render row(child, shownMenu.id, false)}
              {/each}
            </div>
          {/if}
        </div>
      {/if}
    {/each}
  </div>
{/if}

{#snippet row(item: TreeContextMenuItemModel, menuId: string, topLevel: boolean)}
  <button class="caelestis-menu-item" class:danger={item.danger === true} type="button" role={item.checked === undefined ? 'menuitem' : 'menuitemcheckbox'} aria-checked={item.checked} onclick={() => choose(menuId, item)} onpointerenter={topLevel ? (event) => hoverRow(event, item) : undefined}>
    <Icon name={item.icon} />
    <span>{item.label}</span>
    {#if item.checked === true}<Icon name="check" class="menu-trailing" />{/if}
  </button>
{/snippet}

<style>
  /* 12.5rem seats every current label on one line at 14px; wrapping stays as the fallback for long translations. */
  .context-menu { inline-size: 12.5rem; }
  .context-menu button { inline-size: 100%; }
  .context-menu button.danger { color: var(--caelestis-danger); }
  .context-menu :global(.menu-trailing) { margin-inline-start: auto; opacity: 0.7; }
  .submenu-host { display: flex; flex: 0 0 auto; flex-direction: column; }
  .submenu { position: fixed; inset: auto; margin: 0; z-index: 61; display: flex; min-inline-size: 8rem; max-inline-size: calc(100vw - 1rem); flex-direction: column; }
</style>
