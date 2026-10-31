import {
  type DitheretteTemplateRecipe,
  MAX_TEMPLATE_SOURCE_BYTES,
  sha256Hex,
  TEMPLATE_PROCESSORS,
  TEMPLATE_RECIPE_FORMAT,
  type TemplateSurface,
  TRANSPARENT_INDEX,
  uuidV7,
  WORLD_PIXELS,
} from '@caelestis/shared'
import {
  type StudioRect,
  TEMPLATE_STUDIO_TAG,
  type TemplateStudioIntent,
  type TemplateStudioModel,
} from '@caelestis/ui/elements'
import { cancelSurfaceClose, closeSurface, openSurface } from '@caelestis/ui/motion'
import { warn } from '../debug.js'
import { viewportCentre } from '../main.js'
import { getState, setState } from '../state.js'
import {
  type DitheretteEngine,
  ditheretteAvailable,
  runDitherette,
} from '../templates/ditherette.js'
import {
  decodeToRgba,
  type ImportedTemplate,
  MAX_TEMPLATE_NAME_LENGTH,
} from '../templates/import.js'
import { setTemplateDraft } from '../templates/local-store.js'
import {
  beginDraftPlacement,
  endDraftPlacement,
  isMoving,
  syncDraftPlacement,
} from '../templates/move.js'
import {
  DEFAULT_STUDIO_SETTINGS,
  type StudioSettings,
  studioRecipe,
} from '../templates/studio-recipe.js'
import { presetColours } from '../ui/colours.js'
import { confirmDestructive } from '../ui/confirm.js'
import { isPanelOpen, togglePanel } from '../ui/panel.js'
import { applyWplaceTheme } from '../ui/theme.js'
import { loadAccount } from '../wplace-account.js'

/**
 * The template studio: Ditherette web's controls over the live map.
 *
 * An image from a file, the clipboard, or a URL becomes a PNG source. Every setting reruns
 * Ditherette on it, latest settings first, and the result draws on the map as an unsaved draft
 * the author drags into place. Save hands the artwork, its source, and its recipe to the caller;
 * Cancel discards the draft and writes nothing anywhere.
 */

/** What Save does with the finished template. */
export type TemplateStudioTarget =
  | {
      readonly kind: 'create'
      /** Where the template will appear, for the Save button's context. */
      readonly destination: string
      readonly surface: TemplateSurface
      /** Admit the placed template. False keeps the studio open. */
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
      /** Upload the new version. False keeps the studio open. */
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
  readonly recipe: DitheretteTemplateRecipe
  readonly indices: Uint8Array
  readonly opaque: number
}

/** Settings rerun processing after this long without another change, so a drag stays smooth. */
const SETTLE_MS = 120
const MAX_SOURCE_BYTES = 64 * 1024 * 1024
const DEFAULT_ALPHA_THRESHOLD = 128
const STUDIO_ID = 'caelestis-template-studio'

let target: TemplateStudioTarget | null = null
let element: (HTMLElement & { model: TemplateStudioModel }) | null = null
let closing: HTMLElement | null = null
let draftId = ''
/** The panel steps aside for the studio's windows and comes back when it closes. */
let panelWasOpen = false

let name = ''
let source: Source | null = null
let loadingSource = false
/** The latest image request. An older one that finishes later is dropped. */
let sourceTicket = 0
let crop: StudioRect = { x: 0, y: 0, width: 1, height: 1 }
let settings: StudioSettings = initialSettings()
let origin = { x: 0, y: 0 }
let palette: readonly number[] = []
/** Until the author picks colours, the palette follows the account's as they load. */
let paletteChosen = false
let engine: DitheretteEngine | null = null
let processing: TemplateStudioModel['processing'] = { state: 'idle' }
let processed: Processed | null = null
let pending = false
let message: string | undefined
let settleTimer: ReturnType<typeof setTimeout> | null = null
let job: AbortController | null = null

function initialSettings(): StudioSettings {
  return {
    ...DEFAULT_STUDIO_SETTINGS,
    output: { width: 1, height: 1, resize: 'area', anchor: 'center' },
    alpha: { mode: 'preserve', threshold: DEFAULT_ALPHA_THRESHOLD, matte: 0 },
  }
}

export const isTemplateStudioOpen = (): boolean => target !== null

/* Model. */

/** Output size over crop size, measured on the crop's longer side as Ditherette web does. */
const scaleOf = (): number =>
  crop.width >= crop.height
    ? settings.output.width / crop.width
    : settings.output.height / crop.height

/** The studio's state as the element draws it. */
export const templateStudioModel = (): TemplateStudioModel => ({
  target:
    target?.kind === 'replace'
      ? { kind: 'replace', template: target.name }
      : { kind: 'create', destination: target?.destination ?? '' },
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
  output: {
    width: settings.output.width,
    height: settings.output.height,
    scale: scaleOf(),
    resize: settings.output.resize,
    anchor: settings.output.anchor,
    locked: target?.kind === 'replace',
  },
  origin,
  engine,
  processing,
  pending,
  ...(message === undefined ? {} : { message }),
  layout: getState().studioLayout,
})

const render = (): void => {
  if (element !== null) element.model = templateStudioModel()
}

/* Processing: latest settings win, and the draft follows. */

const currentRecipe = (loaded: Source): DitheretteTemplateRecipe => ({
  format: TEMPLATE_RECIPE_FORMAT,
  processor: 'ditherette',
  processorVersion: TEMPLATE_PROCESSORS.ditherette,
  source: { sha256: loaded.sha256, width: loaded.image.width, height: loaded.image.height },
  crop,
  width: settings.output.width,
  height: settings.output.height,
  palette: [...palette],
  // The studio asks for the GPU; the run records the engine that actually produced the pixels.
  engine: 'gpu',
  ditherette: studioRecipe(settings),
})

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

const reason = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).replace(/\.$/, '')

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
    const result = await runDitherette({
      recipe,
      source: { key: loaded.sha256, image: loaded.image },
      signal: controller.signal,
      onProgress: (progress) => {
        if (job !== controller || progress.total === undefined || progress.total === 0) return
        processing = { state: 'working', progress: (progress.completed ?? 0) / progress.total }
        render()
      },
    })
    if (job !== controller) return
    job = null
    engine = result.engine
    processed = {
      recipe: { ...recipe, engine: result.engine },
      indices: result.indices,
      opaque: result.opaque,
    }
    const colours = new Set(result.indices)
    colours.delete(TRANSPARENT_INDEX)
    processing = { state: 'ready', pixels: result.opaque, colours: colours.size }
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
    if (bitmap.width > WORLD_PIXELS || bitmap.height > WORLD_PIXELS)
      throw new Error('the image is larger than the canvas')
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
const cropToAspect = (width: number, height: number, aspect: number): StudioRect => {
  const cropWidth = Math.min(width, Math.max(1, Math.round(height * aspect)))
  const cropHeight = Math.min(height, Math.max(1, Math.round(cropWidth / aspect)))
  return {
    x: Math.floor((width - cropWidth) / 2),
    y: Math.floor((height - cropHeight) / 2),
    width: cropWidth,
    height: cropHeight,
  }
}

const setOutput = (patch: Partial<StudioSettings['output']>): void => {
  settings = { ...settings, output: { ...settings.output, ...patch } }
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
      setOutput({ width: target.width, height: target.height })
    } else {
      // A new image starts at identity scale, centred in view.
      crop = { x: 0, y: 0, width: decoded.width, height: decoded.height }
      setOutput({ width: decoded.width, height: decoded.height })
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
    x: Math.min(Math.max(0, origin.x), WORLD_PIXELS - settings.output.width),
    y: Math.min(Math.max(0, origin.y), WORLD_PIXELS - settings.output.height),
  }
}

const setOrigin = (x: number, y: number): void => {
  origin = { x: Math.round(x), y: Math.round(y) }
  clampOrigin()
  if (processed !== null) showDraft(processed)
}

/** Scale the crop, keeping its proportions and fitting the canvas. */
const setScale = (scale: number): void => {
  const fit = Math.min(scale, WORLD_PIXELS / Math.max(crop.width, crop.height))
  setOutput({
    width: Math.max(1, Math.round(crop.width * fit)),
    height: Math.max(1, Math.round(crop.height * fit)),
  })
}

const setCrop = (next: StudioRect): void => {
  if (source === null) return
  const { width, height } = source.image
  const scale = scaleOf()
  const x = Math.min(Math.max(0, Math.round(next.x)), width - 1)
  const y = Math.min(Math.max(0, Math.round(next.y)), height - 1)
  crop = {
    x,
    y,
    width: Math.min(Math.max(1, Math.round(next.width)), width - x),
    height: Math.min(Math.max(1, Math.round(next.height)), height - y),
  }
  // A replacement keeps its size; anything else keeps its scale.
  if (target?.kind !== 'replace') setScale(scale)
}

/* Intents. */

/** Apply one intent from the element. */
export const handleTemplateStudioIntent = (intent: TemplateStudioIntent): void => {
  if (target === null) return
  if (intent.type === 'layout') {
    setState({ studioLayout: intent.layout })
    render()
    return
  }
  if (pending) return
  message = undefined
  const locked = target.kind === 'replace'
  switch (intent.type) {
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
    case 'reset-crop':
      if (source !== null)
        setCrop({ x: 0, y: 0, width: source.image.width, height: source.image.height })
      reprocess()
      break
    case 'scale':
      if (locked || !(intent.scale > 0)) break
      setScale(intent.scale)
      reprocess()
      break
    case 'size':
      if (locked || !(intent.pixels > 0)) break
      setScale(intent.pixels / (intent.side === 'width' ? crop.width : crop.height))
      reprocess()
      break
    case 'resize':
      setOutput({ resize: intent.resize })
      reprocess()
      break
    case 'anchor':
      setOutput({ anchor: intent.anchor })
      reprocess()
      break
    case 'origin':
      setOrigin(intent.x, intent.y)
      break
    case 'centre': {
      const centre = viewportCentre()
      if (centre !== null)
        setOrigin(centre.x - settings.output.width / 2, centre.y - settings.output.height / 2)
      break
    }
    case 'save':
      void save()
      return
    case 'cancel':
      closeTemplateStudio()
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
      if (target === current) closeTemplateStudio()
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
  name = ''
  source = null
  loadingSource = false
  sourceTicket++
  crop = { x: 0, y: 0, width: 1, height: 1 }
  settings = initialSettings()
  origin = { x: 0, y: 0 }
  palette = presetColours('owned')
  paletteChosen = false
  processing = { state: 'idle' }
  processed = null
  pending = false
  message = undefined
}

/** Discard the draft and every setting. Nothing was written, so nothing is undone. */
export const closeTemplateStudio = (): void => {
  if (target === null) return
  target = null
  reset()
  endDraftPlacement()
  setTemplateDraft(null)
  window.removeEventListener('paste', onPaste, true)
  if (panelWasOpen && !isPanelOpen()) togglePanel()
  panelWasOpen = false
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
    element = closing as HTMLElement & { model: TemplateStudioModel }
    closing = null
    openSurface(element)
    return
  }
  const created = document.createElement(TEMPLATE_STUDIO_TAG) as HTMLElement & {
    model: TemplateStudioModel
  }
  created.id = STUDIO_ID
  Object.assign(created.style, {
    position: 'fixed',
    inset: '0',
    // Above the docked panel (30), below its popovers and dialogs (40), as claim mode is.
    zIndex: '31',
    pointerEvents: 'none',
  } satisfies Partial<CSSStyleDeclaration>)
  applyWplaceTheme(created)
  created.addEventListener('caelestis-template-studio-intent', (event) =>
    handleTemplateStudioIntent((event as CustomEvent<TemplateStudioIntent>).detail),
  )
  document.body.appendChild(created)
  openSurface(created)
  element = created
}

/**
 * Open the studio for `next`, optionally starting from an image. False while it is already open
 * or another placement holds the map.
 */
export const openTemplateStudio = (
  next: TemplateStudioTarget,
  initial?: { readonly image: Blob; readonly name: string },
): boolean => {
  if (target !== null || isMoving()) return false
  reset()
  target = next
  draftId = `draft-${uuidV7()}`
  if (next.kind === 'replace') {
    name = next.name
    origin = next.origin
    setOutput({ width: next.width, height: next.height })
  }
  panelWasOpen = isPanelOpen()
  if (panelWasOpen) togglePanel()
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
    warn('install', 'the template studio could not take placement')
  void loadAccount().then(() => {
    // Owned colours arrive after the studio opens; follow them until the author picks colours.
    if (target !== next || paletteChosen) return
    const owned = presetColours('owned')
    if (
      owned.length === palette.length &&
      owned.every((index, position) => index === palette[position])
    )
      return
    palette = owned
    reprocess()
    render()
  })
  void ditheretteAvailable().then((available) => {
    if (target !== next || available) return
    message = 'Ditherette cannot run in this browser, so images cannot be processed here.'
    render()
  })
  if (initial !== undefined) void loadSource(initial.image, initial.name)
  return true
}
