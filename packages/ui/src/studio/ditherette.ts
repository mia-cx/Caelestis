/**
 * The studio's one link to Ditherette: the types it edits, and the limits the package enforces
 * (`isEffect` rejects a step past any of them, per its `validation-effects`).
 */
export type {
  BrightnessContrastEffect,
  ColourChannel,
  Curve,
  CurveGrid,
  CurvePoints,
  CurvesEffect,
  Effect,
  EffectChannel,
  ExposureEffect,
  FitLook,
  HueSaturationEffect,
  LevelsEffect,
  MaskCurve,
  OneInputCurve,
  OneInputMaskCurve,
  PaletteFitEffect,
  PaletteFitSpace,
  ResizeAnchor,
  TwoInputCurve,
} from 'ditherette'

/** Steps in one effect pipeline. */
export const MAX_EFFECT_LAYERS = 64
/** Curves in one curves step. */
export const MAX_CURVES = 16
/** Points on one curve. */
export const MAX_CURVE_POINTS = 16
/** Curves in one step's mask. */
export const MAX_MASK_CURVES = 4
/** Columns in one two-input curve's grid. */
export const MAX_GRID_COLUMNS = 48
/** The smallest step between neighbouring curve points or grid columns. */
export const MIN_CURVE_GAP = 0.001
