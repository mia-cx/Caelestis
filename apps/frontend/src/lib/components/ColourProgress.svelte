<script lang="ts">
import type { TemplateColourStatus } from '@caelestis/shared'
import { COLOUR_PROGRESS_SORTS, ColourProgress, type ColourProgressSort } from '@caelestis/ui'
import * as Select from '$lib/components/ui/select'
import { persisted } from '$lib/persisted.svelte'

let { colours }: { colours: readonly TemplateColourStatus[] } = $props()
const storedSort = persisted<ColourProgressSort>('caelestis:colour-sort', 'index')
const allowed = new Set<ColourProgressSort>(COLOUR_PROGRESS_SORTS.map((option) => option.key))
const sort = $derived(allowed.has(storedSort.value) ? storedSort.value : 'index')
const label = $derived(
  COLOUR_PROGRESS_SORTS.find((option) => option.key === sort)?.label ?? 'palette index',
)
</script>

<ColourProgress {colours} {sort} onSortChange={(value) => (storedSort.value = value)}>
  {#snippet sortControl()}
    <!-- The site's own picker, so the open list is page content and takes the page's font. -->
    <span id="colour-sort-label">Sort by</span>
    <Select.Root
      type="single"
      value={sort}
      onValueChange={(value) => {
        if (allowed.has(value as ColourProgressSort)) storedSort.value = value as ColourProgressSort
      }}
    >
      <Select.Trigger size="sm" aria-labelledby="colour-sort-label">{label}</Select.Trigger>
      <Select.Content>
        {#each COLOUR_PROGRESS_SORTS as option (option.key)}
          <Select.Item value={option.key} label={option.label} />
        {/each}
      </Select.Content>
    </Select.Root>
  {/snippet}
</ColourProgress>
