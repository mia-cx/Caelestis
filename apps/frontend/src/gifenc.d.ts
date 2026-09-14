declare module 'gifenc/dist/gifenc.esm.js' {
  export function quantize(rgba: Uint8Array, maxColors: number): number[][]
  export function applyPalette(rgba: Uint8Array, palette: number[][]): Uint8Array
  export function GIFEncoder(): {
    writeFrame(
      indices: Uint8Array,
      width: number,
      height: number,
      options: {
        palette?: number[][]
        repeat?: number
        delay?: number
        dispose?: number
        transparent?: boolean
        transparentIndex?: number
      },
    ): void
    finish(): void
    bytes(): Uint8Array
  }
}
