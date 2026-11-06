<script lang="ts">
  import Button from '../../foundations/Button.svelte'
  import type { TemplateStudioIntent, TemplateStudioModel } from '../model.js'

  /** The image: a file, the clipboard, or a web address. The map's Crop mode chooses what part of it is used. */
  let { model, onIntent }: { model: TemplateStudioModel; onIntent: (intent: TemplateStudioIntent) => void } = $props()

  const id = $props.id()

  let url = $state('')
  let dragging = $state(false)
  const chooseFile = (event: Event & { currentTarget: HTMLInputElement }): void => {
    const file = event.currentTarget.files?.[0]
    event.currentTarget.value = ''
    if (file !== undefined) onIntent({ type: 'file', file })
  }
  const drop = (event: DragEvent): void => {
    // Every drop here is the studio's: left to the browser, a file or link would open over Wplace.
    event.preventDefault()
    dragging = false
    const file = [...(event.dataTransfer?.files ?? [])].find((candidate) => candidate.type.startsWith('image/'))
    if (file !== undefined) onIntent({ type: 'file', file })
  }
  const submitUrl = (event: SubmitEvent): void => {
    event.preventDefault()
    if (url.trim() !== '') onIntent({ type: 'url', url: url.trim() })
  }
  const cropped = $derived(
    model.source !== null &&
      (model.crop.width !== model.source.width || model.crop.height !== model.source.height),
  )
</script>

<fieldset disabled={model.pending}>
  <div
    class="drop"
    class:dragging
    class:empty={model.source === null}
    role="group"
    aria-label="Image"
    ondragover={(event) => { event.preventDefault(); dragging = true }}
    ondragleave={() => (dragging = false)}
    ondrop={drop}
  >
    {#if model.source === null}
      <p class="lead">{model.loadingSource ? 'Loading image…' : 'Drop an image anywhere, or paste one.'}</p>
    {:else}
      {@const source = model.source}
      <img src={source.url} alt="" draggable="false" />
      <div class="about">
        <p class="name" title={source.name}>{source.name}</p>
        <p class="size">{source.width} × {source.height}{#if cropped}, cropped to {model.crop.width} × {model.crop.height}{/if}</p>
      </div>
    {/if}
  </div>
  <div class="actions-row">
    <label class="file caelestis-bevel">
      <span>{model.source === null ? 'Choose file' : 'Choose another'}</span>
      <input type="file" accept="image/*" onchange={chooseFile} />
    </label>
    <Button label="Paste" size="small" onclick={() => onIntent({ type: 'paste' })} />
  </div>
  <form class="url" onsubmit={submitUrl}>
    <label class="field-label" for="{id}-url">Image address</label>
    <div class="url-row">
      <input id="{id}-url" class="caelestis-field" type="url" inputmode="url" placeholder="https://" bind:value={url} />
      <Button type="submit" label="Load" size="small" disabled={url.trim() === ''} />
    </div>
  </form>
</fieldset>

<style>
  fieldset { display: contents; }
  .drop {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    border-radius: var(--caelestis-radius, 0.7rem);
    transition: border-color var(--caelestis-duration-quick), background-color var(--caelestis-duration-quick);
  }
  .drop.empty {
    justify-content: center;
    min-block-size: 6rem;
    padding: 1rem;
    border: 2px dashed var(--caelestis-border);
    text-align: center;
  }
  .drop.dragging {
    border-color: var(--caelestis-primary, oklch(0.68 0.15 244));
    background: color-mix(in oklab, var(--caelestis-primary, oklch(0.68 0.15 244)) 10%, transparent);
  }
  .lead { margin: 0; color: var(--caelestis-muted-text); }
  img {
    flex: 0 0 auto;
    inline-size: 4rem;
    block-size: 4rem;
    object-fit: contain;
    background: repeating-conic-gradient(rgb(0 0 0 / 0.08) 0 25%, transparent 0 50%) 0 0 / 8px 8px;
    image-rendering: pixelated;
  }
  .about { display: grid; gap: 0.125rem; min-inline-size: 0; }
  .about p { margin: 0; }
  .name { overflow: hidden; font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
  .size { color: var(--caelestis-muted-text); font-variant-numeric: tabular-nums; }
  .file {
    position: relative;
    display: inline-flex;
    align-items: center;
    padding: 0 0.75rem;
    min-block-size: 2rem;
    border: 1px solid var(--caelestis-border);
    border-radius: var(--caelestis-radius, 0.5rem);
    background: var(--caelestis-raised-surface, #eee);
    font-weight: 600;
    cursor: pointer;
  }
  .file:focus-within { outline: 2px solid var(--caelestis-focus, currentColor); outline-offset: 2px; }
  .file input { position: absolute; inset: 0; opacity: 0; cursor: pointer; }
  .url { display: grid; gap: 0.25rem; }
  .url-row { display: flex; gap: 0.35rem; }
  .url-row input { flex: 1; min-inline-size: 0; }
  @media (pointer: coarse) {
    .file { min-block-size: 2.75rem; }
  }
</style>
