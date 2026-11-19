<svelte:options customElement={{ shadow: 'open', props: { model: { type: 'Object' } } }} />
<script lang="ts">
  import ServerDetails from '../server-details/ServerDetails.svelte'
  import PixelStyles from '../foundations/PixelStyles.svelte'
  import type { ServerDetailsModel } from '../server-details/model.js'
  import { intentEmitter } from './registry.js'
  let { model }: { model: ServerDetailsModel } = $props()
  const emit = intentEmitter($host(), 'caelestis-server-details')
</script>
<ServerDetails {model} onIntent={emit} />
<PixelStyles />

<style>:host { display: block; }</style>
