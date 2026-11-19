<script lang="ts">
import type { TemplateColourStatus } from '@caelestis/shared'
import { COLOUR_PROGRESS_SORTS, ColourProgress, type ColourProgressSort } from '@caelestis/ui'
import * as Select from '#lib/components/ui/select/index.js'
import { persisted } from '#lib/persisted.svelte.js'

let { colours }: { colours: readonly TemplateColourStatus[] } = $props()
const storedSort = persisted<ColourProgressSort>('caelestis:colour-sort', 'index')
const allowed = new Set<string>(COLOUR_PROGRESS_SORTS.map((option) => option.key))
const isSort = (value: string): value is ColourProgressSort => allowed.has(value)
const sort = $derived(isSort(storedSort.value) ? storedSort.value : 'index')
const label = $derived(
  COLOUR_PROGRESS_SORTS.find((option) => option.key === sort)?.label ?? 'palette index',
)
</script>

<div class="toolbar">
  <!-- The site's own picker, so the open list is page content and takes the page's font. -->
  <span id="colour-sort-label">Sort by</span>
  <Select.Root
    type="single"
    value={sort}
    onValueChange={(value) => {
      if (isSort(value)) storedSort.value = value
    }}
  >
    <Select.Trigger size="sm" aria-labelledby="colour-sort-label">{label}</Select.Trigger>
    <Select.Content>
      {#each COLOUR_PROGRESS_SORTS as option (option.key)}
        <Select.Item value={option.key} label={option.label} />
      {/each}
    </Select.Content>
  </Select.Root>
</div>
<ColourProgress {colours} {sort} />

<style>
  .toolbar {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 0.5rem;
    margin-block-end: 0.5rem;
    color: var(--caelestis-muted-text);
    line-height: 1.2;
  }
</style>
