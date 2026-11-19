import type { TemplateSurface } from '@caelestis/shared'
import { onlySelectedColourFor } from '../settings.js'
import { type Appearance, toRgbUnit } from '../templates/appearance.js'
import { type BatchableMarkerWork, batchMarkerWork, type MarkerBatch } from './marker-batching.js'
import { markerSampleRate } from './marker-density.js'
import type { MarkerStyle } from './marker-renderer.js'

/**
 * One frame of markers, the same way on the world map and an alliance artboard: how a template's
 * markers look, and how many of them the viewport budget draws. Hosts supply only where each batch
 * lands.
 */

const MARKER_THICKNESS = 2

/**
 * A template's two marker looks: its mismatches, and the remaining pixels of the colour selected
 * in Wplace's paint drawer (null while it is closed).
 */
export const markerStyles = (
  appearance: Appearance,
  surface: TemplateSurface,
  selected: number | null,
): { readonly mismatch: MarkerStyle; readonly selected: MarkerStyle } => ({
  mismatch: {
    size: appearance.markerSize,
    thickness: MARKER_THICKNESS,
    colour: toRgbUnit(appearance.markerColour),
    // One switch above both: off means every marker is drawn the same, and the fade and the second
    // colour keep their values for whenever it goes back on.
    otherColour:
      !appearance.dimOthers || appearance.otherColour === null
        ? null
        : toRgbUnit(appearance.otherColour),
    otherOpacity: appearance.dimOthers ? appearance.otherOpacity : 1,
    selected: onlySelectedColourFor(surface) && selected !== null ? selected : -1,
  },
  selected: {
    size: appearance.selectedMarkerSize,
    thickness: MARKER_THICKNESS,
    colour: toRgbUnit(appearance.selectedMarkerColour),
    otherColour: null,
    otherOpacity: 1,
    selected: -1,
  },
})

/**
 * Batch the frame's marker work and thin each kind to the viewport budget, counted on the points
 * `visiblePoints` says are on screen. Selected-colour markers come first: the selected colour is a
 * guide, a real mismatch is the error signal, and it wins where they meet.
 */
export const budgetMarkers = <Work extends BatchableMarkerWork>(
  selected: readonly Work[],
  mismatch: readonly Work[],
  visiblePoints: (work: Work) => number,
  budget: number,
) => {
  const rate = (work: readonly Work[]): number =>
    markerSampleRate(
      work.reduce((total, one) => total + visiblePoints(one), 0),
      budget,
    )
  const selectedSampleRate = rate(selected)
  const mismatchSampleRate = rate(mismatch)
  const sampled = (work: readonly Work[], sampleRate: number) =>
    batchMarkerWork(work).map((batch): MarkerBatch<Work> & { readonly sampleRate: number } => ({
      ...batch,
      sampleRate,
    }))
  return {
    selectedSampleRate,
    mismatchSampleRate,
    batches: [...sampled(selected, selectedSampleRate), ...sampled(mismatch, mismatchSampleRate)],
  }
}
