<!--
  The theme values every custom element starts from, declared once on its host. A host theme
  overrides any of them inline (the userscript paints radius and fonts per Wplace style), and the
  motion scale is the transitions.dev one, prefixed so Tailwind's own --ease-* never shadows it.
-->
<style>
  :global(:host) {
    --caelestis-radius: calc(0.7rem + 1px);
    --caelestis-pill-radius: 999px;
    --caelestis-font: ui-sans-serif, system-ui, sans-serif;
    --caelestis-mono-font: ui-monospace, monospace;
    --caelestis-touch-target: 2.5rem;
    --caelestis-duration-stagger: 40ms;
    --caelestis-duration-micro: 80ms;
    --caelestis-duration-quick: 150ms;
    --caelestis-duration-fast: 250ms;
    --caelestis-duration-medium: 350ms;
    --caelestis-ease-smooth-out: cubic-bezier(0.22, 1, 0.36, 1);
    --caelestis-ease-bounce: cubic-bezier(0.34, 1.36, 0.64, 1);
    --caelestis-distance-micro: 4px;
    --caelestis-distance-small: 6px;
    --caelestis-distance-base: 8px;
    --caelestis-distance-medium: 12px;
    --caelestis-distance-large: 30px;
    --caelestis-scale-large: 0.96;
    --caelestis-scale-medium: 0.97;
    --caelestis-scale-small: 0.98;
    --caelestis-scale-tiny: 0.99;
    --caelestis-blur-small: 2px;
  }
</style>
