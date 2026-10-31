<script lang="ts">
  import type { ColourChannel, MaskCurve } from 'ditherette'
  import Button from '../../foundations/Button.svelte'
  import Icon from '../../foundations/Icon.svelte'
  import RangeField from '../RangeField.svelte'
  import { CURVE_CHANNELS, channelKey, channelLabel, sameChannel } from './catalog.js'
  import CurveGraph from './CurveGraph.svelte'
  import CurveGridGraph from './CurveGridGraph.svelte'
  import { neutralGrid } from './grid.js'
  import { fullMaskCurve, MASK_PRESETS, MAX_MASK_CURVES, presetIndex, presetValues, setPreset } from './mask.js'
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
  const VIEWS = [...MASK_PRESETS.map(({ label }) => ({ id: label, label })), { id: 'Curves', label: 'Curves' }]
  /** A new curve reads the first of these its mask does not read yet. */
  const NEW_INPUTS: readonly ColourChannel[] = [
    { model: 'oklch', channel: 'lightness' },
    { model: 'oklch', channel: 'hue' },
    { model: 'oklch', channel: 'chroma' },
    { model: 'oklab', channel: 'a' },
  ]

  /** Which part of the mask the section shows: one preset family, or every curve. */
  let view = $state('Tones')
  let selected = $state(0)
  const preset = $derived(MASK_PRESETS.find(({ label }) => label === view))
  const active = $derived(Math.min(selected, mask.length - 1))
  const curve = $derived(mask[active])

  /** A preset's curve is named after it; others by what they read. */
  const curveName = (item: MaskCurve): string => {
    if (item.x2) return `${channelLabel(item.x)} × ${channelLabel(item.x2).split(' · ')[1]}`
    return MASK_PRESETS.find((family) => presetIndex([item], family) === 0)?.label ?? channelLabel(item.x)
  }

  const slide = (index: number, percent: number): void => {
    if (preset === undefined) return
    const values = presetValues(mask, preset)
    values[index] = percent / PERCENT
    onChange(setPreset(mask, preset, values))
  }

  const replace = (next: MaskCurve): void => onChange(mask.map((other, at) => (at === active ? next : other)))

  const add = (): void => {
    const x = NEW_INPUTS.find((input) => !mask.some((item) => sameChannel(item.x, input))) ?? NEW_INPUTS[0]
    if (x === undefined) return
    onChange([...mask, fullMaskCurve(x)])
    selected = mask.length
  }

  const remove = (): void => {
    onChange(mask.filter((_, index) => index !== active))
    selected = Math.max(0, active - 1)
  }

  const channelFor = (key: string): ColourChannel | undefined =>
    CURVE_CHANNELS.find(({ channel }) => channelKey(channel) === key)?.channel

  /** A curve drawn over one input means nothing over another, so a new input starts at full strength. */
  const setInput = (key: string): void => {
    const x = channelFor(key)
    if (!curve || !x || sameChannel(x, curve.x)) return
    if (curve.x2 && !sameChannel(x, curve.x2)) replace({ x, x2: curve.x2, grid: neutralGrid(x, curve.x2, 1) })
    else replace(fullMaskCurve(x))
  }

  /** A second input turns the curve into a grid over both inputs; none turns it back. */
  const setSecondInput = (key: string): void => {
    if (!curve) return
    const x2 = channelFor(key)
    if (!x2) {
      if (curve.x2) replace(fullMaskCurve(curve.x))
      return
    }
    if (sameChannel(x2, curve.x) || (curve.x2 && sameChannel(x2, curve.x2))) return
    replace({ x: curve.x, x2, grid: neutralGrid(curve.x, x2, 1) })
  }
</script>

<section class="mask" aria-labelledby="{id}-mask">
  <p id="{id}-mask" class="field-label">Mask</p>
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
    <div class="chips" role="group" aria-label="Mask curves">
      {#each mask as item, index (index)}
        <button type="button" class="chip" class:active={index === active} aria-pressed={index === active} onclick={() => (selected = index)}>
          {curveName(item)}
        </button>
      {/each}
      <Button label="Add mask curve" title="Add curve" kind="ghost" size="compact" iconOnly disabled={mask.length >= MAX_MASK_CURVES} onclick={add}>
        <Icon name="add" />
      </Button>
    </div>

    {#if curve}
      {#key active}
        {#if curve.x2}
          <CurveGridGraph id="{id}-mask" {curve} valueLabel="Strength" neutral={1} onChange={(next) => replace(next)} />
        {:else}
          {@const one = curve}
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
        {/if}
      {/key}

      <div class="field-row">
        <label class="field-label" for="{id}-mask-x">Reads</label>
        <select id="{id}-mask-x" class="caelestis-select" value={channelKey(curve.x)} onchange={(event) => setInput(event.currentTarget.value)}>
          {#each CURVE_CHANNELS as option (channelKey(option.channel))}
            <option value={channelKey(option.channel)}>{option.label}</option>
          {/each}
        </select>
      </div>
      <div class="field-row">
        <label class="field-label" for="{id}-mask-x2">And</label>
        <select id="{id}-mask-x2" class="caelestis-select" value={curve.x2 ? channelKey(curve.x2) : ''} onchange={(event) => setSecondInput(event.currentTarget.value)}>
          <option value="">Nothing else</option>
          {#each CURVE_CHANNELS.filter(({ channel }) => !sameChannel(channel, curve.x)) as option (channelKey(option.channel))}
            <option value={channelKey(option.channel)}>{option.label}</option>
          {/each}
        </select>
      </div>
      <div class="actions-row">
        <Button label="Remove curve" size="small" onclick={remove} />
      </div>
    {/if}
  {/if}
</section>

<style>
  .mask { display: flex; flex-direction: column; gap: 0.5rem; padding-block-start: 0.5rem; border-block-start: 1px solid var(--caelestis-border); }
  .chips { display: flex; flex-wrap: wrap; align-items: center; gap: 0.25rem; }
  .chip {
    padding: 0.25rem 0.5rem;
    border: 1px solid var(--caelestis-border);
    border-radius: var(--caelestis-pill-radius, 999px);
    background: var(--caelestis-raised-surface, #eee);
    color: var(--caelestis-text);
    font: 600 0.6875rem/1.2 var(--caelestis-font, ui-sans-serif, system-ui, sans-serif);
    cursor: pointer;
  }
  .chip.active { border-color: var(--caelestis-primary, oklch(0.68 0.15 244)); background: color-mix(in oklab, var(--caelestis-primary, oklch(0.68 0.15 244)) 18%, var(--caelestis-raised-surface, #eee)); }
</style>
