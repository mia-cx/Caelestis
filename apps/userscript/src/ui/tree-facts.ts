import {
  sameTemplateSurface,
  type TemplateSurface,
  WORLD_TEMPLATE_SURFACE,
} from '@caelestis/shared'
import { activeAllianceSurface } from '../alliance-surface.js'
import { NO_ARTBOARD_PIXELS, readArtboardPixels } from '../gl/artboard-pixels.js'
import type { ServerTemplate } from '../server-manifest.js'
import { getState, type ServerConnection } from '../settings.js'
import { serverColourProgressFor, serverProgressFor } from '../telemetry.js'
import {
  artboardColourProgress,
  artboardTemplateProgress,
} from '../templates/artboard-accounting.js'
import {
  isServerTemplate,
  localTemplates,
  type PlacedTemplate,
  type TemplateArtwork,
} from '../templates/local-store.js'
import { pixelAccounting } from '../templates/mismatch.js'
import type { TemplateColourProgress, TemplateProgress } from '../templates/progress-types.js'
import {
  emptyProgress,
  freshestColourProgress,
  freshestProgress,
  sumColourProgress,
  sumProgress,
} from './progress.js'
import { type TreeFacts, templateTreeKeyFor } from './tree-context.js'

interface Counts {
  readonly progress: TemplateProgress
  readonly colours: readonly TemplateColourProgress[]
}

/** Alliance progress last counted per artwork, shown while that template's pixels are evicted. */
const lastAllianceProgress = new WeakMap<TemplateArtwork, Counts>()

/** Count every drawn alliance template against the artboard's pixels, once per build. */
const allianceCounts = (
  surface: TemplateSurface,
  drawn: readonly PlacedTemplate[],
): ReadonlyMap<string, Counts> => {
  const counts = new Map<string, Counts>()
  if (surface.kind === 'world' || drawn.length === 0) return counts
  const active = activeAllianceSurface()
  const bounds = active?.bounds ?? null
  const regions =
    active !== null && bounds !== null && sameTemplateSurface(active.surface, surface)
      ? readArtboardPixels(active, {
          originX: bounds.minX,
          originY: bounds.minY,
          width: bounds.maxX - bounds.minX,
          height: bounds.maxY - bounds.minY,
        })
      : NO_ARTBOARD_PIXELS
  for (const template of drawn) {
    const pixels = template.artwork.pixels
    const colours =
      pixels === null ? null : artboardColourProgress({ ...template, pixels }, regions)
    // An evicted template keeps the counts it had when its pixels were last in memory.
    const known =
      colours === null
        ? lastAllianceProgress.get(template.artwork)
        : { progress: artboardTemplateProgress(colours), colours }
    if (known === undefined) continue
    lastAllianceProgress.set(template.artwork, known)
    counts.set(template.id, known)
  }
  return counts
}

/**
 * Read the templates a build lists, and how far along each is, once for the whole build.
 * `templateKeys` narrows them to the claimed list's rows.
 */
export const treeFacts = (
  surface: TemplateSurface,
  templateKeys: ReadonlySet<string> | undefined,
): TreeFacts => {
  const servers = getState().servers
  const drawn = localTemplates().filter(
    (template) =>
      template.staged === undefined &&
      sameTemplateSurface(template.surface ?? WORLD_TEMPLATE_SURFACE, surface) &&
      (templateKeys === undefined || templateKeys.has(templateTreeKeyFor(template, servers) ?? '')),
  )
  const alliance = allianceCounts(surface, drawn)
  const drawnByServer = new Map<string, Map<string, PlacedTemplate>>()
  for (const template of drawn) {
    if (template.serverUrl === undefined || template.serverTemplateId === undefined) continue
    const templates = drawnByServer.get(template.serverUrl) ?? new Map<string, PlacedTemplate>()
    templates.set(template.serverTemplateId, template)
    drawnByServer.set(template.serverUrl, templates)
  }
  return {
    servers,
    drawn,
    localOnly: drawn.filter((template) => !isServerTemplate(template)),
    drawnServerTemplate: (server, id) => drawnByServer.get(server.url)?.get(id),
    progress: (template) =>
      surface.kind === 'world'
        ? pixelAccounting.read(template).progress
        : (alliance.get(template.id)?.progress ?? emptyProgress(0)),
    colourProgress: (template) =>
      surface.kind === 'world'
        ? pixelAccounting.read(template).colours
        : (alliance.get(template.id)?.colours ?? []),
  }
}

/** A server template's progress: the server's counts, or the drawn copy's when it is fresher. */
export const serverTemplateProgress = (
  facts: TreeFacts,
  surface: TemplateSurface,
  server: ServerConnection,
  template: ServerTemplate,
): TemplateProgress => {
  const baseline = serverProgressFor(server, template) ?? emptyProgress(template.totalPixels ?? 0)
  const drawn = facts.drawnServerTemplate(server, template.id)
  if (drawn === undefined) return baseline
  if (surface.kind !== 'world') return facts.progress(drawn)
  const serverColours = serverColourProgressFor(server, template)
  if (serverColours !== null) {
    return (
      sumProgress(freshestColourProgress(serverColours, pixelAccounting.read(drawn).colours)) ??
      baseline
    )
  }
  return freshestProgress(baseline, pixelAccounting.read(drawn).progress)
}

/** A server template's per-colour progress, or undefined when nobody has counted it. */
export const serverTemplateColourProgress = (
  facts: TreeFacts,
  surface: TemplateSurface,
  server: ServerConnection,
  template: ServerTemplate,
): readonly TemplateColourProgress[] | undefined => {
  const drawn = facts.drawnServerTemplate(server, template.id)
  if (surface.kind !== 'world') return drawn === undefined ? undefined : facts.colourProgress(drawn)
  const serverProgress = serverColourProgressFor(server, template)
  if (serverProgress === null) return undefined
  return drawn === undefined
    ? serverProgress
    : freshestColourProgress(serverProgress, pixelAccounting.read(drawn).colours)
}

/** Per-colour totals for a rollup, only when they account for every pixel of `overall`. */
export const completeColourProgress = (
  overall: TemplateProgress | undefined,
  groups: ReadonlyArray<readonly TemplateColourProgress[]>,
): readonly TemplateColourProgress[] | undefined => {
  const colours = sumColourProgress(groups)
  return colours !== undefined &&
    overall !== undefined &&
    colours.reduce((sum, entry) => sum + entry.total, 0) === overall.total
    ? colours
    : undefined
}
