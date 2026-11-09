<script lang="ts">
  import Button from '../foundations/Button.svelte'
  import type { TemplateStudioIntent, TemplateStudioModel } from './model.js'

  /**
   * The ways to load an image besides dropping or pasting it anywhere: a file, the clipboard, or a
   * web address. The studio shows it on the map before there is an image, and under Replace image
   * after.
   */
  let { model, onIntent }: { model: TemplateStudioModel; onIntent: (intent: TemplateStudioIntent) => void } = $props()

  const id = $props.id()

  let url = $state('')
  const chooseFile = (event: Event & { currentTarget: HTMLInputElement }): void => {
    const file = event.currentTarget.files?.[0]
    event.currentTarget.value = ''
    if (file !== undefined) onIntent({ type: 'file', file })
  }
  const submitUrl = (event: SubmitEvent): void => {
    event.preventDefault()
    if (url.trim() !== '') onIntent({ type: 'url', url: url.trim() })
  }
</script>

<fieldset disabled={model.pending}>
  <div class="actions-row">
    <label class="file caelestis-bevel">
      <span>Choose file</span>
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
  fieldset { display: grid; gap: 0.75rem; min-inline-size: 0; margin: 0; padding: 0; border: 0; }
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
