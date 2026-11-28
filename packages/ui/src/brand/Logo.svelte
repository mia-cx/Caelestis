<script lang="ts">
  import { CAELESTIS_LOGO, CAELESTIS_LOGO_PX } from './logo.js'

  /** `scale` is a whole multiple of the 16px art, so every art pixel stays square. */
  let { scale = 2 }: { scale?: number } = $props()
  const size = $derived(`${CAELESTIS_LOGO_PX * scale}px`)
</script>

<!-- Decorative: the control or heading beside it carries the name. -->
<img src={CAELESTIS_LOGO} alt="" draggable="false" style:inline-size={size} style:block-size={size} />

<style>
  img { display: block; flex-shrink: 0; image-rendering: pixelated; pointer-events: none; }
</style>
