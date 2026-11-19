<svelte:options customElement={{ shadow: 'open', props: { model: { type: 'Object' } } }} />
<script lang="ts">
  import TagManager from '../tags/TagManager.svelte'
  import PixelStyles from '../foundations/PixelStyles.svelte'
  import type { TagManagerModel } from '../tags/model.js'
  import { intentEmitter } from './registry.js'
  let { model }: { model?: TagManagerModel } = $props()
  const emit = intentEmitter($host(), 'caelestis-tag-manager')
</script>
{#if model}<TagManager {model} onIntent={emit} />{/if}
<PixelStyles />

<style>:host { display: block; }</style>
