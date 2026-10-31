<script lang="ts">
  import MenuStyles from '../../foundations/MenuStyles.svelte'
  import type { TemplateStudioIntent, TemplateStudioModel } from '../model.js'
  import { COLOR_SPACES, type ColorSpaceId } from '../options.js'

  /** How each pixel picks its palette colour. */
  let { model, onIntent }: { model: TemplateStudioModel; onIntent: (intent: TemplateStudioIntent) => void } = $props()

  const id = $props.id()
  const current = $derived(COLOR_SPACES.find((space) => space.id === model.colorSpace) ?? COLOR_SPACES[0])
</script>

<MenuStyles />

<label class="field-label" for="{id}-space">Distance mode</label>
<select
  id="{id}-space"
  class="caelestis-select"
  value={model.colorSpace}
  disabled={model.pending}
  onchange={(event) => onIntent({ type: 'color-space', colorSpace: event.currentTarget.value as ColorSpaceId })}
>
  {#each COLOR_SPACES as space (space.id)}
    <option value={space.id}>{space.label}</option>
  {/each}
</select>
<p class="hint">{current.description}</p>
