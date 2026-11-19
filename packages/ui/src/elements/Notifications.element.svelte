<svelte:options customElement={{ shadow: 'open', props: { model: { type: 'Object' } } }} />

<script lang="ts">
  import Notifications from '../notifications/Notifications.svelte'
  import PixelStyles from '../foundations/PixelStyles.svelte'
  import type { NotificationsModel } from '../notifications/model.js'
  import { intentEmitter } from './registry.js'

  let { model }: { model?: NotificationsModel } = $props()
  const emit = intentEmitter($host(), 'caelestis-notifications')
</script>

{#if model}<Notifications {model} onIntent={emit} />{/if}

<PixelStyles />

<style>
  :host { display: contents; }
</style>
