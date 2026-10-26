<script lang="ts">
  import { afterNavigate } from '$app/navigation'
  import { mount, onDestroy, unmount } from 'svelte'
  import FontToggle, { FONT_SCRIPT } from '$lib/FontToggle.svelte'
  import '../caelestis.css'

  let { children } = $props()

  // The wiki theme's header has no slot, so the font toggle joins it beside the colour mode switch.
  // Pages and the error page render separate headers, so each navigation moves the toggle to the
  // current one and unmounts the copy in the header that was replaced.
  let toggle: { instance: ReturnType<typeof mount>; colorMode: Element } | undefined

  function removeToggle() {
    if (toggle) void unmount(toggle.instance)
    toggle = undefined
  }

  afterNavigate(() => {
    const colorMode = document.querySelector('.wiki-header .sv-color-mode')
    if (toggle?.colorMode === colorMode) return
    removeToggle()
    if (!colorMode?.parentElement) return
    toggle = { instance: mount(FontToggle, { target: colorMode.parentElement, anchor: colorMode }), colorMode }
  })

  onDestroy(removeToggle)
</script>

<svelte:head>
  {@html `<script>${FONT_SCRIPT}</script>`}
</svelte:head>

{@render children()}
