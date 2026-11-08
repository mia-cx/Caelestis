<script lang="ts">
  import Button from '../../foundations/Button.svelte'
  import MenuStyles from '../../foundations/MenuStyles.svelte'
  import { selectFace } from '../../foundations/select-face.js'
  import type { TemplateStudioIntent, TemplateStudioModel } from '../model.js'
  import { ANCHORS, RESIZE_MODES, type ResizeAnchor, type ResizeId } from '../options.js'
  import MoreOptions from '../MoreOptions.svelte'
  import RangeField from '../RangeField.svelte'
  import SwitchRow from '../SwitchRow.svelte'

  /**
   * The template's size, as Ditherette web's Dimensions panel: its scale, width and height, and
   * how it resamples. Its exact place on the canvas is under More options, since dragging it on
   * the map does that by hand.
   */
  let { model, onIntent }: { model: TemplateStudioModel; onIntent: (intent: TemplateStudioIntent) => void } = $props()

  const SLIDER_MIN_SCALE = 0.05
  const SLIDER_MAX_SCALE = 1
  /** Scale reads as a percentage of the cropped image. */
  const PERCENT = 100
  /** Hundredths of a percent, so a typed 12.5% stays 12.5%, not 13%. */
  const PERCENT_STEP = 0.01
  const id = $props.id()

  const output = $derived(model.output)
  const disabled = $derived(model.source === null || model.pending || output.locked)
  /** Before its image, a new template has no size or place to show. A replacement has both. */
  const unsized = $derived(model.source === null && !output.locked)

  const commitOnEnter = (event: KeyboardEvent): void => {
    if (event.key === 'Enter') (event.currentTarget as HTMLInputElement).blur()
  }
  const whole = (value: string, fallback: number): number => {
    const parsed = Math.round(Number(value))
    return Number.isFinite(parsed) ? parsed : fallback
  }

  /** Anchors are row-major: arrows move by one across and three down. */
  const STEPS: Partial<Record<string, readonly [number, number]>> = {
    ArrowLeft: [-1, 0],
    ArrowRight: [1, 0],
    ArrowUp: [0, -1],
    ArrowDown: [0, 1],
  }
  let anchors = $state<HTMLElement>()
  const moveAnchor = (event: KeyboardEvent, index: number): void => {
    const step = STEPS[event.key]
    if (step === undefined) return
    event.preventDefault()
    const column = Math.min(2, Math.max(0, (index % 3) + step[0]))
    const row = Math.min(2, Math.max(0, Math.floor(index / 3) + step[1]))
    const next = row * 3 + column
    onIntent({ type: 'anchor', anchor: ANCHORS[next]?.id ?? 'center' })
    anchors?.querySelectorAll<HTMLElement>('[role="radio"]')[next]?.focus()
  }
  const setAnchor = (anchor: ResizeAnchor): void => onIntent({ type: 'anchor', anchor })
</script>

<MenuStyles />

{#if !output.locked}
  <RangeField
    label="Scale"
    value={output.scale * PERCENT}
    min={SLIDER_MIN_SCALE * PERCENT}
    max={SLIDER_MAX_SCALE * PERCENT}
    step={PERCENT_STEP}
    unit="%"
    fieldMin={Number.MIN_VALUE}
    fieldMax={Number.MAX_VALUE}
    {disabled}
    onChange={(percent) => onIntent({ type: 'scale', scale: percent / PERCENT })}
  />
{/if}
{#each [['width', 'Width'], ['height', 'Height']] as const as [side, label] (side)}
  <div class="field-row">
    <label class="field-label" for="{id}-{side}">{label}</label>
    <span class="number">
      <input
        id="{id}-{side}"
        class="caelestis-field"
        type="number"
        inputmode="numeric"
        min="1"
        step="1"
        value={unsized ? '' : output[side]}
        {disabled}
        onkeydown={commitOnEnter}
        onchange={(event) => onIntent({ type: 'size', side, pixels: whole(event.currentTarget.value, output[side]) })}
      />
      <span class="unit">px</span>
    </span>
  </div>
{/each}
{#if output.locked}
  <p class="hint">A new version keeps the template’s size.</p>
{:else}
  <SwitchRow label="Keep proportions" checked={output.keepProportions} {disabled} onChange={(on) => onIntent({ type: 'keep-proportions', on })} />
  <div class="row-actions">
    <Button
      label="Reset aspect ratio"
      title="Back to the image’s own proportions"
      size="small"
      disabled={disabled || !output.stretched}
      onclick={() => onIntent({ type: 'reset-aspect' })}
    />
  </div>
{/if}

<div class="field-row">
  <label class="field-label" for="{id}-resize">Resample</label>
  <select
    id="{id}-resize"
    class="caelestis-select"
    {@attach selectFace}
    value={output.resize}
    disabled={model.source === null || model.pending}
    onchange={(event) => onIntent({ type: 'resize', resize: event.currentTarget.value as ResizeId })}
  >
    {#each RESIZE_MODES as mode (mode.id)}
      <option value={mode.id}>{mode.label}</option>
    {/each}
  </select>
</div>
<!-- Area sampling covers every source pixel, so only the other filters have an anchor. -->
{#if output.resize !== 'area'}
<div class="field-row">
  <span class="field-label" id="{id}-anchor">Anchor</span>
  <div bind:this={anchors} class="anchors" role="radiogroup" aria-labelledby="{id}-anchor">
    {#each ANCHORS as anchor, index (anchor.id)}
      {@const checked = anchor.id === output.anchor}
      <button
        type="button"
        role="radio"
        aria-checked={checked}
        aria-label={anchor.label}
        title={anchor.label}
        tabindex={checked ? 0 : -1}
        disabled={model.source === null || model.pending}
        onclick={() => setAnchor(anchor.id)}
        onkeydown={(event) => moveAnchor(event, index)}
      >
        <span class:checked></span>
      </button>
    {/each}
  </div>
</div>
{/if}

<MoreOptions name="size">
<p class="section">Position</p>
{#each [['x', 'X'], ['y', 'Y']] as const as [axis, label] (axis)}
  <div class="field-row">
    <label class="field-label" for="{id}-{axis}">{label}</label>
    <span class="number">
      <input
        id="{id}-{axis}"
        class="caelestis-field"
        type="number"
        inputmode="numeric"
        value={unsized ? '' : model.origin[axis]}
        disabled={model.pending || unsized}
        onkeydown={commitOnEnter}
        onchange={(event) =>
          onIntent({ type: 'origin', ...model.origin, [axis]: whole(event.currentTarget.value, model.origin[axis]) })}
      />
    </span>
  </div>
{/each}
<div class="row-actions">
  <Button label="Centre in view" size="small" disabled={model.pending || unsized} onclick={() => onIntent({ type: 'centre' })} />
</div>
</MoreOptions>

<style>
  .anchors { display: grid; grid-template-columns: repeat(3, 1.5rem); gap: 2px; inline-size: fit-content; }
  .anchors button {
    display: grid;
    place-items: center;
    block-size: 1.5rem;
    padding: 0;
    border: 1px solid color-mix(in oklab, var(--caelestis-text) 30%, transparent);
    border-radius: calc(var(--caelestis-radius, 0.5rem) / 3);
    background: var(--caelestis-raised-surface, #eee);
    cursor: pointer;
  }
  .anchors button:disabled { cursor: default; }
  .anchors button:focus-visible { outline: 2px solid var(--caelestis-focus, currentColor); outline-offset: 1px; }
  .anchors span {
    inline-size: 0.5rem;
    block-size: 0.5rem;
    background: color-mix(in oklab, var(--caelestis-text) 35%, transparent);
  }
  .anchors span.checked { background: var(--caelestis-primary, oklch(0.68 0.15 244)); }
</style>
