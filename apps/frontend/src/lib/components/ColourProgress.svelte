<script lang="ts">
import type { ColourProgress as Colour } from '@caelestis/shared'
import { COLOUR_PROGRESS_SORTS, ColourProgress, type ColourProgressSort } from '@caelestis/ui'
import Select from '#lib/components/Select.svelte'
import { STORAGE_KEYS } from '#lib/deployment.js'
import { Persisted } from '#lib/persisted.svelte.js'

let { colours }: { colours: readonly Colour[] } = $props()
const storedSort = new Persisted<ColourProgressSort>(STORAGE_KEYS.colourSort, 'index')
// A sort stored by an older release may no longer exist.
const sort = $derived(
  COLOUR_PROGRESS_SORTS.some((option) => option.key === storedSort.value) ? storedSort.value : 'index',
)
</script>

<div class="toolbar">
  <span id="colour-sort-label">Sort by</span>
  <Select
    value={sort}
    options={COLOUR_PROGRESS_SORTS}
    onValueChange={(key) => (storedSort.value = key)}
    labelledby="colour-sort-label"
  />
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
