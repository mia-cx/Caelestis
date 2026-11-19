<script lang="ts">
  /**
   * Chooses whose contributions the heatmap shows: everyone, or one painter. Rows show the Wplace id
   * so namesakes stay apart, and the choice is that id, so renames and refreshes keep it.
   */
  import type { ContributionPainter } from './community.svelte.js'
  import { painterColour, painterLabel, rankPainters } from './painter-identity.js'
  import SearchableMenu from './SearchableMenu.svelte'

  let {
    options,
    selected,
    onSelect,
  }: {
    options: readonly ContributionPainter[]
    /** The painter shown, or null for everyone. */
    selected: number | null
    onSelect: (wplaceUserId: number | null) => void
  } = $props()

  let open = $state(false)
  const summary = $derived(
    selected === null
      ? 'all users'
      : painterLabel(
          options.find((painter) => painter.wplaceUserId === selected) ?? {
            wplaceUserId: selected,
            displayName: '',
          },
        ),
  )

  const choose = (wplaceUserId: number | null): void => {
    onSelect(wplaceUserId)
    open = false
  }
</script>

<SearchableMenu
  bind:open
  label="choose whose contributions to show"
  align="end"
  searchLabel="Search painters"
  rows={options}
  search={rankPainters}
  key={(painter) => String(painter.wplaceUserId)}
  onSelect={(painter) => choose(painter.wplaceUserId)}
  checked={(painter) => painter.wplaceUserId === selected}
  states={['shown', 'not shown']}
  pinned={{
    label: 'All users',
    // The heatmap's own ramp: everyone is what the heatmap draws by default.
    swatch: 'var(--heat-4)',
    checked: selected === null,
    onSelect: () => choose(null),
  }}
  empty="No painters have reported yet."
  noMatch="No painter matches."
>
  {#snippet trigger()}
    {#if selected !== null}
      <span class="size-2.5 shrink-0 rounded-full" style:background={painterColour(selected)} aria-hidden="true"></span>
    {/if}
    <span>{summary}</span>
    {#if selected !== null}<span class="text-base-content/50">#{selected}</span>{/if}
  {/snippet}
  {#snippet row(painter)}
    <span
      class="size-2.5 shrink-0 rounded-full"
      style:background={painterColour(painter.wplaceUserId)}
      aria-hidden="true"
    ></span>
    <span class="min-w-0 flex-1 truncate">
      {painterLabel(painter)}
      <span class="ml-1 text-[10px] tabular-nums text-base-content/50">#{painter.wplaceUserId}</span>
    </span>
    <span class="shrink-0 text-[10px] tabular-nums text-base-content/50">
      {painter.placed.toLocaleString()} px
    </span>
  {/snippet}
</SearchableMenu>
