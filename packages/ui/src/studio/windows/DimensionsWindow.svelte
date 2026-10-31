<script lang="ts">
  import Button from '../../foundations/Button.svelte'
  import MenuStyles from '../../foundations/MenuStyles.svelte'
  import type { TemplateStudioIntent, TemplateStudioModel } from '../model.js'
  import { ANCHORS, RESIZE_MODES, type ResizeAnchor, type ResizeId } from '../options.js'
  import RangeField from '../RangeField.svelte'

  /** Output size and resampling, as Ditherette web's Dimensions panel, plus where it sits. */
  let { model, onIntent }: { model: TemplateStudioModel; onIntent: (intent: TemplateStudioIntent) => void } = $props()

  const SLIDER_MIN_SCALE = 0.05
  const SLIDER_MAX_SCALE = 1
  const SCALE_STEP = 0.0001
  const id = $props.id()

  const output = $derived(model.output)
  const disabled = $derived(model.source === null || model.pending || output.locked)

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

<RangeField
  label="Scale"
  value={output.scale}
  min={SLIDER_MIN_SCALE}
  max={SLIDER_MAX_SCALE}
  step={SCALE_STEP}
  unit="×"
  fieldMin={Number.MIN_VALUE}
  fieldMax={Number.MAX_VALUE}
  {disabled}
  onChange={(scale) => onIntent({ type: 'scale', scale })}
/>
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
        value={output[side]}
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
{/if}
<div class="field-row">
  <label class="field-label" for="{id}-resize">Resample</label>
  <select
    id="{id}-resize"
    class="caelestis-select"
    value={output.resize}
    disabled={model.source === null || model.pending}
    onchange={(event) => onIntent({ type: 'resize', resize: event.currentTarget.value as ResizeId })}
  >
    {#each RESIZE_MODES as mode (mode.id)}
      <option value={mode.id}>{mode.label}</option>
    {/each}
  </select>
</div>
<div class="field-row">
  <span class="field-label" id="{id}-anchor">Anchor</span>
  <div bind:this={anchors} class="anchors" role="radiogroup" aria-labelledby="{id}-anchor" aria-disabled={output.resize === 'area'}>
    {#each ANCHORS as anchor, index (anchor.id)}
      {@const checked = anchor.id === output.anchor}
      <button
        type="button"
        role="radio"
        aria-checked={checked}
        aria-label={anchor.label}
        title={anchor.label}
        tabindex={checked ? 0 : -1}
        disabled={output.resize === 'area' || model.source === null || model.pending}
        onclick={() => setAnchor(anchor.id)}
        onkeydown={(event) => moveAnchor(event, index)}
      >
        <span class:checked></span>
      </button>
    {/each}
  </div>
</div>

<p class="field-label section">Position</p>
<div class="fields two">
  {#each [['x', 'X'], ['y', 'Y']] as const as [axis, label] (axis)}
    <label class="number">
      <span>{label}</span>
      <input
        class="caelestis-field"
        type="number"
        value={model.origin[axis]}
        disabled={model.pending}
        onkeydown={commitOnEnter}
        onchange={(event) =>
          onIntent({ type: 'origin', ...model.origin, [axis]: whole(event.currentTarget.value, model.origin[axis]) })}
      />
    </label>
  {/each}
</div>
<div class="actions-row">
  <Button label="Centre in view" size="small" disabled={model.pending} onclick={() => onIntent({ type: 'centre' })} />
</div>
<p class="hint">Drag the image on the map to move it. Arrow keys nudge it.</p>

<style>
  .section { margin-block-start: 0.5rem; }
  .anchors { display: grid; grid-template-columns: repeat(3, 1.5rem); gap: 2px; inline-size: fit-content; }
  .anchors[aria-disabled='true'] { opacity: 0.5; }
  .anchors button {
    display: grid;
    place-items: center;
    block-size: 1.5rem;
    padding: 0;
    border: 1px solid var(--caelestis-border);
    border-radius: calc(var(--caelestis-radius, 0.5rem) / 3);
    background: var(--caelestis-raised-surface, #eee);
    cursor: pointer;
  }
  .anchors button:disabled { cursor: default; }
  .anchors button:focus-visible { outline: 2px solid var(--caelestis-focus, currentColor); outline-offset: 1px; }
  .anchors span {
    inline-size: 0.5rem;
    block-size: 0.5rem;
    background: color-mix(in oklab, currentColor 30%, transparent);
  }
  .anchors span.checked { background: var(--caelestis-primary, oklch(0.68 0.15 244)); }
</style>
