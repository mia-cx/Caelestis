<script lang="ts" generics="Row">
  /**
   * A button that pops out a searchable list, for lists too long for one button per entry. Hosts
   * supply the rows, how a query ranks them, and how a row reads; the menu shows at most a page of
   * matches, so a thousand painters cost a thousand entries in memory and fifty in the DOM.
   */
  import { Icon } from '@caelestis/ui'
  import { Command, Popover } from 'bits-ui'
  import type { Snippet } from 'svelte'

  const PAGE_SIZE = 50

  let {
    open = $bindable(false),
    label,
    trigger,
    align = 'start',
    searchLabel,
    rows,
    search,
    key,
    disabled,
    title,
    onSelect,
    onHighlight,
    row,
    pinned,
    header,
    empty,
    noMatch,
  }: {
    open?: boolean
    /** The trigger's accessible name. */
    label: string
    trigger: Snippet
    align?: 'start' | 'end'
    searchLabel: string
    rows: readonly Row[]
    /** The rows matching a query, best first; an empty query keeps the host's order. */
    search: (rows: readonly Row[], query: string) => readonly Row[]
    key: (row: Row) => string
    disabled?: (row: Row) => boolean
    title?: (row: Row) => string
    onSelect: (row: Row) => void
    /** The row under the pointer or the keyboard cursor, or null when none is. */
    onHighlight?: (row: Row | null) => void
    row: Snippet<[Row]>
    /** A row above the separator that no search hides, such as "All users". */
    pinned?: {
      readonly swatch: string
      readonly checked: boolean
      /** Read out in place of the check mark, such as "drawn". */
      readonly state: string
      readonly onSelect: () => void
    }
    header?: Snippet
    /** Shown when there are no rows at all. */
    empty?: string
    noMatch: string
  } = $props()

  const PINNED = 'pinned'
  let query = $state('')
  const matches = $derived(search(rows, query))
  const page = $derived(matches.slice(0, PAGE_SIZE))
  const hidden = $derived(matches.length - page.length)
  const rowByKey = $derived(new Map(page.map((entry) => [key(entry), entry])))
</script>

<Popover.Root
  bind:open
  onOpenChange={(next) => {
    if (next) return
    query = ''
    onHighlight?.(null)
  }}
>
  <Popover.Trigger class="btn btn-xs btn-soft gap-1.5 tabular-nums" aria-label={label}>
    {@render trigger()}
    <Icon name="unfoldMore" class="size-4.5 text-base-content/60" />
  </Popover.Trigger>
  <Popover.Portal>
    <Popover.Content sideOffset={4} {align} class="caelestis-menu z-50 w-72 outline-none">
      {@render header?.()}
      <!-- The command cursor is the keyboard's pointer: wherever it lands is highlighted. -->
      <Command.Root
        shouldFilter={false}
        disableInitialScroll
        loop
        class="flex flex-col gap-1"
        onValueChange={(value) => onHighlight?.(rowByKey.get(value) ?? null)}
      >
        <Command.Input
          class="input input-xs w-full text-xs"
          placeholder={searchLabel}
          aria-label={searchLabel}
          bind:value={query}
        />
        <Command.List class="max-h-64 overflow-y-auto">
          <Command.Viewport>
            {#if pinned !== undefined}
              <Command.Item value={PINNED} class="caelestis-menu-item w-full select-none" onSelect={pinned.onSelect}>
                <span
                  class="size-2.5 shrink-0 rounded-full"
                  style:background={pinned.swatch}
                  style:opacity={pinned.checked ? 1 : 0.4}
                  aria-hidden="true"
                ></span>
                <span class="min-w-0 flex-1 truncate font-medium">All users</span>
                <span class="sr-only">{pinned.state}</span>
                <span class="flex size-3 shrink-0 items-center justify-center">
                  {#if pinned.checked}<Icon name="check" class="size-4.5" />{/if}
                </span>
              </Command.Item>
              <Command.Separator forceMount class="my-1 h-px bg-base-300" />
            {/if}
            {#each page as entry (key(entry))}
              <Command.Item
                value={key(entry)}
                disabled={disabled?.(entry) ?? false}
                title={title?.(entry)}
                class="caelestis-menu-item w-full select-none"
                onSelect={() => onSelect(entry)}
                onpointerenter={() => onHighlight?.(entry)}
                onpointerleave={() => onHighlight?.(null)}
              >
                {@render row(entry)}
              </Command.Item>
            {/each}
            {#if rows.length === 0 && empty !== undefined}
              <div class="px-2 py-3 text-center text-xs text-base-content/50">{empty}</div>
            {:else if page.length === 0}
              <div class="px-2 py-3 text-center text-xs text-base-content/50">{noMatch}</div>
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
