<script lang="ts">
  import MenuStyles from '../../foundations/MenuStyles.svelte'
  import { SCOPE_MODELS, type ScopeModel, vectorPlane } from '../colour.js'
  import Segmented from '../effects/Segmented.svelte'
  import type { TemplateStudioIntent, TemplateStudioModel } from '../model.js'
  import Chromaticity from '../scopes/Chromaticity.svelte'
  import Histogram from '../scopes/Histogram.svelte'
  import {
    chromaticityScope,
    clipping,
    formatShare,
    histogram,
    pickStages,
    SCOPE_STAGES,
    SCOPES,
    type ScopeKind,
    type ScopeStage,
    vectorscope,
    waveform,
  } from '../scopes/scopes.js'
  import Vectorscope from '../scopes/Vectorscope.svelte'
  import Waveform from '../scopes/Waveform.svelte'

  /**
   * Ditherette web's Scopes: one or two stages of the image, the later drawn over the earlier,
   * as a histogram, waveform, parade, vectorscope, or chromaticity diagram.
   */
  let { model, onIntent }: { model: TemplateStudioModel; onIntent: (intent: TemplateStudioIntent) => void } = $props()

  const id = $props.id()
  let scopeId = $state<ScopeKind>('histogram')
  let modelId = $state<ScopeModel>('srgb')
  let zoom = $state(1)
  /** Stages turned on most recently last: dropping the earliest leaves the newest comparison. */
  let recent: ScopeStage[] = []

  const scope = $derived(SCOPES.find(({ id: kind }) => kind === scopeId) ?? SCOPES[0])
  const colourModel = $derived(SCOPE_MODELS.find(({ id: modelKind }) => modelKind === modelId) ?? SCOPE_MODELS[0])
  const chromaticity = $derived(scope.id === 'chromaticity')
  const shown = $derived(model.scopes.stages)
  const [underStage, overStage] = $derived<[ScopeStage | undefined, ScopeStage | undefined]>(
    shown.length > 1 ? [shown[0], shown[1]] : [undefined, shown[0]],
  )
  const under = $derived(underStage === undefined ? undefined : model.scopes.samples[underStage])
  const over = $derived(overStage === undefined ? undefined : model.scopes.samples[overStage])
  const clip = $derived(over === undefined || model.scopes.pending ? undefined : clipping(over))
  const plane = $derived(vectorPlane(colourModel?.id ?? 'srgb'))

  const toggleStage = (stage: ScopeStage): void => {
    const on = shown.includes(stage)
    // Keep one stage showing; an empty scope has nothing to compare.
    if (on && shown.length === 1) return
    const next = on ? shown.filter((other) => other !== stage) : [...shown, stage]
    // Stages already showing count as older than the one turned on now.
    const known = recent.length > 0 ? recent : shown
    recent = [...known.filter((other) => other !== stage), ...(on ? [] : [stage])]
    onIntent({ type: 'scope-stages', stages: pickStages(next, recent) })
  }
</script>

<MenuStyles />

<div class="controls">
  <select class="caelestis-select" aria-label="Scope" value={scope.id} onchange={(event) => (scopeId = event.currentTarget.value as ScopeKind)}>
    {#each SCOPES as option (option.id)}
      <option value={option.id}>{option.label}</option>
    {/each}
  </select>
  <select
    class="caelestis-select"
    aria-label="Colour model"
    value={colourModel?.id}
    disabled={chromaticity}
    onchange={(event) => (modelId = event.currentTarget.value as ScopeModel)}
  >
    {#each SCOPE_MODELS as option (option.id)}
      <option value={option.id}>{option.label}</option>
    {/each}
  </select>
</div>
<div class="stages" role="group" aria-label="Images to show">
  {#each SCOPE_STAGES as stage (stage.id)}
    <button type="button" class:active={shown.includes(stage.id)} aria-pressed={shown.includes(stage.id)} onclick={() => toggleStage(stage.id)}>{stage.label}</button>
  {/each}
</div>

<div class="screen" class:pending={model.scopes.pending} aria-busy={model.scopes.pending || undefined} id="{id}-screen">
  {#if model.source === null || colourModel === undefined}
    <p class="empty">Open an image to see its scopes.</p>
  {:else if scope.id === 'histogram'}
    <Histogram channels={colourModel.channels} under={under && histogram(under, colourModel.id)} over={over && histogram(over, colourModel.id)} />
  {:else if scope.id === 'waveform' || scope.id === 'parade'}
    <div class="inset">
      <Waveform
        channels={colourModel.channels}
        parade={scope.id === 'parade'}
        under={under && waveform(under, colourModel.id)}
        over={over && waveform(over, colourModel.id)}
      />
    </div>
  {:else if scope.id === 'vectorscope'}
    <div class="inset">
      <Vectorscope {plane} under={under && vectorscope(under, plane, zoom)} over={over && vectorscope(over, plane, zoom)} {zoom} onZoom={(next) => (zoom = next)} />
    </div>
  {:else}
    <div class="inset">
      <Chromaticity under={under && chromaticityScope(under)} over={over && chromaticityScope(over)} />
    </div>
  {/if}
</div>

{#if model.source !== null}
  <div class="status">
    {#if scope.id === 'histogram'}
      <span class:clipped={(clip?.black ?? 0) > 0}><span class="chip black"></span>Black {clip ? formatShare(clip.black) : '—'}</span>
      <span class="middle">{model.scopes.pending ? 'Updating…' : `${SCOPE_STAGES.find(({ id: stage }) => stage === overStage)?.label ?? ''} clipping`}</span>
      <span class:clipped={(clip?.white ?? 0) > 0}>White {clip ? formatShare(clip.white) : '—'}<span class="chip white"></span></span>
    {:else if model.scopes.pending}
      <span class="middle">Updating…</span>
    {/if}
  </div>
{/if}

<style>
  .controls { display: grid; grid-template-columns: 1fr 1fr; gap: 0.35rem; }
  .stages { display: flex; border: 1px solid var(--caelestis-border); border-radius: var(--caelestis-radius, 0.5rem); overflow: hidden; }
  .stages button {
    flex: 1;
    padding: 0.35rem 0.25rem;
    border: 0;
    background: var(--caelestis-raised-surface, #eee);
    color: var(--caelestis-text);
    font: 600 0.75rem/1 var(--caelestis-font, ui-sans-serif, system-ui, sans-serif);
    cursor: pointer;
  }
  .stages button + button { border-inline-start: 1px solid var(--caelestis-border); }
  .stages button.active { background: var(--caelestis-primary, oklch(0.68 0.15 244)); color: white; }
  .screen { position: relative; block-size: 15rem; border: 1px solid var(--caelestis-border); background: black; color: white; transition: opacity var(--caelestis-duration-quick); }
  .screen.pending { opacity: 0.6; }
  .inset { block-size: 100%; box-sizing: border-box; padding: 0.5rem; }
  .empty { position: absolute; inset: 0; display: grid; place-items: center; margin: 0; color: rgb(255 255 255 / 0.5); font-size: 0.75rem; }
  .status { display: flex; align-items: center; gap: 0.5rem; color: var(--caelestis-muted-text); font-size: 0.75rem; font-variant-numeric: tabular-nums; }
  .status .middle { flex: 1; text-align: center; }
  .clipped { color: var(--caelestis-text); font-weight: 600; }
  .chip { display: inline-block; inline-size: 0.625rem; block-size: 0.625rem; margin-inline: 0.25rem; border: 1px solid var(--caelestis-border); vertical-align: -0.05rem; }
  .chip.black { background: black; }
  .chip.white { background: white; }
</style>
