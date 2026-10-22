import {
  type DitheretteTemplateRecipe,
  MAX_TEMPLATE_RECIPE_PIXELS,
  MAX_TEMPLATE_SOURCE_BYTES,
  sha256Hex,
  TEMPLATE_PROCESSORS,
  TEMPLATE_RECIPE_FORMAT,
  type TemplateRecipe,
  type TemplateSurface,
  TRANSPARENT_INDEX,
  uuidV7,
  WORLD_PIXELS,
  WPLACE_PALETTE,
} from '@caelestis/shared'
import {
  TEMPLATE_EDITOR_TAG,
  type TemplateEditorDither,
  type TemplateEditorIntent,
  type TemplateEditorMatching,
  type TemplateEditorModel,
  type TemplateEditorPaletteScope,
  type TemplateEditorRect,
  type TemplateEditorResize,
  type TemplateEditorTool,
} from '@caelestis/ui/elements'
import { cancelSurfaceClose, closeSurface, openSurface } from '@caelestis/ui/motion'
import type { RecipeV1 } from 'ditherette'
import { warn } from '../debug.js'
import { viewportCentre } from '../main.js'
import { ditheretteAvailable, runDitherette } from '../templates/ditherette.js'
import {
  decodeToRgba,
  type ImportedTemplate,
  MAX_TEMPLATE_NAME_LENGTH,
  processRecipe,
} from '../templates/import.js'
import { setTemplateDraft } from '../templates/local-store.js'
import {
  beginDraftPlacement,
  endDraftPlacement,
  isMoving,
  syncDraftPlacement,
} from '../templates/move.js'
import { presetColours } from '../ui/colours.js'
import { confirmDestructive } from '../ui/confirm.js'
import { applyWplaceTheme } from '../ui/theme.js'
import { loadAccount } from '../wplace-account.js'

/**
 * The template editor: one workspace over the live map.
 *
 * An image from a file, the clipboard, or a URL becomes a PNG source. Every crop, size, palette,
 * matching, and dither change reruns Ditherette on it, latest settings first, and the result draws
 * on the map as an unsaved draft the author drags into place. Save hands the artwork, its source,
 * and its recipe to the caller; Cancel discards the draft and writes nothing anywhere.
 */

/** What Save does with the finished template. */
export type TemplateEditorTarget =
  | {
      readonly kind: 'create'
      /** Where the template will appear, for the Save button's context. */
      readonly destination: string
      readonly surface: TemplateSurface
      /** Admit the placed template. False keeps the editor open. */
      readonly save: (template: ImportedTemplate) => Promise<boolean>
    }
  | {
      readonly kind: 'replace'
      /** The template being replaced, and the server everyone sees it on. */
      readonly name: string
      readonly server: string
      readonly surface: TemplateSurface
      /** A new version must keep the template's size. */
      readonly width: number
      readonly height: number
      readonly origin: { readonly x: number; readonly y: number }
      /** Upload the new version. False keeps the editor open. */
      readonly save: (template: ImportedTemplate) => Promise<boolean>
    }

interface Source {
  readonly name: string
  /** The PNG a recipe names. Imported PNGs keep their bytes; other images are re-encoded once. */
  readonly png: Blob
  readonly sha256: string
  readonly image: { readonly width: number; readonly height: number; readonly data: Uint8Array }
  readonly url: string
}

interface Processed {
  readonly recipe: TemplateRecipe
  readonly indices: Uint8Array
  readonly opaque: number
}

/** Settings rerun processing after this long without another change, so a drag stays smooth. */
const SETTLE_MS = 120
const MAX_SOURCE_BYTES = 64 * 1024 * 1024
const DEFAULT_THRESHOLD = 128
const DEFAULT_DITHER: TemplateEditorDither = {
  method: 'none',
  size: '4',
  strength: 1,
  serpentine: true,
}
const FIELD_STRENGTH = 0.5
const DIFFUSION_KERNELS = ['floyd-steinberg', 'atkinson', 'sierra', 'sierra-lite'] as const
const SCOPES: readonly TemplateEditorPaletteScope[] = ['owned', 'free', 'premium', 'all']
const EDITOR_ID = 'caelestis-template-editor'

let target: TemplateEditorTarget | null = null
let element: (HTMLElement & { model: TemplateEditorModel }) | null = null
let closing: HTMLElement | null = null
let draftId = ''

let tool: TemplateEditorTool | null = null
let name = ''
let source: Source | null = null
let loadingSource = false
/** The latest image request. An older one that finishes later is dropped. */
let sourceTicket = 0
let crop: TemplateEditorRect = { x: 0, y: 0, width: 1, height: 1 }
let size = { width: 1, height: 1 }
let keepProportions = true
let resize: TemplateEditorResize = 'area'
let origin = { x: 0, y: 0 }
let palette: readonly number[] = []
/** Until the author picks colours, the palette follows the account's as they load. */
let paletteChosen = false
let matching: TemplateEditorMatching = 'oklab-euclidean'
let threshold = DEFAULT_THRESHOLD
let dither: TemplateEditorDither = DEFAULT_DITHER
let limited = false
let processing: TemplateEditorModel['processing'] = { state: 'idle' }
let processed: Processed | null = null
let pending = false
let message: string | undefined
let settleTimer: ReturnType<typeof setTimeout> | null = null
let job: AbortController | null = null

export const isTemplateEditorOpen = (): boolean => target !== null

/* Model. */

const hex = (rgb: readonly [number, number, number]): string =>
  `#${rgb.map((channel) => channel.toString(16).padStart(2, '0')).join('')}`

const DRAWABLE = WPLACE_PALETTE.filter((colour) => colour.index !== TRANSPARENT_INDEX)

const sameColours = (left: readonly number[], right: readonly number[]): boolean =>
  left.length === right.length && left.every((index, position) => index === right[position])

const currentScope = (): TemplateEditorPaletteScope | null =>
  SCOPES.find((scope) => sameColours(presetColours(scope), palette)) ?? null

/** The editor's state as the element draws it. */
export const templateEditorModel = (): TemplateEditorModel => {
  const selected = new Set(palette)
  return {
    target:
      target?.kind === 'replace'
        ? { kind: 'replace', template: target.name }
        : { kind: 'create', destination: target?.destination ?? '' },
    tool,
    name,
    source:
      source === null
        ? null
        : {
            name: source.name,
            width: source.image.width,
            height: source.image.height,
            url: source.url,
          },
    loadingSource,
    crop,
    size: {
      width: size.width,
      height: size.height,
      keepProportions,
      locked: target?.kind === 'replace',
      resize,
    },
    origin,
    palette: {
      scope: currentScope(),
      colours: DRAWABLE.map((colour) => ({
        index: colour.index,
        name: colour.name,
        hex: hex(colour.rgb),
        kind: colour.kind,
        selected: selected.has(colour.index),
      })),
    },
    matching,
    threshold,
    dither,
    limited,
    processing,
    pending,
    ...(message === undefined ? {} : { message }),
  }
}

const render = (): void => {
  if (element !== null) element.model = templateEditorModel()
}

/* Recipe. */

const resizeRecipe = (): RecipeV1['output']['resize'] => {
  switch (resize) {
    case 'area':
      return { algorithm: 'area' }
    case 'lanczos3':
      return { algorithm: 'lanczos3', anchor: 'center', support: 'scale-aware' }
    default:
      return { algorithm: resize, anchor: 'center' }
  }
}

const ditherRecipe = (): RecipeV1['dither'] => {
  const everywhere = { mode: 'everywhere' } as const
  const { method } = dither
  switch (method) {
    case 'none':
      return { family: 'none' }
    case 'yliluoma':
      return { family: 'yliluoma', size: dither.size, placement: everywhere }
    case 'bayer':
    case 'blue-noise':
      return {
        family: 'separable',
        perturb: {
          field:
            method === 'bayer'
              ? { algorithm: 'bayer', size: dither.size }
              : { algorithm: 'blue-noise' },
          space: 'oklab',
          strength: dither.strength,
          placement: everywhere,
        },
      }
    default:
      return {
        family: 'diffusion',
        kernel: method,
        feedback: 'srgb-bytes',
        strength: dither.strength,
        serpentine: dither.serpentine,
        placement: everywhere,
      }
  }
}

/** The recipe the current settings describe, for the loaded source. */
const currentRecipe = (loaded: Source): TemplateRecipe => {
  const base = {
    format: TEMPLATE_RECIPE_FORMAT,
    source: { sha256: loaded.sha256, width: loaded.image.width, height: loaded.image.height },
    palette: [...palette],
  } as const
  // Without Ditherette, the plain importer's exact nearest colour still makes usable artwork.
  if (limited)
    return {
      ...base,
      processor: 'caelestis-nearest',
      processorVersion: TEMPLATE_PROCESSORS['caelestis-nearest'],
      width: loaded.image.width,
      height: loaded.image.height,
      colorMetric: 'rgb',
      dithering: false,
      legacyDecode: false,
    }
  const recipe: DitheretteTemplateRecipe = {
    ...base,
    processor: 'ditherette',
    processorVersion: TEMPLATE_PROCESSORS.ditherette,
    crop,
    width: size.width,
    height: size.height,
    ditherette: {
      version: 1,
      output: { width: size.width, height: size.height, resize: resizeRecipe() },
      alpha: { mode: 'preserve', threshold },
      match: matching,
      dither: ditherRecipe(),
    },
  }
  return recipe
}

/* Processing: latest settings win, and the draft follows. */

const clearProcessing = (): void => {
  if (settleTimer !== null) clearTimeout(settleTimer)
  settleTimer = null
  job?.abort()
  job = null
}

const showDraft = (result: Processed): void => {
  if (target === null) return
  setTemplateDraft(
    {
      id: draftId,
      name,
      source: 'image',
      originX: origin.x,
      originY: origin.y,
      width: result.recipe.width,
      height: result.recipe.height,
      indices: result.indices,
      moved: 0,
      opaque: result.opaque,
    },
    target.surface,
  )
  syncDraftPlacement()
}

const process = async (): Promise<void> => {
  const loaded = source
  if (loaded === null || target === null) return
  clearProcessing()
  const controller = new AbortController()
  job = controller
  const recipe = currentRecipe(loaded)
  processing = { state: 'working', progress: null }
  render()
  try {
    const artwork =
      recipe.processor === 'ditherette'
        ? await runDitherette({
            recipe,
            source: { key: loaded.sha256, image: loaded.image },
            signal: controller.signal,
            onProgress: (progress) => {
              if (job !== controller || progress.total === undefined || progress.total === 0) return
              processing = {
                state: 'working',
                progress: (progress.completed ?? 0) / progress.total,
              }
              render()
            },
          })
        : await processRecipe(loaded.png, recipe, { originX: origin.x, originY: origin.y })
    if (job !== controller) return
    job = null
    processed = { recipe, indices: artwork.indices, opaque: artwork.opaque }
    const colours = new Set(artwork.indices)
    colours.delete(TRANSPARENT_INDEX)
    processing = { state: 'ready', pixels: artwork.opaque, colours: colours.size }
    clampOrigin()
    showDraft(processed)
  } catch (error) {
    if (job !== controller || controller.signal.aborted) return
    job = null
    processing = { state: 'failed', message: `Could not process this image: ${reason(error)}.` }
  }
  render()
}

/** Rerun processing once settings stop changing. */
const reprocess = (): void => {
  if (source === null) return
  clearProcessing()
  processing = { state: 'working', progress: null }
  settleTimer = setTimeout(() => {
    settleTimer = null
    void process()
  }, SETTLE_MS)
}

const reason = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).replace(/\.$/, '')

/* Sources. */

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10]

const isPng = async (blob: Blob): Promise<boolean> => {
  const head = new Uint8Array(await blob.slice(0, PNG_SIGNATURE.length).arrayBuffer())
  return PNG_SIGNATURE.every((value, index) => head[index] === value)
}

/** Any image the browser can decode, as a PNG. PNGs keep their own bytes. */
const asPng = async (blob: Blob): Promise<Blob> => {
  if (await isPng(blob)) return blob
  const bitmap = await createImageBitmap(blob, {
    colorSpaceConversion: 'none',
    premultiplyAlpha: 'none',
  })
  try {
    if (bitmap.width * bitmap.height > MAX_TEMPLATE_RECIPE_PIXELS)
      throw new Error('the image is too large')
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
    const context = canvas.getContext('2d', { colorSpace: 'srgb' })
    if (context === null) throw new Error('the browser could not draw it')
    context.drawImage(bitmap, 0, 0)
    return await canvas.convertToBlob({ type: 'image/png' })
  } finally {
    bitmap.close()
  }
}

/** The largest centred crop with a replacement's proportions, so it is not stretched. */
const cropToAspect = (width: number, height: number, aspect: number): TemplateEditorRect => {
  const cropWidth = Math.min(width, Math.max(1, Math.round(height * aspect)))
  const cropHeight = Math.min(height, Math.max(1, Math.round(cropWidth / aspect)))
  return {
    x: Math.floor((width - cropWidth) / 2),
    y: Math.floor((height - cropHeight) / 2),
    width: cropWidth,
    height: cropHeight,
  }
}

/** Start an image request; anything begun earlier is superseded. */
const beginLoad = (): number => {
  loadingSource = true
  message = undefined
  render()
  return ++sourceTicket
}

const loadSource = async (blob: Blob, sourceName: string, ticket = beginLoad()): Promise<void> => {
  if (target === null || pending) return
  try {
    if (blob.size > MAX_SOURCE_BYTES) throw new Error('the image is too large')
    const png = await asPng(blob)
    if (png.size > MAX_TEMPLATE_SOURCE_BYTES) throw new Error('the image is too large')
    // Decode the stored PNG itself: replaying the recipe later reads exactly these pixels.
    const decoded = await decodeToRgba(png)
    const sha256 = await sha256Hex(new Uint8Array(await png.arrayBuffer()))
    if (ticket !== sourceTicket || target === null) return
    if (source !== null) URL.revokeObjectURL(source.url)
    source = {
      name: sourceName,
      png,
      sha256,
      image: { width: decoded.width, height: decoded.height, data: decoded.pixels },
      url: URL.createObjectURL(png),
    }
    if (target.kind === 'replace') {
      crop = cropToAspect(decoded.width, decoded.height, target.width / target.height)
      size = { width: target.width, height: target.height }
    } else {
      crop = { x: 0, y: 0, width: decoded.width, height: decoded.height }
      size = { width: decoded.width, height: decoded.height }
      const centre = viewportCentre()
      if (centre !== null)
        origin = {
          x: Math.round(centre.x - decoded.width / 2),
          y: Math.round(centre.y - decoded.height / 2),
        }
      if (name === '')
        name = sourceName.replace(/\.[^.]+$/, '').slice(0, MAX_TEMPLATE_NAME_LENGTH) || 'Image'
    }
    processed = null
    loadingSource = false
    await process()
  } catch (error) {
    if (ticket !== sourceTicket) return
    message = `Could not open that image: ${reason(error)}.`
  } finally {
    if (ticket === sourceTicket) loadingSource = false
    render()
  }
}

const pasteImage = async (): Promise<void> => {
  let image: Blob | null = null
  try {
    for (const item of await navigator.clipboard.read()) {
      const type = item.types.find((candidate) => candidate.startsWith('image/'))
      if (type === undefined) continue
      image = await item.getType(type)
      break
    }
  } catch {
    message = 'Paste the image with Ctrl+V or ⌘V instead.'
    render()
    return
  }
  if (image !== null) {
    await loadSource(image, 'Pasted image')
    return
  }
  message = 'There is no image on the clipboard.'
  render()
}

const loadUrl = async (address: string): Promise<void> => {
  let url: URL
  try {
    url = new URL(address)
  } catch {
    url = new URL('invalid:')
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    message = 'Enter a web address that starts with https://.'
    render()
    return
  }
  const ticket = beginLoad()
  let blob: Blob
  try {
    const response = await fetch(url, { credentials: 'omit' })
    if (!response.ok) throw new Error(`the site answered ${response.status}`)
    blob = await response.blob()
  } catch (error) {
    if (ticket !== sourceTicket) return
    loadingSource = false
    message =
      error instanceof TypeError
        ? 'That site does not let other pages load its images. Download it, then choose the file.'
        : `Could not load that image: ${reason(error)}.`
    render()
    return
  }
  const file = decodeURIComponent(url.pathname.split('/').pop() ?? '') || url.hostname
  await loadSource(blob, file, ticket)
}

/** Ctrl/⌘+V anywhere outside a text field loads a pasted image. */
const onPaste = (event: ClipboardEvent): void => {
  if (target === null) return
  const path = event.composedPath()
  if (path.some((node) => node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement))
    return
  const file = [...(event.clipboardData?.files ?? [])].find((candidate) =>
    candidate.type.startsWith('image/'),
  )
  if (file === undefined) return
  event.preventDefault()
  void loadSource(file, file.name === '' || file.name === 'image.png' ? 'Pasted image' : file.name)
}

/* Placement and size. */

/** World placements stay on the canvas; other surfaces are bounded by the placement engine. */
const clampOrigin = (): void => {
  if (target === null || target.surface.kind !== 'world') return
  origin = {
    x: Math.min(Math.max(0, origin.x), WORLD_PIXELS - size.width),
    y: Math.min(Math.max(0, origin.y), WORLD_PIXELS - size.height),
  }
}

const setOrigin = (x: number, y: number): void => {
  origin = { x: Math.round(x), y: Math.round(y) }
  clampOrigin()
  if (processed !== null) showDraft(processed)
}

const MAX_SIDE = Math.floor(Math.sqrt(MAX_TEMPLATE_RECIPE_PIXELS))

/** Scale to a requested side, following the crop's proportions when they are kept. */
const setSize = (width: number, height: number): void => {
  let next = { width: Math.max(1, Math.round(width)), height: Math.max(1, Math.round(height)) }
  if (keepProportions) {
    const ratio = crop.width / crop.height
    next =
      next.width !== size.width
        ? { width: next.width, height: Math.max(1, Math.round(next.width / ratio)) }
        : { width: Math.max(1, Math.round(next.height * ratio)), height: next.height }
  }
  if (next.width * next.height > MAX_TEMPLATE_RECIPE_PIXELS) {
    const scale = MAX_SIDE / Math.max(next.width, next.height)
    next = {
      width: Math.max(1, Math.floor(next.width * scale)),
      height: Math.max(1, Math.floor(next.height * scale)),
    }
  }
  size = next
}

const setCrop = (next: TemplateEditorRect): void => {
  if (source === null) return
  const { width, height } = source.image
  const x = Math.min(Math.max(0, Math.round(next.x)), width - 1)
  const y = Math.min(Math.max(0, Math.round(next.y)), height - 1)
  const scaled = size.width !== crop.width || size.height !== crop.height
  const ratio = { x: size.width / crop.width, y: size.height / crop.height }
  crop = {
    x,
    y,
    width: Math.min(Math.max(1, Math.round(next.width)), width - x),
    height: Math.min(Math.max(1, Math.round(next.height)), height - y),
  }
  // An unscaled image stays at identity scale; a scaled one keeps its scale.
  if (target?.kind === 'replace') return
  if (!scaled) size = { width: crop.width, height: crop.height }
  else setSize(crop.width * ratio.x, crop.height * ratio.y)
}

/* Intents. */

/** Apply one intent from the element. */
export const handleTemplateEditorIntent = (intent: TemplateEditorIntent): void => {
  if (target === null) return
  if (pending && intent.type !== 'tool') return
  message = undefined
  switch (intent.type) {
    case 'tool':
      tool = intent.tool
      break
    case 'name':
      name = intent.name.slice(0, MAX_TEMPLATE_NAME_LENGTH)
      break
    case 'file':
      void loadSource(intent.file, intent.file.name)
      return
    case 'paste':
      void pasteImage()
      return
    case 'url':
      void loadUrl(intent.url)
      return
    case 'crop':
      setCrop(intent.crop)
      reprocess()
      break
    case 'origin':
      setOrigin(intent.x, intent.y)
      break
    case 'centre': {
      const centre = viewportCentre()
      if (centre !== null) setOrigin(centre.x - size.width / 2, centre.y - size.height / 2)
      break
    }
    case 'size':
      if (target.kind === 'replace' || limited) break
      setSize(intent.width, intent.height)
      reprocess()
      break
    case 'keep-proportions':
      keepProportions = intent.keep
      if (keepProportions) {
        setSize(size.width, Math.round(size.width / (crop.width / crop.height)))
        reprocess()
      }
      break
    case 'resize':
      resize = intent.resize
      reprocess()
      break
    case 'scope':
      palette = presetColours(intent.scope)
      paletteChosen = true
      reprocess()
      break
    case 'colour': {
      paletteChosen = true
      const next = new Set(palette)
      if (intent.selected) next.add(intent.index)
      else if (next.size > 1) next.delete(intent.index)
      palette = [...next].sort((left, right) => left - right)
      reprocess()
      break
    }
    case 'matching':
      matching = intent.matching
      reprocess()
      break
    case 'threshold':
      threshold = Math.min(255, Math.max(0, Math.round(intent.threshold)))
      reprocess()
      break
    case 'dither': {
      const method = intent.dither.method ?? dither.method
      const familyChanged =
        intent.dither.method !== undefined &&
        DIFFUSION_KERNELS.includes(method as (typeof DIFFUSION_KERNELS)[number]) !==
          DIFFUSION_KERNELS.includes(dither.method as (typeof DIFFUSION_KERNELS)[number])
      dither = {
        ...dither,
        ...intent.dither,
        // Diffusion spreads all of the error by default; noise fields start at half strength.
        ...(familyChanged && intent.dither.strength === undefined
          ? {
              strength: DIFFUSION_KERNELS.includes(method as (typeof DIFFUSION_KERNELS)[number])
                ? 1
                : FIELD_STRENGTH,
            }
          : {}),
      }
      reprocess()
      break
    }
    case 'save':
      void save()
      return
    case 'cancel':
      closeTemplateEditor()
      return
  }
  render()
}

/* Save and close. */

const save = async (): Promise<void> => {
  const current = target
  const result = processed
  const loaded = source
  if (current === null || result === null || loaded === null || pending || job !== null) return
  if (result.opaque === 0 || name.trim() === '') return
  if (current.kind === 'replace') {
    const confirmed = await confirmDestructive({
      title: `Replace “${current.name}”?`,
      body: `This image becomes its new version for everyone on ${current.server}.`,
      note: 'Earlier versions stay in its history.',
      confirmLabel: 'Replace template',
    })
    if (!confirmed || target !== current) return
  }
  pending = true
  render()
  try {
    const template: ImportedTemplate = {
      id: `local-${uuidV7()}`,
      name: name.trim(),
      source: 'image',
      sortOrder: 0,
      originX: origin.x,
      originY: origin.y,
      width: result.recipe.width,
      height: result.recipe.height,
      indices: result.indices,
      moved: 0,
      opaque: result.opaque,
      authoring: {
        source: loaded.png,
        recipe: result.recipe,
        artwork: await sha256Hex(result.indices),
      },
    }
    if (await current.save(template)) {
      if (target === current) closeTemplateEditor()
      return
    }
    message =
      current.kind === 'replace'
        ? 'The template was not replaced.'
        : 'The template was not created.'
  } catch (error) {
    message = `Could not save: ${reason(error)}.`
  } finally {
    pending = false
    render()
  }
}

const reset = (): void => {
  clearProcessing()
  if (source !== null) URL.revokeObjectURL(source.url)
  tool = null
  name = ''
  source = null
  loadingSource = false
  sourceTicket++
  crop = { x: 0, y: 0, width: 1, height: 1 }
  size = { width: 1, height: 1 }
  keepProportions = true
  resize = 'area'
  origin = { x: 0, y: 0 }
  palette = presetColours('owned')
  paletteChosen = false
  matching = 'oklab-euclidean'
  threshold = DEFAULT_THRESHOLD
  dither = DEFAULT_DITHER
  processing = { state: 'idle' }
  processed = null
  pending = false
  message = undefined
}

/** Discard the draft and every setting. Nothing was written, so nothing is undone. */
export const closeTemplateEditor = (): void => {
  if (target === null) return
  target = null
  reset()
  endDraftPlacement()
  setTemplateDraft(null)
  window.removeEventListener('paste', onPaste, true)
  const leaving = element
  element = null
  if (leaving === null) return
  closing = leaving
  closeSurface(leaving, () => {
    if (closing === leaving) closing = null
    leaving.remove()
  })
}

const mount = (): void => {
  if (closing?.isConnected && cancelSurfaceClose(closing)) {
    element = closing as HTMLElement & { model: TemplateEditorModel }
    closing = null
    openSurface(element)
    return
  }
  const created = document.createElement(TEMPLATE_EDITOR_TAG)
  created.id = EDITOR_ID
  Object.assign(created.style, {
    position: 'fixed',
    inset: '0',
    // Above the docked panel (30), below its popovers and dialogs (40), as claim mode is.
    zIndex: '31',
    pointerEvents: 'none',
  } satisfies Partial<CSSStyleDeclaration>)
  applyWplaceTheme(created)
  created.addEventListener('caelestis-template-editor-intent', (event) =>
    handleTemplateEditorIntent((event as CustomEvent<TemplateEditorIntent>).detail),
  )
  document.body.appendChild(created)
  openSurface(created)
  element = created
}

/**
 * Open the editor for `next`, optionally starting from an image. False while it is already open
 * or another placement holds the map.
 */
export const openTemplateEditor = (
  next: TemplateEditorTarget,
  initial?: { readonly image: Blob; readonly name: string },
): boolean => {
  if (target !== null || isMoving()) return false
  reset()
  target = next
  draftId = `draft-${uuidV7()}`
  if (next.kind === 'replace') {
    name = next.name
    origin = next.origin
    size = { width: next.width, height: next.height }
  }
  tool = initial === undefined ? 'image' : null
  mount()
  render()
  window.addEventListener('paste', onPaste, true)
  // The draft must exist before placement can hold it; start with an empty one.
  setTemplateDraft(
    {
      id: draftId,
      name,
      source: 'image',
      originX: origin.x,
      originY: origin.y,
      width: 1,
      height: 1,
      indices: new Uint8Array([TRANSPARENT_INDEX]),
      moved: 0,
      opaque: 0,
    },
    next.surface,
  )
  if (
    !beginDraftPlacement((x, y) => {
      origin = { x, y }
      render()
    })
  )
    warn('install', 'the template editor could not take placement')
  void loadAccount().then(() => {
    // Owned colours arrive after the editor opens; follow them until the author picks colours.
    if (target !== next || paletteChosen) return
    const owned = presetColours('owned')
    if (sameColours(owned, palette)) return
    palette = owned
    reprocess()
    render()
  })
  void ditheretteAvailable().then((available) => {
    if (target !== next || available) return
    limited = true
    tool = tool === 'crop' || tool === 'match' || tool === 'dither' ? null : tool
    if (source !== null) {
      crop = { x: 0, y: 0, width: source.image.width, height: source.image.height }
      size = { width: source.image.width, height: source.image.height }
      reprocess()
    }
    render()
  })
  if (initial !== undefined) void loadSource(initial.image, initial.name)
  return true
}
