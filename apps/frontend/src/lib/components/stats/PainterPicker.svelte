<script lang="ts">
  /**
   * The pace legend for a crowded server: rows toggle painters' lines, and "All users", the
   * template's own pace lines, stays pinned at the top whatever the search says.
   */
  import type { PainterTotal } from '@caelestis/shared'
  import { Icon } from '@caelestis/ui'
  import { MAX_SELECTED_PAINTERS } from './pace-selection.svelte.js'
  import { painterColour, painterLabel, rankPainters } from './painter-identity.js'
  import SearchableMenu from './SearchableMenu.svelte'

  let {
    options,
    selected,
    onToggle,
    onSetAll,
    allUsersShown,
    onToggleAllUsers,
    onHover,
  }: {
    options: readonly PainterTotal[]
    /** Painters currently drawn. */
    selected: ReadonlySet<number>
    onToggle: (wplaceUserId: number) => void
    onSetAll: (shown: boolean) => void
    /** Whether the template's own rolling pace lines, everyone together, are drawn. */
    allUsersShown: boolean
    onToggleAllUsers: () => void
    /** The row under the pointer or keyboard, so the chart can spotlight that painter's line. */
    onHover: (wplaceUserId: number | null) => void
  } = $props()

  const full = $derived(selected.size >= MAX_SELECTED_PAINTERS)

  const summary = $derived.by(() => {
    const first = options.find((painter) => selected.has(painter.wplaceUserId))
    const painters =
      selected.size === 0
        ? null
        : selected.size === 1 && first !== undefined
          ? painterLabel(first)
          : `${selected.size} of ${options.length}${full ? ' (max)' : ''}`
    if (allUsersShown) return painters === null ? 'all users' : `all users + ${painters}`
    return painters ?? 'none'
  })
</script>

<SearchableMenu
  label="choose whose pace to draw"
  searchLabel="Search painters"
  rows={options}
  search={rankPainters}
  key={(painter) => String(painter.wplaceUserId)}
  disabled={(painter) => full && !selected.has(painter.wplaceUserId)}
  onSelect={(painter) => onToggle(painter.wplaceUserId)}
  onHighlight={(painter) => onHover(painter?.wplaceUserId ?? null)}
  pinned={{
    swatch: 'var(--pace-short)',
    checked: allUsersShown,
    state: allUsersShown ? 'drawn' : 'not drawn',
    onSelect: onToggleAllUsers,
  }}
  empty="No painters have reported yet."
  noMatch="No painter matches."
>
  {#snippet trigger()}<span>{summary}</span>{/snippet}
  {#snippet header()}
    {#if options.length > 0}
      <div class="mb-2 flex gap-2" role="group" aria-label="All painter lines">
        <button type="button" class="btn btn-xs btn-soft flex-1" onclick={() => onSetAll(true)}>
          {options.length > MAX_SELECTED_PAINTERS ? `Show first ${MAX_SELECTED_PAINTERS}` : 'Show all'}
        </button>
        <button type="button" class="btn btn-xs btn-soft flex-1" onclick={() => onSetAll(false)}>
          Hide all
        </button>
      </div>
    {/if}
  {/snippet}
  {#snippet row(painter)}
    {@const isSelected = selected.has(painter.wplaceUserId)}
    <span
      class="size-2.5 shrink-0 rounded-full"
      style:background={painterColour(painter.wplaceUserId)}
      style:opacity={isSelected ? 1 : 0.4}
      aria-hidden="true"
    ></span>
    <span class="min-w-0 flex-1 truncate">{painterLabel(painter)}</span>
    <span class="shrink-0 text-[10px] tabular-nums text-base-content/50">
      {painter.placed.toLocaleString()} px
    </span>
    <!-- `aria-selected` is the command cursor, so the drawn state is read out as text. -->
    <span class="sr-only">{isSelected ? 'drawn' : 'not drawn'}</span>
    <span class="flex size-3 shrink-0 items-center justify-center">
      {#if isSelected}<Icon name="check" class="size-4.5" />{/if}
    </span>
  {/snippet}
</SearchableMenu>
