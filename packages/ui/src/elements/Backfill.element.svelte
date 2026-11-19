<svelte:options customElement={{ shadow: 'open', props: { model: { type: 'Object' } } }} />
<script lang="ts">
  import Backfill from '../backfill/Backfill.svelte'
  import PixelStyles from '../foundations/PixelStyles.svelte'
  import type { BackfillModel } from '../backfill/model.js'
  import { intentEmitter } from './registry.js'
  let { model }: { model: BackfillModel } = $props()
  const emit = intentEmitter($host(), 'caelestis-backfill')
</script>
<Backfill {model} onIntent={emit} />
<PixelStyles />

<style>:host { display: block; }</style>
