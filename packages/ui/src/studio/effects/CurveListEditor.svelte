<script lang="ts" generics="C extends Curve | MaskCurve">
  import type { Snippet } from 'svelte'
  import Button from '../../foundations/Button.svelte'
  import Icon from '../../foundations/Icon.svelte'
  import { selectFace } from '../../foundations/select-face.js'
  import type { ColourChannel, Curve, MaskCurve } from '../ditherette.js'
  import { CURVE_CHANNELS, channelFor, channelKey, sameChannel } from './catalog.js'
  import CurveGridGraph from './CurveGridGraph.svelte'
  import type { GridCurve } from './grid.js'

  /**
   * A list of curves, as Ditherette web edits a curves step and a mask: a chip per curve, then
   * the selected curve's graph and what it reads. A second input turns a curve into a grid over
   * both inputs.
   */
  let {
    id,
    label,
    addLabel,
    curves,
    max,
    selected = $bindable(0),
    valueLabel,
    neutral,
    onChange,
    added,
    reading,
    name,
    tone,
    ordered = false,
    graph,
    rows,
  }: {
    id: string
    /** Names the chips' group, such as "Curves". */
    label: string
    /** Names the add button, such as "Add curve". */
    addLabel: string
    curves: readonly C[]
    max: number
    /** The selected curve's index. */
    selected?: number
    /** What a grid's values mean, and the value that changes nothing. */
    valueLabel: string
    neutral: number
    onChange: (curves: C[]) => void
    /** The curve the add button appends. */
    added: () => C
    /** A neutral curve in place of `curve`, reading `x` and, when given, `x2`. */
    reading: (curve: C, x: ColourChannel, x2?: ColourChannel) => C
    name: (curve: C) => string
    /** A curve's colour by position, shown on its chip. */
    tone?: (index: number) => string
    /** Curves that apply in order can move; mask curves multiply, so their order is moot. */
    ordered?: boolean
    /** The selected one-input curve's graph. */
    graph: Snippet<[curve: Exclude<C, GridCurve>, index: number, replace: (next: C) => void]>
    /** Rows after what the curve reads. */
    rows?: Snippet<[curve: C, replace: (next: C) => void]>
  } = $props()

  /** `selected` can outlive a removed curve, so everything reads this. */
  const active = $derived(Math.min(selected, curves.length - 1))
  const curve = $derived(curves[active])

  const isGrid = (item: C): item is C & GridCurve => item.x2 !== undefined
  const isLine = (item: C): item is Exclude<C, GridCurve> => item.x2 === undefined

  const replace = (next: C): void => onChange(curves.map((item, at) => (at === active ? next : item)))

  const add = (): void => {
    onChange([...curves, added()])
    selected = curves.length
  }

  const remove = (): void => {
    onChange(curves.filter((_, index) => index !== active))
    selected = Math.max(0, active - 1)
  }

  const move = (from: number, to: number): void => {
    if (from === to || to < 0 || to >= curves.length) return
    const next = curves.slice()
    const [moved] = next.splice(from, 1)
    if (moved !== undefined) next.splice(to, 0, moved)
    onChange(next)
    selected = to
  }

  /** A curve drawn over one input means nothing over another, so a new input starts neutral. */
  const setInput = (key: string): void => {
    const x = channelFor(key)
    if (!curve || !x || sameChannel(x, curve.x)) return
    replace(reading(curve, x, curve.x2 && !sameChannel(x, curve.x2) ? curve.x2 : undefined))
  }

  /** A second input turns the curve into a grid over both inputs; none turns it back. */
  const setSecondInput = (key: string): void => {
    if (!curve) return
    const x2 = channelFor(key)
    if (!x2) {
      if (curve.x2) replace(reading(curve, curve.x))
      return
    }
    if (sameChannel(x2, curve.x) || (curve.x2 && sameChannel(x2, curve.x2))) return
    replace(reading(curve, curve.x, x2))
  }
</script>

<div class="choices wrap" role="group" aria-label={label}>
  {#each curves as item, index (index)}
    <button type="button" class="choice caelestis-bevel" aria-pressed={index === active} onclick={() => (selected = index)}>
      {#if tone !== undefined}<span class="swatch" style:background={tone(index)} aria-hidden="true"></span>{/if}{name(item)}
    </button>
  {/each}
  <Button label={addLabel} title="Add curve" kind="ghost" size="compact" iconOnly disabled={curves.length >= max} onclick={add}>
    <Icon name="add" />
  </Button>
</div>

{#if curve}
  {#key active}
    {#if isGrid(curve)}
      <CurveGridGraph {id} {curve} {valueLabel} {neutral} onChange={replace} />
    {:else if isLine(curve)}
      {@render graph(curve, active, replace)}
    {/if}
  {/key}

  <div class="field-row">
    <label class="field-label" for="{id}-x">Reads</label>
    <select id="{id}-x" class="caelestis-select" {@attach selectFace} value={channelKey(curve.x)} onchange={(event) => setInput(event.currentTarget.value)}>
      {#each CURVE_CHANNELS as option (channelKey(option.channel))}
        <option value={channelKey(option.channel)}>{option.label}</option>
      {/each}
    </select>
  </div>
  <div class="field-row">
    <label class="field-label" for="{id}-x2">And</label>
    <select id="{id}-x2" class="caelestis-select" {@attach selectFace} value={curve.x2 ? channelKey(curve.x2) : ''} onchange={(event) => setSecondInput(event.currentTarget.value)}>
      <option value="">Nothing else</option>
      {#each CURVE_CHANNELS.filter(({ channel }) => !sameChannel(channel, curve.x)) as option (channelKey(option.channel))}
        <option value={channelKey(option.channel)}>{option.label}</option>
      {/each}
    </select>
  </div>
  {@render rows?.(curve, replace)}
  <div class="row-actions">
    {#if ordered}
      <Button label="Move curve earlier" title="Move earlier" size="small" iconOnly disabled={active === 0} onclick={() => move(active, active - 1)}>
        <Icon name="arrowBack" />
      </Button>
      <Button label="Move curve later" title="Move later" size="small" iconOnly disabled={active === curves.length - 1} onclick={() => move(active, active + 1)}>
        <Icon name="caret" />
      </Button>
    {/if}
    <Button label="Remove curve" size="small" onclick={remove} />
  </div>
{/if}

<style>
  .swatch { inline-size: 0.5rem; block-size: 0.5rem; border-radius: 50%; }
</style>
