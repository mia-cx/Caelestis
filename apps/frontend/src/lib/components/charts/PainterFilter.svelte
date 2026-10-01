<script lang="ts">
  /**
   * Chooses whose contributions the heatmap shows: everyone, or one painter. It shares the pace
   * picker's searchable popover, but picks one row instead of toggling many. Rows show the Wplace
   * id so namesakes stay apart, and the choice is that id, so renames and refreshes keep it.
   */
  import { Icon, MenuStyles } from '@caelestis/ui'
  import { Command, Popover } from 'bits-ui'
  import {
    type ContributionPainter,
    painterColour,
    painterLabel,
    rankPainters,
  } from '$lib/components/charts/painter-pace'

  let {
    options,
    selected,
    onSelect,
    pageSize = 50,
  }: {
    options: readonly ContributionPainter[]
    /** The painter shown, or null for everyone. */
    selected: number | null
    onSelect: (wplaceUserId: number | null) => void
    pageSize?: number
  } = $props()

  const ALL_USERS = 'all-users'

  let query = $state('')
  let open = $state(false)
  const ranked = $derived(rankPainters(options, query))
  const page = $derived(ranked.slice(0, pageSize))
  const hidden = $derived(ranked.length - page.length)
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

<MenuStyles />

<Popover.Root bind:open onOpenChange={(next) => { if (!next) query = '' }}>
  <Popover.Trigger
    data-contribution-painter-trigger
    class="btn btn-xs btn-soft gap-1.5 tabular-nums"
    aria-label="choose whose contributions to show"
  >
    {#if selected !== null}
      <span class="size-2.5 shrink-0 rounded-full" style:background={painterColour(selected)} aria-hidden="true"></span>
    {/if}
    <span>{summary}</span>
    {#if selected !== null}<span class="text-base-content/50">#{selected}</span>{/if}
    <Icon name="unfoldMore" class="size-4.5 text-base-content/60" />
  </Popover.Trigger>
  <Popover.Portal>
    <Popover.Content
      data-contribution-painter-list
      sideOffset={4}
      align="end"
      class="caelestis-menu z-50 w-72 outline-none"
    >
      <Command.Root shouldFilter={false} loop class="flex flex-col gap-1">
        <Command.Input
          class="input input-xs w-full text-xs"
          placeholder="Search painters"
          aria-label="search painters"
          bind:value={query}
        />
        <Command.List class="max-h-64 overflow-y-auto">
          <Command.Viewport>
            <!-- Pinned: the search never hides the way back to everyone. -->
            <Command.Item
              value={ALL_USERS}
              data-contribution-all-users
              class="caelestis-menu-item w-full select-none"
              onSelect={() => choose(null)}
            >
              <span class="size-2.5 shrink-0 rounded-full" style:background="var(--heat-4)" aria-hidden="true"></span>
              <span class="min-w-0 flex-1 truncate font-medium">All users</span>
              <span class="sr-only">{selected === null ? 'shown' : 'not shown'}</span>
              <span class="flex size-3 shrink-0 items-center justify-center">
                {#if selected === null}<Icon name="check" class="size-4.5" />{/if}
              </span>
            </Command.Item>
            <Command.Separator forceMount class="my-1 h-px bg-base-300" />
            {#each page as painter (painter.wplaceUserId)}
              {@const isSelected = painter.wplaceUserId === selected}
              <Command.Item
                value={String(painter.wplaceUserId)}
                data-contribution-painter={painter.wplaceUserId}
                class="caelestis-menu-item w-full select-none"
                onSelect={() => choose(painter.wplaceUserId)}
              >
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
                <span class="sr-only">{isSelected ? 'shown' : 'not shown'}</span>
                <span class="flex size-3 shrink-0 items-center justify-center">
                  {#if isSelected}<Icon name="check" class="size-4.5" />{/if}
                </span>
              </Command.Item>
            {/each}
            {#if options.length === 0}
              <div class="px-2 py-3 text-center text-xs text-base-content/50">
                No painters have reported yet.
              </div>
            {:else if page.length === 0}
              <div class="px-2 py-3 text-center text-xs text-base-content/50">No painter matches.</div>
            {:else if hidden > 0}
              <div class="px-2 py-1.5 text-center text-[10px] text-base-content/50">
                {hidden} more; keep typing to narrow the list.
              </div>
            {/if}
          </Command.Viewport>
        </Command.List>
      </Command.Root>
    </Popover.Content>
  </Popover.Portal>
</Popover.Root>
