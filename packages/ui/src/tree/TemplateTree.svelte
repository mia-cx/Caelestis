<script lang="ts">
  import MenuStyles from '../foundations/MenuStyles.svelte'
  import { formatCount, formatPixels, type Progress } from '@caelestis/shared'
  import Button from '../foundations/Button.svelte'
  import TemplatePreview from './TemplatePreview.svelte'
  import Favourites from './Favourites.svelte'
  import ProgressDetails from './ProgressDetails.svelte'
  import TreeContextMenu from './TreeContextMenu.svelte'
  import TreeOperation from './TreeOperation.svelte'
  import TreeToolbar from './TreeToolbar.svelte'
  import Icon from '../foundations/Icon.svelte'
  import TemplateAlarm from '../template-state/TemplateAlarm.svelte'
  import TemplateLifecycle from '../template-state/TemplateLifecycle.svelte'
  import ColourProgress from '../progress/ColourProgress.svelte'
  import ProgressMeter, { wholePercent } from '../progress/ProgressMeter.svelte'
  import { onDestroy, tick } from 'svelte'
  import { SvelteMap } from 'svelte/reactivity'
  import { slide, type EasingFunction, type TransitionConfig } from 'svelte/transition'
  import { cancelSurfaceClose, closeSurface, openSurface, tokenized } from '../foundations/motion.js'
  import { TreeMotion } from './tree-motion.svelte.js'
  import type { TemplateTreeIntent, TemplateTreeModel, TreeActionModel, TreeRowModel } from './model.js'

  /**
   * The template browser: toolbar, operation banner, context menu, and the rows or grid cards
   * with their focus, keyboard, drag-and-drop, and progress disclosures.
   */
  let { model, toolbar = true, onIntent }: { model: TemplateTreeModel; toolbar?: boolean; onIntent?: (intent: TemplateTreeIntent) => void } = $props()
  let activeKey = $state<string | null>(null)
  let renameDraft = $state('')
  let draggingKey = $state<string | null>(null)
  let dropTarget = $state<{ key: string; position: 'before' | 'inside' | 'after' } | null>(null)
  let treeElement = $state<HTMLElement>()
  let scroller = $state<HTMLElement>()
  let progressKey = $state<string | null>(null)
  let progressPane = $state<HTMLElement>()
  let browserWidth = $state(0)
  const disclosures = new SvelteMap<string, 'expanded' | 'colours'>()
  let admittedRenameKey: string | undefined
  const grid = $derived(model.displayMode === 'grid')
  const motion = new TreeMotion(() => model.entries, () => treeElement, () => grid)
  /** Each row's ARIA place among the rows that share its parent. */
  const setPositions = $derived.by(() => {
    const siblings = new Map<string | null, string[]>()
    for (const entry of model.entries) {
      if (entry.type !== 'row') continue
      const keys = siblings.get(entry.parentKey)
      if (keys === undefined) siblings.set(entry.parentKey, [entry.key])
      else keys.push(entry.key)
    }
    return new Map([...siblings.values()].flatMap((keys) => keys.map((key, index) => [key, { size: keys.length, position: index + 1 }] as const)))
  })
  /** Tree mode leads a row's actions with its fly-to; grid shows that on the heading and the artwork. */
  const rowActions = (row: TreeRowModel): readonly TreeActionModel[] =>
    grid || row.navigate === undefined ? (row.actions ?? []) : [row.navigate, ...(row.actions ?? [])]
  const progressEntry = $derived(model.entries.find((entry): entry is TreeRowModel => entry.type === 'row' && entry.key === progressKey && entry.progress !== undefined))

  const toggleExpanded = (key: string): void => {
    motion.toggle(key)
    emit({ type: 'toggle-expanded', key })
  }

  /** Height plus opacity, merged so `slide`'s height choreography keeps its shape. */
  const slideFade = (
    node: Element,
    params?: { duration?: number; easing?: EasingFunction },
  ): TransitionConfig => {
    const base = slide(node, params)
    return { ...base, css: (t, u) => `${base.css?.(t, u) ?? ''} opacity: ${t};` }
  }
  const disclose = tokenized(slideFade, '--caelestis-duration-fast')

  /**
   * The grid progress pane keeps its last row while the exit transition runs, so the `{#if}` does
   * not unmount it mid-close. `closeSurface` owns the timing and clears the held row when it ends.
   */
  let closingProgress = $state<TreeRowModel>()
  let lastProgressEntry: TreeRowModel | undefined
  const shownProgress = $derived(progressEntry ?? closingProgress)

  $effect(() => {
    if (progressEntry !== undefined) {
      lastProgressEntry = progressEntry
      closingProgress = progressEntry
      if (progressPane !== undefined) openSurface(progressPane)
      return
    }
    if (lastProgressEntry !== undefined && progressPane?.isConnected === true) {
      closingProgress = lastProgressEntry
      lastProgressEntry = undefined
      closeSurface(progressPane, () => { closingProgress = undefined })
    }
  })
  onDestroy(() => {
    if (progressPane !== undefined) cancelSurfaceClose(progressPane)
  })
  const minimumSplitWidth = 672
  const narrowDetails = $derived(browserWidth < minimumSplitWidth)
  $effect(() => { if (!grid || progressEntry === undefined) progressKey = null })

  const showProgress = async (entry: TreeRowModel): Promise<void> => {
    progressKey = entry.key
    await tick()
    const pane = progressPane
    if (pane !== undefined) openSurface(pane, () => pane.querySelector<HTMLButtonElement>('button')?.focus())
  }
  const closeProgress = (): void => {
    const entry = progressEntry
    progressKey = null
    if (entry !== undefined) void focusRowAction(entry.key, 'view-progress')
  }
  const folderPaths = $derived.by(() => {
    const paths = new Map<string, string>()
    for (const entry of model.entries) {
      if (entry.type !== 'row' || !entry.container) continue
      const parent = entry.parentKey === null ? undefined : paths.get(entry.parentKey)
      paths.set(entry.key, entry.parentKey === null ? '' : parent ? `${parent} / ${entry.name}` : entry.name)
    }
    return paths
  })

  $effect(() => {
    if (model.renamingKey === admittedRenameKey) return
    admittedRenameKey = model.renamingKey
    const row = model.entries.find((entry): entry is TreeRowModel => entry.type === 'row' && entry.key === model.renamingKey)
    if (row !== undefined) renameDraft = row.name
  })

  const emit = (intent: TemplateTreeIntent): void => onIntent?.(intent)
  const percent = (progress: Progress): number => wholePercent(progress.completed, progress.total)
  const scannedPercent = (progress: Progress): number => wholePercent(progress.known, progress.total)
  const branchIndent = 18
  const leafHeadingIndent = 20

  type RowAction = 'view-progress' | 'expand-progress' | 'collapse-progress' | 'colour-progress'
  const focusRowAction = async (key: string, action: RowAction): Promise<void> => {
    await tick()
    treeElement?.querySelector<HTMLButtonElement>(`[data-caelestis-tree-key="${CSS.escape(key)}"] [data-action="${action}"]`)?.focus()
  }

  const runAction = (key: string, item: Pick<TreeActionModel, 'id' | 'returnToCanvas'>): void =>
    emit({ type: 'action', key, actionId: item.id, returnToCanvas: item.returnToCanvas === true })
  const action = (row: TreeRowModel, item: TreeActionModel, event: MouseEvent): void => {
    event.stopPropagation()
    runAction(row.key, item)
  }

  const clickRow = (event: MouseEvent, row: TreeRowModel): void => {
    if (event.target instanceof Element && event.target.closest('.visibility') !== null) return
    if (isLongPressEvent(event)) { event.preventDefault(); return }
    activeKey = row.key
    if (row.container && !row.forceExpanded) toggleExpanded(row.key)
  }

  /**
   * Press-and-hold on touch opens the same menu a right-click does. iOS never fires `contextmenu`
   * for a touch, Android does after its own delay, so the timer owns the gesture and the click and
   * `contextmenu` that trail a finished hold are swallowed instead of reopening or acting on the row.
   */
  const LONG_PRESS_MS = 450
  const LONG_PRESS_SLOP = 10
  let longPress: { timer: ReturnType<typeof setTimeout>; x: number; y: number; pointerId: number } | null = null
  let completedLongPressPointerId: number | undefined
  let touchPointerActive = false

  /** Native click and contextmenu events retain the pointer ID of their originating gesture. */
  const isLongPressEvent = (event: MouseEvent): boolean =>
    event instanceof PointerEvent && event.pointerId === completedLongPressPointerId

  const cancelLongPress = (): void => {
    if (longPress !== null) clearTimeout(longPress.timer)
    longPress = null
  }

  const pressRow = (event: PointerEvent, row: TreeRowModel): void => {
    if (event.pointerId === completedLongPressPointerId) completedLongPressPointerId = undefined
    touchPointerActive = event.pointerType === 'touch'
    if (!touchPointerActive || !row.contextMenu || !event.isPrimary) return
    if (event.target instanceof Element && event.target.closest('button, input, label, a') !== null) return
    cancelLongPress()
    const { clientX: x, clientY: y, pointerId } = event
    const element = event.currentTarget as HTMLElement
    longPress = {
      x,
      y,
      pointerId,
      timer: setTimeout(() => {
        longPress = null
        completedLongPressPointerId = pointerId
        element.focus()
        emit({ type: 'context-menu', key: row.key, x, y })
      }, LONG_PRESS_MS),
    }
  }

  const moveRowPointer = (event: PointerEvent): void => {
    if (longPress === null || longPress.pointerId !== event.pointerId) return
    if (Math.hypot(event.clientX - longPress.x, event.clientY - longPress.y) > LONG_PRESS_SLOP) cancelLongPress()
  }

  const releaseRow = (): void => {
    cancelLongPress()
    touchPointerActive = false
  }

  const contextMenuRow = (event: MouseEvent, row: TreeRowModel): void => {
    if (!row.contextMenu) return
    event.preventDefault()
    cancelLongPress()
    if (isLongPressEvent(event)) return
    event.currentTarget instanceof HTMLElement && event.currentTarget.focus()
    emit({ type: 'context-menu', key: row.key, x: event.clientX, y: event.clientY })
  }

  const keydown = (event: KeyboardEvent, row: TreeRowModel): void => {
    if (event.target !== event.currentTarget) return
    const rows = model.entries.filter((entry): entry is TreeRowModel => entry.type === 'row')
    const index = rows.findIndex((entry) => entry.key === row.key)
    if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
      if (!row.draggable) return
      const siblings = rows.filter((entry) => entry.parentKey === row.parentKey && entry.draggable)
      const siblingIndex = siblings.findIndex((entry) => entry.key === row.key)
      const target =
        event.key === 'ArrowUp' ? siblings[siblingIndex - 1] : siblings[siblingIndex + 1]
      if (target === undefined) return
      event.preventDefault()
      emit({
        type: 'drop',
        draggedKey: row.key,
        targetKey: target.key,
        position: event.key === 'ArrowUp' ? 'before' : 'after',
      })
      return
    }
    let next: TreeRowModel | undefined
    if (event.key === 'ArrowDown' || (grid && !row.container && event.key === 'ArrowRight')) next = rows[index + 1]
    else if (event.key === 'ArrowUp' || (grid && !row.container && event.key === 'ArrowLeft')) next = rows[index - 1]
    else if (event.key === 'Home') next = rows[0]
    else if (event.key === 'End') next = rows.at(-1)
    else if (event.key === 'ArrowRight' && row.container && !row.expanded) {
      event.preventDefault(); toggleExpanded(row.key); return
    } else if (event.key === 'ArrowLeft' && row.container && row.expanded && !row.forceExpanded) {
      event.preventDefault(); toggleExpanded(row.key); return
    }
    if (next === undefined) return
    event.preventDefault()
    activeKey = next.key
    treeElement?.querySelector<HTMLElement>(`[data-caelestis-tree-key="${CSS.escape(next.key)}"]`)?.focus()
  }

  const startDrag = (event: DragEvent, row: TreeRowModel): void => {
    // A touch drag begins with the same hold that opens the menu; the menu wins on touch.
    if (touchPointerActive) { event.preventDefault(); return }
    draggingKey = row.key
    emit({ type: 'drag-state', active: true })
    event.dataTransfer?.setData('text/plain', row.key)
  }

  const dragOver = (event: DragEvent, row: TreeRowModel): void => {
    if (draggingKey === null || draggingKey === row.key) return
    event.preventDefault()
    const box = event.currentTarget instanceof HTMLElement ? event.currentTarget.getBoundingClientRect() : null
    const ratio = box === null || box.height <= 0 ? 0.5 : (event.clientY - box.top) / box.height
    const dragged = model.entries.find((entry): entry is TreeRowModel => entry.type === 'row' && entry.key === draggingKey)
    // Dropping inside a folder files the row there, which needs both rows to allow reparenting
    // unless the folder already is the row's parent.
    const accepts = row.container && (dragged?.parentKey === row.key || (row.canReparent === true && dragged?.canReparent === true))
    const position = accepts && ratio >= 0.3 && ratio <= 0.7 ? 'inside' : ratio < 0.5 ? 'before' : 'after'
    dropTarget = { key: row.key, position }
  }

  const drop = (event: DragEvent): void => {
    event.preventDefault()
    if (draggingKey !== null && dropTarget !== null) {
      emit({ type: 'drop', draggedKey: draggingKey, targetKey: dropTarget.key, position: dropTarget.position })
    }
    draggingKey = null
    dropTarget = null
    emit({ type: 'drag-state', active: false })
  }

  const endDrag = (): void => {
    draggingKey = null
    dropTarget = null
    emit({ type: 'drag-state', active: false })
  }

  const dismissTransient = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape') return
    if (model.contextMenu !== undefined) {
      event.preventDefault()
      emit({ type: 'dismiss-context-menu', menuId: model.contextMenu.id })
    } else if (model.operation !== undefined && model.operation.cancellable !== false) {
      event.preventDefault()
      emit({ type: 'tree-operation-cancel', operationId: model.operation.id })
    } else if (progressKey !== null) {
      event.preventDefault()
      closeProgress()
    }
  }

  const commitRename = (row: TreeRowModel): void => {
    const name = renameDraft.trim()
    if (name !== '' && name !== row.name) emit({ type: 'rename', key: row.key, name })
    else emit({ type: 'cancel-rename', key: row.key })
  }

  const focusRename = (node: HTMLInputElement): void => {
    node.focus()
    node.select()
  }
</script>

<MenuStyles />

<svelte:window onkeydown={dismissTransient} />

{#if toolbar}<TreeToolbar {model} {emit} />{/if}

{#if model.operation !== undefined}<TreeOperation operation={model.operation} {emit} />{/if}

<TreeContextMenu menu={model.contextMenu} {emit} />

<div class="browser" bind:clientWidth={browserWidth}>
<div class="scroller" bind:this={scroller} inert={progressEntry !== undefined && narrowDetails}>
  <div bind:this={treeElement} class="tree" class:preview-grid={grid} role="tree" aria-label="Templates" tabindex="-1" ondrop={drop} ondragend={endDrag}>
    {#each motion.visibleEntries as entry (entry.key)}
      {#if entry.type === 'row'}
        {@const requestedDisclosure = disclosures.get(entry.key)}
        {@const canShowExpandedProgress = entry.progress !== undefined && (!entry.container || entry.expanded)}
        {@const disclosure = grid || !canShowExpandedProgress || requestedDisclosure === undefined ? undefined : requestedDisclosure === 'colours' && (entry.colourProgress?.length ?? 0) === 0 ? 'expanded' : requestedDisclosure}
        {@const tallHeading = entry.progress !== undefined || (entry.actions?.length ?? 0) > 0 || entry.navigate !== undefined}
        {@const place = setPositions.get(entry.key)}
        {@const actions = rowActions(entry)}
        {@const connectorWidth = entry.depth === 0 ? 0 : (entry.branches?.length ?? 0) * branchIndent + (entry.container ? 0 : leafHeadingIndent)}
        {@const progressDetailOffset = entry.container ? leafHeadingIndent : 0}
        {@const alarmKind = entry.descendantAlarmKind ?? entry.lifecycle?.alarmKind ?? (entry.lifecycle?.griefed ? 'sustained-griefing' : undefined)}
        {@const card = grid && !entry.container}
        {@const folderPath = entry.parentKey === null ? undefined : folderPaths.get(entry.parentKey)}
        <div
          class:preview-card={card}
          class:folder-heading={grid && entry.container}
          class:tall-heading={tallHeading}
          class:muted={entry.muted}
          class:focused-template={model.focusedKey === entry.key}
          class:regression-alarm={alarmKind === 'regression'}
          class:grief-alarm={alarmKind === 'sustained-griefing'}
          class:dragging={draggingKey === entry.key}
          class:drop-before={dropTarget?.key === entry.key && dropTarget.position === 'before'}
          class:drop-after={dropTarget?.key === entry.key && dropTarget.position === 'after'}
          class:drop-inside={dropTarget?.key === entry.key && dropTarget.position === 'inside'}
          class="row"
          role="treeitem"
          aria-selected="false"
          aria-current={model.focusedKey === entry.key ? 'true' : undefined}
          aria-level={entry.depth + 1}
          aria-expanded={entry.container ? entry.expanded : undefined}
          aria-setsize={place?.size}
          aria-posinset={place?.position}
          tabindex={activeKey === null ? (place?.position === 1 && entry.depth === 0 ? 0 : -1) : activeKey === entry.key ? 0 : -1}
          data-caelestis-tree-key={entry.key}
          draggable={entry.draggable === true}
          style:padding-inline-start={card || connectorWidth === 0 ? '0.5rem' : `calc(0.5rem + ${grid ? Math.min(entry.depth, 3) * branchIndent : connectorWidth}px)`}
          style:--progress-detail-offset={`${progressDetailOffset}px`}
          onclick={(event) => clickRow(event, entry)}
          onkeydown={(event) => keydown(event, entry)}
          oncontextmenu={(event) => contextMenuRow(event, entry)}
          onpointerdown={(event) => pressRow(event, entry)}
          onpointermove={moveRowPointer}
          onpointerup={releaseRow}
          onpointercancel={releaseRow}
          ondragstart={(event) => startDrag(event, entry)}
          ondragover={(event) => dragOver(event, entry)}
          class:leaving={motion.leaving.has(entry.key)}
          class:entering={motion.entering.has(entry.key)}
          inert={motion.leaving.has(entry.key)}
        >
          {#if card && entry.preview !== undefined}
            {@const navigate = entry.navigate}
            <button class="artwork" type="button" aria-label={`Go to ${entry.name}`} disabled={navigate === undefined} onclick={(event) => { if (navigate !== undefined) action(entry, navigate, event) }}>
              <TemplatePreview preview={entry.preview} name={entry.name} {scroller} />
            </button>
            <div class="card-caption">
              <span title={`${entry.preview.ownership}${folderPath ? ` / ${folderPath}` : ''}`}>{entry.preview.ownership}</span>
              <span>{entry.preview.width}×{entry.preview.height}</span>
            </div>
            {#if folderPath}<div class="folder-path" title={folderPath}>{folderPath}</div>{/if}
          {/if}
          {#if connectorWidth > 0 && !grid}
            {@const current = (entry.branches?.length ?? 1) - 1}
            <span class="connector" style:inline-size={`${connectorWidth}px`} aria-hidden="true">
              {#each entry.branches?.slice(0, -1) ?? [] as continued, index}
                {#if continued}<span class="connector-vertical" style:inset-inline-start={`${index * 18 + 9}px`}></span>{/if}
              {/each}
              <span class:continues={entry.branches?.[current] === true} class="connector-current" style:inset-inline-start={`${current * 18 + 9}px`}></span>
              <span class="connector-elbow" style:inset-inline-start={`${current * 18 + 9}px`}></span>
            </span>
          {/if}
          <div class="row-heading">
            {#if entry.container}<span class:open={entry.expanded} class="caret" aria-hidden="true"><Icon name="caret" size="0.75rem" /></span>{/if}
            <TemplateLifecycle finished={entry.lifecycle?.finished ?? false} frozen={entry.lifecycle?.frozen ?? false}>
              {#if entry.favourites !== undefined && (entry.favourites.people.length > 0 || entry.favourites.canAssign)}
                <Favourites name={entry.name} model={entry.favourites} onChange={(release, person) => emit({ type: 'favourite', key: entry.key, release, ...(person === undefined ? {} : { person }) })}>
                  <span class="kind"><Icon name={entry.icon} /></span>
                </Favourites>
              {:else}
              <span class="kind"><Icon name={entry.icon} /></span>
              {/if}
            </TemplateLifecycle>
            {#if alarmKind !== undefined}
              <TemplateAlarm compact {...(entry.descendantAlarmKind === undefined ? {} : { descendantAlarmKind: entry.descendantAlarmKind })} {...entry.lifecycle} />
            {/if}
            {#if grid && entry.navigate !== undefined}
              {@const navigate = entry.navigate}
              <button class="icon-action" type="button" title={navigate.label} aria-label={navigate.label} onclick={(event) => action(entry, navigate, event)}>
                <Icon name={navigate.icon} />
              </button>
            {/if}
            {#if model.renamingKey === entry.key}
              <input use:focusRename class="rename caelestis-field" aria-label={`Rename ${entry.name}`} bind:value={renameDraft} onkeydown={(event) => { event.stopPropagation(); if (event.key === 'Enter') commitRename(entry); if (event.key === 'Escape') { event.preventDefault(); emit({ type: 'cancel-rename', key: entry.key }) } }} />
            {:else}
              <span class="name" title={entry.name}>{entry.name}</span>
            {/if}
            {#if entry.meta !== undefined && !card}<span class="meta">{entry.meta}</span>{/if}
            {#if entry.progress !== undefined && disclosure === undefined && !card}
              <span class="row-tail">
                <span class="progress" aria-label={`${percent(entry.progress)}% complete`}>
                  <ProgressMeter progress={entry.progress} size="sm" />
                </span>
                <span class="actions">
                  {#each actions as item (item.id)}
                    <button class="icon-action" type="button" title={item.label} aria-label={item.label} onclick={(event) => action(entry, item, event)}>
                      <Icon name={item.icon} />
                    </button>
                  {/each}
                  <button class="icon-action" type="button" data-action={grid ? 'view-progress' : 'expand-progress'} title={grid ? `View progress for ${entry.name}` : 'Expand progress'} aria-label={grid ? `View progress for ${entry.name}` : 'Expand progress'} aria-expanded={grid ? progressKey === entry.key : undefined} onclick={(event) => { event.stopPropagation(); if (grid) { void showProgress(entry); return }; if (entry.container && !entry.expanded) toggleExpanded(entry.key); disclosures.set(entry.key, 'expanded'); void focusRowAction(entry.key, 'collapse-progress') }}>
                    <Icon name="expandMore" />
                  </button>
                </span>
              </span>
            {:else if actions.length > 0 || (entry.progress !== undefined && disclosure !== undefined) || card}
              <span class="actions">
                {#each actions as item (item.id)}
                  <button class="icon-action" type="button" title={item.label} aria-label={item.label} onclick={(event) => action(entry, item, event)}>
                    <Icon name={item.icon} />
                  </button>
                {/each}
                {#if entry.progress !== undefined && disclosure !== undefined}
                  <button class="icon-action" type="button" data-action="collapse-progress" title="Collapse progress" aria-label="Collapse progress" onclick={(event) => { event.stopPropagation(); disclosures.delete(entry.key); void focusRowAction(entry.key, 'expand-progress') }}>
                    <Icon name="expandLess" />
                  </button>
                {/if}
              </span>
            {/if}
            {#if grid && entry.contextMenu}
              <button class="icon-action" type="button" title={`Actions for ${entry.name}`} aria-label={`Actions for ${entry.name}`} aria-haspopup="menu" aria-expanded={model.contextMenu?.rowKey === entry.key} onclick={(event) => { event.stopPropagation(); const box = event.currentTarget.getBoundingClientRect(); emit({ type: 'context-menu', key: entry.key, x: box.left, y: box.bottom }) }}>
                <Icon name="kebab" />
              </button>
            {/if}
            <label class="visibility" title={entry.visible ? `Hide ${entry.name}` : `Show ${entry.name}`}>
              <input type="checkbox" checked={entry.visible} aria-label={`Show ${entry.name}`} onclick={(event) => event.stopPropagation()} onchange={(event) => emit({ type: 'toggle-visible', key: entry.key, visible: event.currentTarget.checked })} />
              <span aria-hidden="true"><Icon name={entry.visible ? 'eye' : 'eyeOff'} /></span>
            </label>
          </div>
          {#if card && entry.progress !== undefined}
            <button type="button" class="card-progress" data-action="view-progress" aria-label={`View progress for ${entry.name}`} title={`View progress for ${entry.name}`} aria-expanded={progressKey === entry.key} onclick={(event) => { event.stopPropagation(); void showProgress(entry) }}>
              <ProgressMeter progress={entry.progress} size="sm" /><Icon name="caret" size="0.875rem" />
            </button>
          {/if}
          {#if disclosure !== undefined && entry.progress !== undefined}
            <div class="progress-detail" transition:disclose|global>
              <div class="progress-disclosure">
                <div class="progress-summary">
                  <ProgressMeter progress={entry.progress} size="sm" />
                  <div class="progress-legend">
                    <span class="completed" title={`${formatPixels(entry.progress.completed)} completed`} aria-label={`${formatPixels(entry.progress.completed)} completed`}>{formatCount(entry.progress.completed)}</span>
                    <span class="mismatched" title={`${formatPixels(entry.progress.mismatched)} mismatched`} aria-label={`${formatPixels(entry.progress.mismatched)} mismatched`}>{formatCount(entry.progress.mismatched)}</span>
                    <span class="unpainted" title={`${formatPixels(entry.progress.unpainted)} unpainted`} aria-label={`${formatPixels(entry.progress.unpainted)} unpainted`}>{formatCount(entry.progress.unpainted)}</span>
                    {#if entry.progress.known < entry.progress.total}<span class="coverage">{scannedPercent(entry.progress)}% scanned</span>{/if}
                  </div>
                </div>
                {#if entry.colourProgress !== undefined}
                  <button class="icon-action progress-detail-action" type="button" data-action="colour-progress" title={disclosure === 'colours' ? 'Hide colour progress' : 'Show colour progress'} aria-label={disclosure === 'colours' ? 'Hide colour progress' : 'Show colour progress'} onclick={(event) => { event.stopPropagation(); disclosures.set(entry.key, disclosure === 'colours' ? 'expanded' : 'colours'); void focusRowAction(entry.key, 'colour-progress') }}>
                    <Icon name="palette" />
                  </button>
                {/if}
              </div>
              {#if disclosure === 'colours' && entry.colourProgress !== undefined}
                <ColourProgress colours={entry.colourProgress} />
              {/if}
            </div>
          {/if}
        </div>
      {:else if entry.type === 'notice'}
        <div class="notice" role="treeitem" aria-selected="false" aria-level={entry.depth + 1} aria-disabled="true" style:padding-inline-start={`${1.8 + entry.depth * 1.1}rem`}>
          <span>{entry.text}</span>
          {#if entry.action !== undefined}{@const notice = entry.action}<button type="button" onclick={() => runAction(entry.key, notice)}>{notice.label}</button>{/if}
        </div>
      {:else}
        <div class:compact={entry.variant === 'compact'} class:ghost={entry.variant === 'ghost'} class="standalone" role="treeitem" aria-selected="false" aria-level={entry.depth + 1}>
          <Button label={entry.action.label} title={entry.title} kind={entry.variant === 'ghost' ? 'ghost' : 'default'} size={entry.variant === 'compact' ? 'compact' : 'small'} onclick={() => runAction(entry.key, entry.action)}>
            {#if entry.action.icon !== undefined}<span class="standalone-icon"><Icon name={entry.action.icon} /></span>{/if}
            <span>{entry.action.label}</span>
          </Button>
        </div>
      {/if}
    {/each}
  </div>
</div>
{#if grid && shownProgress?.progress !== undefined}
  <div class="progress-pane" class:overlaid={narrowDetails} bind:this={progressPane}>
    <ProgressDetails name={shownProgress.name} progress={shownProgress.progress} colours={shownProgress.colourProgress} onClose={closeProgress} />
  </div>
{/if}
</div>

<style>
  .browser { position: relative; display: flex; flex: 1; min-block-size: 0; min-inline-size: 0; overflow: hidden; }
  .scroller { flex: 1; min-block-size: 0; min-inline-size: 0; overflow: auto; container-type: inline-size; }
  .progress-pane {
    --pane-open-dur: var(--caelestis-duration-fast);
    --pane-close-dur: var(--caelestis-duration-quick);
    --pane-shift: var(--caelestis-distance-medium);
    --pane-ease: var(--caelestis-ease-smooth-out);
    --caelestis-surface-close-duration: var(--pane-close-dur);
    flex: 0 0 20rem; min-block-size: 0; border-inline-start: 1px solid var(--caelestis-border); background: var(--caelestis-surface);
    transform: translateX(var(--pane-shift));
    opacity: 0;
    transition:
      transform var(--pane-open-dur) var(--pane-ease),
      opacity   var(--pane-open-dur) var(--pane-ease);
    will-change: transform, opacity;
  }
  .progress-pane:global([data-state='open']) { transform: translateX(0); opacity: 1; }
  .progress-pane:global([data-state='closing']) { transform: translateX(var(--pane-shift)); opacity: 0; pointer-events: none; transition-duration: var(--pane-close-dur); }
  @media (prefers-reduced-motion: reduce) {
    .progress-pane { transition: none !important; }
  }
  /* Entering rows start collapsed so the grow reads from the first painted frame. */
  @media (prefers-reduced-motion: no-preference) {
    .tree:not(.preview-grid) .row.entering { min-block-size: 0; block-size: 0; padding-block: 0; margin-block-start: calc(-1 * var(--tree-row-gap)); overflow: hidden; opacity: 0; }
  }
  .progress-pane.overlaid { position: absolute; inset: 0; z-index: 3; border-inline-start: 0; }
  .tree { --tree-row-gap: 0.125rem; display: flex; flex-direction: column; gap: var(--tree-row-gap); padding-block: 0.5rem; color: var(--caelestis-text); font: 400 0.875rem/1.25 var(--caelestis-font); }
  .row { --icon-swap-dur: var(--caelestis-duration-quick); --icon-swap-ease: var(--caelestis-ease-smooth-out); --icon-swap-blur: var(--caelestis-blur-small); position: relative; display: flex; flex-direction: column; justify-content: center; gap: 0.25rem; min-block-size: 2rem; margin-inline: 0.5rem; padding: 0.25rem 0.5rem; border-radius: var(--caelestis-radius); outline: none; }
  .row-heading { display: flex; flex-wrap: nowrap; align-items: center; gap: 0.25rem; min-inline-size: 0; white-space: nowrap; }
  .connector { position: absolute; inset-block: 0; inset-inline-start: 0.45rem; opacity: 0.28; pointer-events: none; }
  .connector-vertical, .connector-current { position: absolute; inset-block-start: 0; border-inline-start: 1px solid currentColor; }
  .connector-vertical, .connector-current.continues { inset-block-end: 0; }
  .connector-current:not(.continues) { block-size: 16px; }
  .connector-elbow { position: absolute; top: 16px; inset-inline-end: 4px; border-block-start: 1px solid currentColor; }
  .row.tall-heading .connector-current:not(.continues) { block-size: 20px; }
  .row.tall-heading .connector-elbow { top: 20px; }
  .row:hover, .row:focus-visible { background: var(--caelestis-raised-surface); }
  .row.focused-template { background: color-mix(in oklab, var(--caelestis-primary) 12%, transparent); }
  .row.focused-template::before { content: ''; position: absolute; inset-block: 0.25rem; inset-inline-start: 0; inline-size: 3px; border-radius: var(--caelestis-pill-radius); background: var(--caelestis-primary); }
  .row.regression-alarm { --row-alarm-color: oklch(from var(--caelestis-warning) l c 55); }
  .row.grief-alarm { --row-alarm-color: var(--caelestis-danger); }
  .row.regression-alarm, .row.grief-alarm { background: color-mix(in oklab, var(--row-alarm-color) 14%, transparent); box-shadow: inset 0 0 0 1px color-mix(in oklab, var(--row-alarm-color) 65%, transparent); }
  .row.regression-alarm:hover, .row.grief-alarm:hover { background: color-mix(in oklab, var(--row-alarm-color) 20%, transparent); }
  .row:focus-visible { outline: 2px solid var(--caelestis-focus); outline-offset: -2px; }
  .row.muted { opacity: 0.55; }
  .row.dragging { opacity: 0.25; }
  .row.drop-before { box-shadow: inset 0 2px var(--caelestis-primary); }
  .row.drop-after { box-shadow: inset 0 -2px var(--caelestis-primary); }
  .row.drop-inside { outline: 2px dashed var(--caelestis-primary); }
  .caret { display: grid; flex: 0 0 1rem; inline-size: 1rem; place-items: center; transition: transform var(--caelestis-duration-quick) var(--caelestis-ease-smooth-out); }
  .caret.open { transform: rotate(90deg); }
  .kind { display: inline-flex; flex: 0 0 auto; }
  .name { min-inline-size: 2rem; overflow: hidden; flex: 1; text-overflow: ellipsis; white-space: nowrap; }
  .rename { min-inline-size: 4rem; flex: 1; }
  .meta { color: var(--caelestis-muted-text); font-size: 0.75rem; }
  .actions { display: flex; align-items: center; margin-inline-start: auto; transition: opacity var(--icon-swap-dur) var(--icon-swap-ease), filter var(--icon-swap-dur) var(--icon-swap-ease); }
  .row-tail { display: grid; flex: 0 1 6.5rem; inline-size: 6.5rem; min-inline-size: min-content; align-items: center; }
  .row-tail > * { grid-area: 1 / 1; }
  .row-tail > .actions { justify-self: end; }
  .icon-action { display: grid; place-items: center; inline-size: 2rem; block-size: 2rem; min-inline-size: 2rem; min-block-size: 2rem; padding: 0; border: 0; border-radius: var(--caelestis-pill-radius); background: transparent; color: inherit; cursor: pointer; }
  .icon-action:hover { background: color-mix(in oklch, currentColor 8%, transparent); }
  .visibility { position: relative; display: grid; flex: 0 0 1.5rem; place-items: center; inline-size: 1.5rem; block-size: 1.5rem; cursor: pointer; }
  .visibility input { position: absolute; inline-size: 1px; block-size: 1px; opacity: 0; pointer-events: none; }
  .visibility > span { display: grid; place-items: center; inline-size: 1.5rem; block-size: 1.5rem; border: 1px solid color-mix(in oklab, currentColor 44%, transparent); border-radius: var(--caelestis-pill-radius); }
  .visibility :global(svg) { inline-size: 1rem; block-size: 1rem; fill: currentColor; }
  .visibility:focus-within { outline: 2px solid var(--caelestis-focus); border-radius: var(--caelestis-pill-radius); }
  .progress { inline-size: 100%; min-inline-size: 0; transition: opacity var(--icon-swap-dur) var(--icon-swap-ease), filter var(--icon-swap-dur) var(--icon-swap-ease); }
  .progress-detail { display: flex; min-inline-size: 0; flex-direction: column; gap: 0.25rem; padding: 0.2rem 0 0.35rem; padding-inline-start: var(--progress-detail-offset); color: var(--caelestis-muted-text); font-size: 0.68rem; }
  .progress-disclosure { position: relative; display: flex; min-inline-size: 0; padding-inline-end: 1.625rem; }
  .progress-summary { container-type: inline-size; display: flex; flex: 1; min-inline-size: 0; flex-direction: column; gap: 0.2rem; }
  .progress-summary :global(.meter-wrap) { inline-size: 100%; }
  .progress-detail-action { position: absolute; inset-block-start: -0.4375rem; inset-inline-end: 0; inline-size: 1.5rem; block-size: 1.5rem; min-inline-size: 1.5rem; min-block-size: 1.5rem; }
  .progress-legend { display: flex; min-inline-size: 0; align-items: center; gap: 0.625rem; font-size: 0.625rem; font-variant-numeric: tabular-nums; }
  .progress-legend span { display: inline-flex; flex-shrink: 0; align-items: center; gap: 0.2rem; white-space: nowrap; }
  .progress-legend span::before { content: ''; inline-size: 0.375rem; block-size: 0.375rem; border-radius: 999px; background: currentColor; }
  .progress-legend .completed { color: var(--caelestis-success); }
  .progress-legend .mismatched { color: var(--caelestis-danger); }
  .progress-legend .unpainted { opacity: 0.62; }
  .progress-legend .coverage { margin-inline-start: auto; opacity: 0.55; white-space: nowrap; }
  .progress-legend .coverage::before { display: none; }
  @container (max-width: 15rem) {
    .progress-legend { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); column-gap: 0.25rem; }
    .progress-legend .coverage { grid-column: 1 / -1; }
  }
  @container (max-width: 9rem) {
    .progress-legend { grid-template-columns: 1fr; row-gap: 0.125rem; }
    .progress-legend .coverage { margin-inline-start: 0; }
  }
  .notice { display: flex; align-items: center; gap: 0.5rem; min-block-size: 1.75rem; padding-inline-end: 0.75rem; color: var(--caelestis-muted-text); font-size: 0.72rem; }
  .standalone { display: flex; }
  .standalone.compact { justify-content: flex-start; padding: 0 0.75rem 0.5rem 2.25rem; }
  .standalone.ghost { justify-content: center; padding: 0.5rem 0.75rem 0; }
  .standalone-icon { display: inline-flex; flex: 0 0 auto; opacity: 0.6; }
  .notice button { border: 0; border-radius: var(--caelestis-radius); background: var(--caelestis-raised-surface); color: inherit; cursor: pointer; }
  @media (hover: hover) {
    .actions { opacity: 0; filter: blur(var(--icon-swap-blur)); pointer-events: none; }
    .row:hover .actions, .row:focus-within .actions { opacity: 1; filter: blur(0); pointer-events: auto; }
    .row:hover .row-tail > .progress, .row:focus-within .row-tail > .progress { opacity: 0; filter: blur(var(--icon-swap-blur)); pointer-events: none; }
  }
  @media (prefers-reduced-motion: reduce) {
    .actions, .progress { transition: none; }
  }
  /* Without hover there is no way to reveal row actions, so the context menu (press-and-hold) is the
     only action surface in tree mode: the meter and the icon buttons go, and the name gets the row. */
  @media (hover: none) {
    .tree:not(.preview-grid) .row-tail, .tree:not(.preview-grid) .row-heading > .actions { display: none; }
    .row { -webkit-touch-callout: none; -webkit-user-select: none; user-select: none; }
    .row input { -webkit-user-select: text; user-select: text; }
  }
  .tree.preview-grid { position: relative; display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 13rem), 1fr)); align-content: start; align-items: start; gap: 0.5rem; padding: 0.5rem; }
  .preview-grid > :not(.preview-card) { grid-column: 1 / -1; min-inline-size: 0; margin-inline: 0; }
  .preview-grid .folder-heading { border-block-end: 1px solid var(--caelestis-border); border-radius: 0; }
  .row.preview-card { min-inline-size: 0; margin: 0; padding: 0.5rem; gap: 0.5rem; border: 1px solid var(--caelestis-border); border-radius: var(--caelestis-radius); background: var(--caelestis-surface); }
  .preview-card.focused-template { border-color: color-mix(in oklab, var(--caelestis-primary) 65%, var(--caelestis-border)); background: color-mix(in oklab, var(--caelestis-primary) 8%, var(--caelestis-surface)); }
  .preview-card.focused-template::before { display: none; }
  .preview-card.regression-alarm, .preview-card.grief-alarm { background: color-mix(in oklab, var(--row-alarm-color) 14%, var(--caelestis-surface)); }
  .artwork { display: block; inline-size: 100%; padding: 0; border: 0; border-radius: var(--caelestis-radius); overflow: hidden; color: inherit; cursor: pointer; }
  .artwork:disabled { cursor: default; }
  .artwork:focus-visible { outline: 2px solid var(--caelestis-focus); outline-offset: -2px; }
  .card-caption { display: flex; justify-content: space-between; gap: 0.5rem; color: var(--caelestis-muted-text); font-size: 0.68rem; }
  .card-caption span:first-child { min-inline-size: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .card-caption span:last-child { flex-shrink: 0; font-variant-numeric: tabular-nums; }
  .folder-path { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--caelestis-muted-text); font-size: 0.68rem; }
  .preview-card .row-heading { flex-wrap: wrap; row-gap: 0.25rem; }
  .preview-card .name, .preview-card .rename { order: -1; flex: 1 0 100%; min-inline-size: 0; font-weight: 600; }
  .preview-card .rename { inline-size: 100%; }
  .preview-grid .actions { opacity: 1; pointer-events: auto; }
  .preview-card .progress-detail { padding: 0; }
  .card-progress { display: flex; align-items: center; gap: 0.375rem; inline-size: 100%; min-block-size: 1.5rem; padding: 0; border: 0; border-radius: var(--caelestis-radius); background: transparent; color: inherit; cursor: pointer; }
  .card-progress:hover { background: var(--caelestis-raised-surface); }
  .card-progress:focus-visible { outline: 2px solid var(--caelestis-focus); outline-offset: 2px; }
  .card-progress :global(.meter-wrap) { flex: 1; }
  .preview-grid .folder-heading .row-tail { display: flex; flex: 0 0 auto; inline-size: auto; }
  .preview-grid .folder-heading .row-tail > .progress { display: none; }
  @container (max-width: 24rem) {
    .preview-grid .folder-heading .row-heading { flex-wrap: wrap; }
    .preview-grid .folder-heading .name { flex: 1 0 calc(100% - 4rem); min-inline-size: 0; }
  }
</style>
