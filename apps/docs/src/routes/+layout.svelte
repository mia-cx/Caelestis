<script lang="ts">
  import { afterNavigate } from '$app/navigation'
  import { mount } from 'svelte'
  import FontToggle, { FONT_SCRIPT } from '$lib/FontToggle.svelte'
  import '../caelestis.css'

  let { children } = $props()

  // The wiki theme's header has no slot, so the font toggle joins it beside the colour mode switch.
  // Checking after every navigation adds it again if the theme renders a fresh header.
  afterNavigate(() => {
    const colorMode = document.querySelector('.wiki-header .sv-color-mode')
    if (!colorMode?.parentElement || colorMode.previousElementSibling?.classList.contains('font-toggle')) return
    mount(FontToggle, { target: colorMode.parentElement, anchor: colorMode })
  })
</script>

<svelte:head>
  {@html `<script>${FONT_SCRIPT}</script>`}
</svelte:head>

{@render children()}
