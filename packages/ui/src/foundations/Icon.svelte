<script lang="ts" module>
  export type { IconName } from './icons.js'
</script>

<script lang="ts">
  import { activeIcons, activeIconSet, type IconName } from './icons.js'

  let { name, size, class: className }: { name: IconName; size?: string | undefined; class?: string | undefined } = $props()
  const icon = $derived(activeIcons()[name])
  // Pixelarticons draw on a 24 unit grid in 2 unit strokes: whole pixels at multiples of 12px only.
  const crisp = $derived(activeIconSet() === 'pixel')
</script>

<!-- Iconify bodies are static markup from the package, each path already carrying fill="currentColor". -->
<svg class={className} viewBox={`0 0 ${icon.width ?? 24} ${icon.height ?? 24}`} fill="currentColor" shape-rendering={crisp ? 'crispEdges' : undefined} aria-hidden="true" style:width={size} style:height={size}>{@html icon.body}</svg>

<style>
  /* Zero-specificity default, so utility classes such as Tailwind's size-* override it. A pixel-grid host sets --icon-size. */
  :where(svg) { width: var(--icon-size, 1rem); height: var(--icon-size, 1rem); flex-shrink: 0; }
</style>
