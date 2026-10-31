<script lang="ts">
  /** Draws a scope's painted density, smoothly scaled to fill its box. Nothing reads it back. */
  let { image }: { image: ImageData } = $props()

  let canvas = $state<HTMLCanvasElement>()
  let width = $state(0)
  let height = $state(0)

  const bitmap = $derived.by(() => {
    const scratch = document.createElement('canvas')
    scratch.width = image.width
    scratch.height = image.height
    scratch.getContext('2d')?.putImageData(image, 0, 0)
    return scratch
  })

  $effect(() => {
    const target = canvas
    if (target === undefined) return
    const observer = new ResizeObserver(() => {
      const ratio = window.devicePixelRatio || 1
      width = Math.round(target.clientWidth * ratio)
      height = Math.round(target.clientHeight * ratio)
    })
    observer.observe(target)
    return () => observer.disconnect()
  })

  $effect(() => {
    if (canvas === undefined || !width || !height) return
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d')
    if (context === null) return
    context.imageSmoothingEnabled = true
    context.imageSmoothingQuality = 'high'
    context.drawImage(bitmap, 0, 0, width, height)
  })
</script>

<canvas bind:this={canvas} aria-hidden="true"></canvas>

<style>
  canvas { position: absolute; inset: 0; inline-size: 100%; block-size: 100%; }
</style>
