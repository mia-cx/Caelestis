<script lang="ts">
  /**
   * How a painter reaches a line that does not touch their territory yet: draft a chain out from
   * it, then crawl, adding at the head and removing at the tail, until the chain sits on the line,
   * then draft the rest of the line. Loops; holds still under reduced motion.
   */
  let { colour }: { colour: string } = $props()

  const COLUMNS = 16
  const TERRITORY = 3
  const LINE_START = 11
  const CELL = 12
  const STEP_MS = 160
  const PAUSE_STEPS = 8

  /** Drafted cells per step, as [tail, head] columns on the middle row. */
  const frames: (readonly [number, number])[] = []
  for (let head = TERRITORY; head <= 7; head++) frames.push([TERRITORY, head])
  for (let head = 8; head <= LINE_START; head++) frames.push([head - 4, head])
  for (let tail = LINE_START - 3; tail <= LINE_START; tail++) frames.push([tail, LINE_START])
  for (let head = LINE_START + 1; head < COLUMNS; head++) frames.push([LINE_START, head])
  const last = frames.at(-1) as readonly [number, number]
  for (let pause = 0; pause < PAUSE_STEPS; pause++) frames.push(last)

  const reduced =
    typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
  let step = $state(reduced ? frames.length - 1 : 0)
  $effect(() => {
    if (reduced) return
    const timer = setInterval(() => {
      step = (step + 1) % frames.length
    }, STEP_MS)
    return () => clearInterval(timer)
  })
  const [tail, head] = $derived(frames[step] ?? last)
</script>

<svg
  class="demo"
  viewBox={`0 0 ${COLUMNS * CELL} ${3 * CELL}`}
  role="img"
  aria-label="A drafted chain grows out of your territory, crawls to your line by moving its tail up behind its head, then fills the line."
>
  {#each { length: TERRITORY } as _, x}
    {#each { length: 3 } as _, y}
      <rect class="territory" x={x * CELL} y={y * CELL} width={CELL} height={CELL} />
    {/each}
  {/each}
  <rect
    class="line"
    x={LINE_START * CELL + 1}
    y={CELL + 1}
    width={(COLUMNS - LINE_START) * CELL - 2}
    height={CELL - 2}
    style:stroke={colour}
  />
  {#each { length: head - tail + 1 } as _, offset}
    <rect class="draft" x={(tail + offset) * CELL + 1} y={CELL + 1} width={CELL - 2} height={CELL - 2} style:fill={colour} />
  {/each}
</svg>

<style>
  .demo { display: block; inline-size: 100%; block-size: auto; }
  .territory { fill: #10b860; }
  .line { fill: none; stroke-width: 2; stroke-dasharray: 3 2; }
  .draft { stroke: rgb(0 0 0 / 0.7); stroke-width: 1; }
</style>
