<!--
  Swaps FalseType for the system font, for readers who find the pixel font hard to read. The choice
  is remembered, and FONT_SCRIPT applies it before first paint.
-->
<script module lang="ts">
  /** localStorage key for the reader's choice. Absent means FalseType. */
  const FONT_KEY = 'caelestis:font'
  /** Class on `<html>` that swaps FalseType for the system font. */
  const PLAIN_FONT = 'plain-font'

  /** Inline `<head>` script that applies a stored plain-font choice before first paint. */
  export const FONT_SCRIPT = `(()=>{try{if(localStorage.getItem(${JSON.stringify(FONT_KEY)})==='plain')document.documentElement.classList.add(${JSON.stringify(PLAIN_FONT)})}catch{}})()`
</script>

<script lang="ts">
  import CaseSensitive from '@lucide/svelte/icons/case-sensitive'

  let plain = $state(document.documentElement.classList.contains(PLAIN_FONT))
  const label = $derived(plain ? 'Use the pixel font' : 'Use a plain font')

  function toggle() {
    plain = !plain
    document.documentElement.classList.toggle(PLAIN_FONT, plain)
    try {
      if (plain) localStorage.setItem(FONT_KEY, 'plain')
      else localStorage.removeItem(FONT_KEY)
    } catch {
      // Private browsing: the choice lasts for this page only.
    }
  }
</script>

<button class="sv-icon-button font-toggle" type="button" onclick={toggle} aria-label={label} title={label}>
  <CaseSensitive aria-hidden="true" />
</button>

<style>
  /* Desktop: the header is a grid, and the toggle shares the colour switch's cell, just before it. */
  .font-toggle {
    grid-area: 1 / 3;
    justify-self: end;
    margin-inline-end: calc(2rem + var(--sv-space-2));
  }

  :global(.wiki-header .header-inner > .sv-color-mode) {
    grid-area: 1 / 3;
  }

  /* Phone and tablet, at the wiki theme's breakpoint: the header is a flex row. */
  @media (max-width: 56rem) {
    .font-toggle {
      margin-inline: auto 0;
    }

    :global(.wiki-header .header-inner > .font-toggle + .sv-color-mode) {
      margin-inline-start: 0;
    }
  }
</style>
