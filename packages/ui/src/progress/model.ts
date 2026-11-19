/** Painted, mismatched, unpainted and scanned pixel counts, as `ProgressMeter` draws them. */
export interface ProgressModel {
  readonly completed: number
  readonly mismatched: number
  readonly unpainted: number
  readonly known: number
  readonly total: number
}

export interface PaletteProgressModel {
  readonly value: string
}
