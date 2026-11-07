<script lang="ts">
  import Icon from './Icon.svelte'
  import SliderStyles from './SliderStyles.svelte'

  interface Props {
    label: string
    value: number
    defaultValue: number
    min: number
    max: number
    step: number
    format: (value: number) => string
    compact?: boolean
    locked?: boolean
    disabled?: boolean
    control?: string
    depth?: number
    resettable?: boolean
    onInput?: (value: number) => void
    onCommit?: (value: number) => void
    onReset?: (value: number) => void
  }

  let {
    label,
    value,
    defaultValue,
    min,
    max,
    step,
    format,
    compact = false,
    locked = false,
    disabled = false,
    control,
    depth,
    resettable = true,
    onInput,
    onCommit,
    onReset,
  }: Props = $props()

  let local = $state(0)
  let dirty = $state(false)
  let keyHeld = $state(false)
  $effect(() => { local = value })

  const input = (): void => {
    if (locked || disabled) return
    dirty = true
    onInput?.(local)
  }

  const commit = (): void => {
    if (!dirty || locked || disabled) return
    dirty = false
    onCommit?.(local)
  }

  const reset = (): void => {
    if (locked || disabled || Object.is(local, defaultValue)) return
    local = defaultValue
    onReset?.(defaultValue)
  }
</script>

<label class:compact class:hierarchy={depth !== undefined} class:disabled={disabled} data-depth={depth} style:--depth={depth ?? 0}>
  <span class="name">{label}</span>
  <span class="control">
    <input
      type="range"
      class="caelestis-slider"
      {min}
      {max}
      {step}
      {disabled}
      aria-label={label}
      aria-disabled={locked || disabled}
      data-caelestis-control={control}
      style:--fill={`${max === min ? 0 : ((local - min) / (max - min)) * 100}%`}
      bind:value={local}
      oninput={input}
      onchange={() => { if (!keyHeld) commit() }}
      onpointerdown={(event) => { if (locked || disabled) event.preventDefault() }}
      onkeydown={(event) => {
        if (locked || disabled) event.preventDefault()
        else if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key)) keyHeld = true
      }}
      onkeyup={(event) => {
        if (!keyHeld || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key)) return
        keyHeld = false
        commit()
      }}
      onblur={() => setTimeout(commit, 0)}
    />
    <span class="readout">{format(local)}</span>
    {#if resettable}<button
      type="button"
      hidden={Object.is(local, defaultValue)}
      disabled={disabled}
      aria-disabled={locked || disabled}
      aria-label={`Reset ${label.toLowerCase()}`}
      title={`Reset ${label.toLowerCase()}`}
      onclick={reset}
    ><Icon name="reset" size="0.75rem" /></button>{/if}
  </span>
</label>
<SliderStyles />

<style>
  label { display: grid; grid-template-columns: minmax(5rem, auto) minmax(0, 1fr); align-items: center; gap: 0.75rem; min-block-size: 0; padding: 0.5rem 0; color: var(--caelestis-text, inherit); font: 400 0.875rem/1.2 var(--caelestis-font, ui-sans-serif, system-ui, sans-serif); }
  label.compact { grid-template-columns: minmax(3.5rem, auto) minmax(0, 1fr); gap: 0.5rem; font-size: 0.75rem; }
  label.disabled { opacity: 0.45; }
  .control { display: flex; min-inline-size: 0; align-items: center; gap: 0.75rem; }
  .compact .control { gap: 0.5rem; }
  input { flex: 1; min-inline-size: 0; inline-size: clamp(3rem, 20rem, 100%); }
  .readout { flex: 0 0 2.75rem; color: var(--caelestis-muted-text, color-mix(in oklch, currentColor 60%, transparent)); text-align: end; font-size: 0.72rem; font-variant-numeric: tabular-nums; }
  .compact .readout { flex-basis: 2.5rem; }
  button { display: grid; flex: 0 0 1.5rem; place-items: center; inline-size: 1.5rem; block-size: 1.5rem; padding: 0; border: 0; border-radius: var(--caelestis-pill-radius, 999px); background: transparent; color: inherit; cursor: pointer; }
  button[hidden] { visibility: hidden; }
  button:hover { background: color-mix(in oklab, currentColor 10%, transparent); }
  button:focus-visible { outline: 2px solid var(--caelestis-focus, currentColor); outline-offset: 2px; }
  .hierarchy { grid-template-columns: minmax(0, 1fr) 8.5rem; padding-block: 0.5rem; padding-inline-start: calc(1.25rem * var(--depth)); }
  .hierarchy .control { gap: 0.5rem; }
  .hierarchy.compact { grid-template-columns: minmax(0, 1fr) 8.5rem; padding-block: 0.25rem; }
  .hierarchy:is([data-depth='1'], [data-depth='2']) .name { font-size: 0.75rem; opacity: 0.8; }
</style>
