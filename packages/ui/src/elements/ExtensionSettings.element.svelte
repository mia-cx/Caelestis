<svelte:options customElement={{ shadow: 'open', props: { model: { type: 'Object' } } }} />

<script lang="ts">
  import MenuStyles from '../foundations/MenuStyles.svelte'
  import PixelStyles from '../foundations/PixelStyles.svelte'
  import GlobalSettings from '../settings/GlobalSettings.svelte'
  import type { ExtensionSettingsModel, GlobalSettingsIntent } from '../types.js'

  /** The extension's toolbar popup: the settings that apply to every Wplace tab. */
  let { model }: { model?: ExtensionSettingsModel } = $props()
  const element: HTMLElement = $host()
  const emit = (detail: GlobalSettingsIntent): void => {
    element.dispatchEvent(new CustomEvent('caelestis-extension-settings-intent', { detail, bubbles: true, composed: true }))
  }
</script>

<MenuStyles />

{#if model !== undefined}
  <div class="settings">
    <p class="version">Extension {model.version}</p>
    {#each ['notifications', 'contribution', 'painters', 'wplace-performance', 'diagnostics', 'accessibility'] as const as section}
      <GlobalSettings {section} {model} onIntent={emit} />
    {/each}
  </div>
{/if}

<PixelStyles />

<style>
  :host { display: block; }
  .settings { padding-block-end: 0.75rem; color: var(--caelestis-text); font: 400 0.875rem/1.35 var(--caelestis-font, ui-sans-serif, system-ui, sans-serif); }
  .version { margin: 0.6rem var(--caelestis-content-inset, 1rem) 0; color: var(--caelestis-muted-text); font-size: 0.72rem; }
</style>
