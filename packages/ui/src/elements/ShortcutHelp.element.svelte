<svelte:options customElement={{ shadow: 'open', props: { model: { type: 'Object' } } }} />

<script lang="ts">
  import PixelStyles from '../foundations/PixelStyles.svelte'
  import ShortcutHelp from '../shortcut-help/ShortcutHelp.svelte'
  import type { ShortcutHelpModel } from '../shortcut-help/model.js'
  import { intentEmitter } from './registry.js'

  let { model }: { model?: ShortcutHelpModel } = $props()
  const emit = intentEmitter($host(), 'caelestis-shortcut-help')
</script>

{#if model}<ShortcutHelp {model} onIntent={emit} />{/if}

<PixelStyles />

<style>:host { display: block; }</style>
