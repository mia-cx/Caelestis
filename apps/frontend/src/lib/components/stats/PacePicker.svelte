<script lang="ts">
  import { Icon } from '@caelestis/ui'
  import SearchableMenu from './SearchableMenu.svelte'

  interface PaceOption {
    readonly key: string
    readonly colour: string
    readonly selected: boolean
    readonly available: boolean
  }

  let { options, onToggle }: { options: readonly PaceOption[]; onToggle: (key: string) => void } =
    $props()

  const drawn = $derived(options.filter((option) => option.selected && option.available))
  const summary = $derived(
    drawn.length === 0
      ? 'None'
      : drawn.length <= 2
        ? drawn.map((option) => option.key).join(', ')
        : `${drawn.length} lines`,
  )
</script>

<SearchableMenu
  label={`Pace lines: ${summary}`}
  searchLabel="Search pace lines"
  rows={options}
  search={(rows, query) => rows.filter((option) => option.key.includes(query.trim().toLowerCase()))}
  key={(option) => option.key}
  disabled={(option) => !option.available}
  title={(option) => (option.available ? 'Rolling average' : 'No suitable history')}
  onSelect={(option) => onToggle(option.key)}
  noMatch="No matching pace lines."
>
  {#snippet trigger()}<span>{summary}</span>{/snippet}
  {#snippet row(option)}
    {@const shown = option.selected && option.available}
    <span class="h-0.5 w-3 shrink-0 rounded-full" style:background={option.colour} aria-hidden="true"></span>
    <span class="min-w-0 flex-1 font-medium">{option.key}</span>
    {#if !option.available}<span class="sr-only">No suitable history</span>{/if}
    <span class="sr-only">{shown ? 'drawn' : 'not drawn'}</span>
    <span class="flex size-3 shrink-0 items-center justify-center">
      {#if shown}<Icon name="check" class="size-4.5" />{/if}
    </span>
  {/snippet}
</SearchableMenu>
