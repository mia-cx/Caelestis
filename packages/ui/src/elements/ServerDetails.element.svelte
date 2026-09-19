<svelte:options customElement={{ shadow: 'open', props: { model: { type: 'Object' } } }} />
<script lang="ts">
  import ServerDetails from '../server-details/ServerDetails.svelte'
  import type { ServerDetailsIntent, ServerDetailsModel } from '../types.js'
  let { model }: { model: ServerDetailsModel } = $props()
  const element: HTMLElement = $host()
  const emit = (detail: ServerDetailsIntent): void => { element.dispatchEvent(new CustomEvent('caelestis-server-details-intent', { detail, bubbles: true, composed: true })) }
</script>
<ServerDetails {model} onIntent={emit} />
<style>:host { display: block; }</style>
