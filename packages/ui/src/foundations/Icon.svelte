<script lang="ts" module>
  export type { IconName } from './icons.js'
</script>

<script lang="ts">
  import { ICONS, type IconName } from './icons.js'

  let { name, size, class: className }: { name: IconName; size?: string | undefined; class?: string | undefined } = $props()
  const icon = $derived(ICONS[name])
</script>

<!-- Iconify bodies are static markup from the package, each path already carrying fill="currentColor". -->
<!-- Pixelarticons draw on a 24 unit grid in 2 unit strokes: whole pixels at 12px and 24px, blur at anything else. -->
<svg class={className} viewBox={`0 0 ${icon.width ?? 24} ${icon.height ?? 24}`} fill="currentColor" shape-rendering="crispEdges" aria-hidden="true" style:width={size} style:height={size}>{@html icon.body}</svg>

<style>
  /* Zero-specificity default, so utility classes such as Tailwind's size-* override it. */
  :where(svg) { width: 0.75rem; height: 0.75rem; flex-shrink: 0; }
</style>
