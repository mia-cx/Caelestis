<svelte:options customElement={{ shadow: 'open', props: { model: { type: 'Object' } } }} />

<script lang="ts">
  import { resolveShortcutBindings } from '@caelestis/shared'
  import PixelStyles from '../foundations/PixelStyles.svelte'
  import ShortcutHelp from '../shortcut-help/ShortcutHelp.svelte'
  import type { ShortcutHelpModel } from '../shortcut-help/model.js'
  import { intentEmitter } from './registry.js'

  const DEFAULT_MODEL: ShortcutHelpModel = { platform: 'windows-linux', bindings: resolveShortcutBindings(), simulatedInput: {} }
  let { model = DEFAULT_MODEL }: { model?: ShortcutHelpModel } = $props()
  const emit = intentEmitter($host(), 'caelestis-shortcut-help')
</script>

<ShortcutHelp {model} onIntent={emit} />

<PixelStyles />

<style>:host { display: block; }</style>
