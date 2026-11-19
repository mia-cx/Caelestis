<script lang="ts">
  import { type ColourChannel, MAX_MASK_CURVES, type MaskCurve } from '../ditherette.js'
  import RangeField from '../RangeField.svelte'
  import { channelInfo, channelLabel, sameChannel } from './catalog.js'
  import CurveGraph from './CurveGraph.svelte'
  import CurveListEditor from './CurveListEditor.svelte'
  import { neutralGrid } from './grid.js'
  import { fullMaskCurve, MASK_PRESETS, presetIndex, presetValues, setPreset } from './mask.js'
  import Segmented from './Segmented.svelte'
  import { hueAxis } from './tone.js'

  /**
   * Where an effect applies, as Ditherette web's mask editor: preset sliders for tones, colours,
   * and saturation, or up to four curves that multiply.
   */
  let {
    id,
    mask,
    onChange,
  }: {
    id: string
    mask: readonly MaskCurve[]
    /** Receives the new mask; an empty one means full strength everywhere. */
    onChange: (mask: MaskCurve[]) => void
  } = $props()

  const PERCENT = 100
  const FULL_STRENGTH = 1
  const VIEWS = [...MASK_PRESETS.map(({ label }) => ({ id: label, label })), { id: 'Curves', label: 'Curves' }]
  const LIGHTNESS: ColourChannel = { model: 'oklch', channel: 'lightness' }
  /** A new curve reads the first of these its mask does not read yet. */
  const NEW_INPUTS: readonly ColourChannel[] = [
    LIGHTNESS,
    { model: 'oklch', channel: 'hue' },
    { model: 'oklch', channel: 'chroma' },
    { model: 'oklab', channel: 'a' },
  ]

  /** Which part of the mask the section shows: one preset family, or every curve. */
  let view = $state('Tones')
  let selected = $state(0)
  const preset = $derived(MASK_PRESETS.find(({ label }) => label === view))

  /** A preset's curve is named after it; others by what they read. */
  const curveName = (item: MaskCurve): string => {
    if (item.x2) return `${channelLabel(item.x)} × ${channelInfo(item.x2).name}`
    return MASK_PRESETS.find((family) => presetIndex([item], family) === 0)?.label ?? channelLabel(item.x)
  }

  const slide = (index: number, percent: number): void => {
    if (preset === undefined) return
    const values = presetValues(mask, preset)
    values[index] = percent / PERCENT
    onChange(setPreset(mask, preset, values))
  }

  const added = (): MaskCurve =>
    fullMaskCurve(NEW_INPUTS.find((input) => !mask.some((item) => sameChannel(item.x, input))) ?? LIGHTNESS)

  /** A new input starts at full strength. */
  const reading = (_: MaskCurve, x: ColourChannel, x2?: ColourChannel): MaskCurve =>
    x2 ? { x, x2, grid: neutralGrid(x, x2, FULL_STRENGTH) } : fullMaskCurve(x)
</script>

<section class="mask" aria-labelledby="{id}-mask">
  <p id="{id}-mask" class="section">Mask</p>
  <Segmented label="Mask view" value={view} options={VIEWS} onChange={(next) => (view = next)} />

  {#if preset !== undefined}
    {@const values = presetValues(mask, preset)}
    {#each preset.ranges as range, index (range.label)}
      <RangeField
        label={range.label}
        value={Math.round((values[index] ?? 1) * PERCENT)}
        min={0}
        max={PERCENT}
        step={1}
        unit="%"
        onChange={(percent) => slide(index, percent)}
      />
    {/each}
  {:else}
    <CurveListEditor
      id="{id}-mask"
      label="Mask curves"
      addLabel="Add mask curve"
      curves={mask}
      max={MAX_MASK_CURVES}
      bind:selected
      valueLabel="Strength"
      neutral={FULL_STRENGTH}
      {onChange}
      {added}
      {reading}
      name={curveName}
    >
      {#snippet graph(one, _, replace)}
        <CurveGraph
          id="{id}-mask"
          points={one.points}
          colour="var(--caelestis-primary, oklch(0.68 0.15 244))"
          neutral="full"
          periodic={one.x.channel === 'hue'}
          spectrum={one.x.channel === 'hue' ? hueAxis(one.x.model) : undefined}
          axes={{ x: channelLabel(one.x), y: 'Strength' }}
          onChange={(points) => replace({ x: one.x, points })}
        />
      {/snippet}
    </CurveListEditor>
  {/if}
</section>

<style>
  .mask { display: flex; flex-direction: column; gap: 0.5rem; }
</style>
