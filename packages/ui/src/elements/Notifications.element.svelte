<svelte:options customElement={{ shadow: 'open', props: { model: { type: 'Object' } } }} />

<script lang="ts">
  import Notifications from '../notifications/Notifications.svelte'
  import PixelStyles from '../foundations/PixelStyles.svelte'
  import type { NotificationsModel } from '../notifications/model.js'
  import { intentEmitter } from './registry.js'

  const EMPTY_MODEL = { toasts: [], confirm: null } as const
  let { model = EMPTY_MODEL }: { model?: NotificationsModel } = $props()
  const emit = intentEmitter($host(), 'caelestis-notifications')
</script>

<Notifications {model} onIntent={emit} />

<PixelStyles />

<style>
  :host { display: contents; }
</style>
