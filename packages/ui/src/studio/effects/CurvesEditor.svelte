<script lang="ts">
  import type { ColourChannel, Curve, CurvesEffect } from 'ditherette'
  import Button from '../../foundations/Button.svelte'
  import Icon from '../../foundations/Icon.svelte'
  import {
    CURVE_CHANNELS,
    channelKey,
    channelLabel,
    FLAT,
    MAX_CURVES,
    neutralCurve,
    STRAIGHT,
    sameChannel,
  } from './catalog.js'
  import CurveGraph from './CurveGraph.svelte'
  import CurveGridGraph from './CurveGridGraph.svelte'
  import { neutralGrid } from './grid.js'
  import Segmented from './Segmented.svelte'
  import { hueAxis } from './tone.js'

  /** Ditherette web's Curves editor: several curves, each reading one or two channels. */
  let { id, step, onChange }: { id: string; step: CurvesEffect; onChange: (step: CurvesEffect) => void } = $props()

  /** Each curve's colour, by position: its line and its chip swatch. */
  const TONES = [
    'var(--caelestis-primary, oklch(0.68 0.15 244))',
    'oklch(0.69 0.15 237)',
    'oklch(0.67 0.26 322)',
    'oklch(0.7 0.15 163)',
    'oklch(0.7 0.19 47)',
    'oklch(0.61 0.22 293)',
  ] as const
  const tone = (index: number): string => TONES[index % TONES.length] ?? TONES[0]

  /** A new curve targets one hue range's saturation, the classic selective adjustment. */
  const NEW_CURVE = neutralCurve({ model: 'oklch', channel: 'hue' }, { model: 'oklch', channel: 'chroma' })

  let selected = $state(0)
  /** `selected` can outlive a removed curve, so everything reads this. */
  const active = $derived(Math.min(selected, step.curves.length - 1))
  const curve = $derived(step.curves[active])

  /**
   * "Lightness (OKLCH)" for a remap, "Hue vs Chroma (OKLCH)" for an adjustment, and
   * "Hue × Lightness vs Chroma (OKLCH)" for a two-input curve.
   */
  const curveName = (c: Curve): string => {
    const parts = [c.x, ...(c.x2 ? [c.x2] : []), c.y].map((channel) => channelLabel(channel).split(' · '))
    const models = new Set(parts.map(([model]) => model))
    const part = (index: number): readonly string[] => parts[index] ?? []
    const name = (index: number): string =>
      models.size === 1 ? (part(index)[1] ?? '') : `${part(index)[1]} (${part(index)[0]})`
    const suffix = models.size === 1 ? ` (${part(0)[0]})` : ''
    if (c.kind === 'remap') return `${part(0)[1]} (${part(0)[0]})`
    const inputs = c.x2 ? `${name(0)} × ${name(1)}` : name(0)
    return `${inputs} vs ${name(parts.length - 1)}${suffix}`
  }

  /** A hue input wraps for adjustments; hue remaps read their input straight across. */
  const periodic = (c: Curve): boolean => c.kind === 'adjust' && c.x.channel === 'hue'

  const replace = (next: Curve): void =>
    onChange({ ...step, curves: step.curves.map((item, at) => (at === active ? next : item)) })

  const add = (): void => {
    onChange({ ...step, curves: [...step.curves, NEW_CURVE] })
    selected = step.curves.length
  }

  const remove = (): void => {
    onChange({ ...step, curves: step.curves.filter((_, index) => index !== active) })
    selected = Math.max(0, active - 1)
  }

  /** Curves apply in list order, so moving one changes the result. */
  const move = (from: number, to: number): void => {
    if (from === to || to < 0 || to >= step.curves.length) return
    const curves = step.curves.slice()
    const [moved] = curves.splice(from, 1)
    if (moved !== undefined) curves.splice(to, 0, moved)
    onChange({ ...step, curves })
    selected = to
  }

  const channelFor = (key: string): ColourChannel | undefined =>
    CURVE_CHANNELS.find(({ channel }) => channelKey(channel) === key)?.channel

  /** A curve drawn over one input means nothing over another, so a new input starts neutral. */
  const setInput = (key: string): void => {
    const x = channelFor(key)
    if (!curve || !x || sameChannel(x, curve.x)) return
    if (curve.x2 && !sameChannel(x, curve.x2))
      replace({ kind: 'adjust', x, x2: curve.x2, y: curve.y, grid: neutralGrid(x, curve.x2) })
    else replace(neutralCurve(x, curve.y))
  }

  /** A second input turns the curve into a grid over both inputs; none turns it back. */
  const setSecondInput = (key: string): void => {
    if (!curve) return
    const x2 = channelFor(key)
    if (!x2) {
      if (curve.x2) replace(neutralCurve(curve.x, curve.y))
      return
    }
    if (sameChannel(x2, curve.x) || (curve.x2 && sameChannel(x2, curve.x2))) return
    replace({ kind: 'adjust', x: curve.x, x2, y: curve.y, grid: neutralGrid(curve.x, x2) })
  }

  /** A new output keeps an adjustment's shape; a remap onto another channel becomes a flat adjustment. */
  const setOutput = (key: string): void => {
    const y = channelFor(key)
    if (!curve || !y || sameChannel(y, curve.y)) return
    if (curve.x2) replace({ ...curve, y })
    else if (curve.kind === 'remap') replace({ kind: 'adjust', x: curve.x, y, points: FLAT })
    else if (sameChannel(curve.x, y)) replace(neutralCurve(curve.x, y))
    else replace({ ...curve, y })
  }

  const setKind = (kind: 'remap' | 'adjust'): void => {
    if (!curve || curve.x2 || kind === curve.kind) return
    if (kind === 'remap' && sameChannel(curve.x, curve.y)) replace({ ...curve, kind, points: STRAIGHT })
    if (kind === 'adjust') replace({ ...curve, kind, points: FLAT })
  }
</script>

<div class="chips" role="group" aria-label="Curves">
  {#each step.curves as item, index (index)}
    <button type="button" class="chip" class:active={index === active} aria-pressed={index === active} onclick={() => (selected = index)}>
      <span class="swatch" style:background={tone(index)} aria-hidden="true"></span>{curveName(item)}
    </button>
  {/each}
  <Button label="Add curve" title="Add curve" kind="ghost" size="compact" iconOnly disabled={step.curves.length >= MAX_CURVES} onclick={add}>
    <Icon name="add" />
  </Button>
</div>

{#if curve}
  {#key active}
    {#if curve.x2}
      <CurveGridGraph {id} {curve} valueLabel="Adjustment" neutral={0.5} onChange={(next) => replace(next)} />
    {:else}
      {@const one = curve}
      <CurveGraph
        {id}
        points={one.points}
        colour={tone(active)}
        neutral={one.kind === 'remap' ? 'diagonal' : 'flat'}
        periodic={periodic(one)}
        spectrum={one.x.channel === 'hue' ? hueAxis(one.x.model) : undefined}
        behind={step.curves.flatMap((other, index) =>
          index !== active && !other.x2 && other.kind === one.kind && sameChannel(other.x, one.x)
            ? [{ points: other.points, colour: tone(index) }]
            : [],
        )}
        axes={{ x: channelLabel(one.x), y: one.kind === 'remap' ? channelLabel(one.y) : 'Adjustment' }}
        onChange={(points) => replace({ ...one, points })}
      />
    {/if}
  {/key}

  <div class="field-row">
    <label class="field-label" for="{id}-x">Reads</label>
    <select id="{id}-x" class="caelestis-select" value={channelKey(curve.x)} onchange={(event) => setInput(event.currentTarget.value)}>
      {#each CURVE_CHANNELS as option (channelKey(option.channel))}
        <option value={channelKey(option.channel)}>{option.label}</option>
      {/each}
    </select>
  </div>
  <div class="field-row">
    <label class="field-label" for="{id}-x2">And</label>
    <select id="{id}-x2" class="caelestis-select" value={curve.x2 ? channelKey(curve.x2) : ''} onchange={(event) => setSecondInput(event.currentTarget.value)}>
      <option value="">Nothing else</option>
      {#each CURVE_CHANNELS.filter(({ channel }) => !sameChannel(channel, curve.x)) as option (channelKey(option.channel))}
        <option value={channelKey(option.channel)}>{option.label}</option>
      {/each}
    </select>
  </div>
  <div class="field-row">
    <label class="field-label" for="{id}-y">Changes</label>
    <select id="{id}-y" class="caelestis-select" value={channelKey(curve.y)} onchange={(event) => setOutput(event.currentTarget.value)}>
      {#each CURVE_CHANNELS as option (channelKey(option.channel))}
        <option value={channelKey(option.channel)}>{option.label}</option>
      {/each}
    </select>
  </div>
  {#if !curve.x2}
    <div class="field-row">
      <span class="field-label">Kind</span>
      <Segmented
        label="Kind"
        value={curve.kind}
        options={sameChannel(curve.x, curve.y)
          ? [{ id: 'remap', label: 'Remap' }, { id: 'adjust', label: 'Adjust' }]
          : [{ id: 'adjust', label: 'Adjust' }]}
        onChange={setKind}
      />
    </div>
  {/if}
  <div class="actions-row">
    <Button label="Move curve earlier" title="Move earlier" size="small" iconOnly disabled={active === 0} onclick={() => move(active, active - 1)}>
      <Icon name="arrowBack" />
    </Button>
    <Button label="Move curve later" title="Move later" size="small" iconOnly disabled={active === step.curves.length - 1} onclick={() => move(active, active + 1)}>
      <Icon name="caret" />
    </Button>
    <Button label="Remove curve" size="small" onclick={remove} />
  </div>
{/if}

<style>
  .chips { display: flex; flex-wrap: wrap; align-items: center; gap: 0.25rem; }
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    padding: 0.25rem 0.5rem;
    border: 1px solid var(--caelestis-border);
    border-radius: var(--caelestis-pill-radius, 999px);
    background: var(--caelestis-raised-surface, #eee);
    color: var(--caelestis-text);
    font: 600 0.6875rem/1.2 var(--caelestis-font, ui-sans-serif, system-ui, sans-serif);
    cursor: pointer;
  }
  .chip.active { border-color: var(--caelestis-primary, oklch(0.68 0.15 244)); background: color-mix(in oklab, var(--caelestis-primary, oklch(0.68 0.15 244)) 18%, var(--caelestis-raised-surface, #eee)); }
  .swatch { inline-size: 0.5rem; block-size: 0.5rem; border-radius: 50%; }
</style>
