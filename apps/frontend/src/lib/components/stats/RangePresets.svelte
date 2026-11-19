<script lang="ts">
  /**
   * The chart's range presets as a segmented control. JS measures the active button and writes its
   * offset and width onto the pill; CSS owns the tween. The first paint and every re-measure snap
   * without a transition, and a window that matches no preset hides the pill instead of parking it.
   */
  let {
    presets,
    active,
    onPreset,
    onAll,
  }: {
    presets: readonly { readonly key: string; readonly label: string; readonly seconds: number }[]
    /** The active preset's key, `all` for the whole history, or null when none matches. */
    active: string | null
    onPreset: (seconds: number) => void
    onAll: () => void
  } = $props()

  let bar = $state<HTMLDivElement | null>(null)
  let pill = $state<HTMLSpanElement | null>(null)
  let pillKey: string | null | undefined

  const movePill = (tab: HTMLElement, animate: boolean): void => {
    if (pill === null) return
    const previous = pill.style.transition
    if (!animate) pill.style.transition = 'none'
    pill.style.transform = `translateX(${tab.offsetLeft}px)`
    pill.style.width = `${tab.offsetWidth}px`
    if (animate) return
    void pill.offsetWidth
    pill.style.transition = previous
  }
  const activeTab = (): HTMLElement | null =>
    active === null ? null : (bar?.querySelector<HTMLElement>(`[data-range-preset="${active}"]`) ?? null)

  $effect(() => {
    const key = active
    if (bar === null || pill === null) return
    const animate = pillKey !== undefined && pillKey !== null && pillKey !== key
    pillKey = key
    const tab = activeTab()
    if (tab !== null) movePill(tab, animate)
  })

  $effect(() => {
    if (bar === null || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      const tab = activeTab()
      if (tab !== null) movePill(tab, false)
    })
    observer.observe(bar)
    return () => observer.disconnect()
  })
</script>

<div
  class="presets"
  role="group"
  aria-label="time range"
  data-empty={active === null ? '' : undefined}
  bind:this={bar}
>
  <span class="preset-pill" aria-hidden="true" bind:this={pill}></span>
  {#each presets as preset (preset.key)}
    <button
      type="button"
      class="preset tabular-nums"
      aria-pressed={active === preset.key}
      data-range-preset={preset.key}
      title="Show {preset.label}"
      onclick={() => onPreset(preset.seconds)}
    >
      {preset.key}
    </button>
  {/each}
  <button
    type="button"
    class="preset"
    aria-pressed={active === 'all'}
    data-range-preset="all"
    title="Show the whole history"
    onclick={onAll}
  >
    all
  </button>
</div>

<style>
  /*
   * transitions.dev "Tabs sliding" (16-tabs-sliding.md): the active pill slides between options. The tunables map onto the
   * daisyUI palette so a theme swap re-skins the bar and pill with everything else. The control
   * sits on the chart's `btn-xs` scale, so the tab height and padding are the only values changed
   * from the reference snippet; the extra rules below it hide the pill while no preset matches the
   * window and give it a hairline so it still reads on the dark theme's whisper-quiet surfaces.
   */
  .presets {
    --tabs-dur: 250ms;
    --tabs-ease: cubic-bezier(0.22, 1, 0.36, 1);
    --tabs-text-muted: color-mix(in oklab, var(--color-base-content) 70%, transparent);
    --tabs-text-active: var(--color-base-content);
    --tabs-bar-bg: var(--color-base-200);
    --tabs-pill-bg: var(--color-base-100);
  }

  /* The bar is a flex container with padding for the pill
     to sit inside. Buttons sit on z-index: 1, the pill on z-index: 0,
     so labels read above the pill background. */
  .presets {
    position: relative;
    display: inline-flex;
    align-items: center;
    gap: 3px;
    padding: 3px;
    border-radius: var(--caelestis-radius);
    background: var(--tabs-bar-bg);
  }
  .preset {
    position: relative;
    appearance: none;
    border: 0;
    background: transparent;
    height: 24px;
    padding: 2px 10px;
    color: var(--tabs-text-muted);
    cursor: pointer;
    border-radius: var(--caelestis-radius);
    z-index: 1;
    transition: color var(--tabs-dur) var(--tabs-ease);
  }
  .preset:not([aria-pressed="true"]):hover,
  .preset[aria-pressed="true"] {
    color: var(--tabs-text-active);
  }

  /* The pill: width + transform are written inline by JS so
     the transition tweens between the previous and next
     measured positions. */
  .preset-pill {
    position: absolute;
    top: 3px;
    left: 0;
    height: 24px;
    width: 0;
    background: var(--tabs-pill-bg);
    border-radius: var(--caelestis-radius);
    transform: translateX(0);
    transition:
      transform var(--tabs-dur) var(--tabs-ease),
      width     var(--tabs-dur) var(--tabs-ease),
      opacity   var(--tabs-dur) var(--tabs-ease);
    will-change: transform, width;
    z-index: 0;
    pointer-events: none;
    box-shadow:
      0 0 0 1px color-mix(in oklab, var(--color-base-content) 10%, transparent),
      0 1px 2px color-mix(in oklab, var(--color-base-content) 8%, transparent);
  }
  .presets[data-empty] .preset-pill {
    opacity: 0;
  }
  .preset:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: 1px;
  }

  @media (prefers-reduced-motion: reduce) {
    .preset-pill, .preset { transition: none !important; }
  }
</style>
