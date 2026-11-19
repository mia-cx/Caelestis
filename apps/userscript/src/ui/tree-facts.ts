import {
  sameTemplateSurface,
  type TemplateSurface,
  WORLD_TEMPLATE_SURFACE,
} from '@caelestis/shared'
import type { ServerTemplate } from '../server-manifest.js'
import { serverColourProgressFor, serverProgressFor } from '../server-status.js'
import { getState, type ServerConnection } from '../settings.js'
import { artboardProgressCounts } from '../templates/artboard-accounting.js'
import {
  type LocalTemplate,
  localTemplates,
  type PlacedTemplate,
  type ServerCopy,
} from '../templates/catalog.js'
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

/**
 * Whether an alliance template has never been counted: its pixels left memory before any artboard
 * read. The tree shows such a row as empty rather than as `opaque` pixels unknown.
 */
const neverCounted = (template: PlacedTemplate): boolean =>
  (template.surface ?? WORLD_TEMPLATE_SURFACE).kind !== 'world' &&
  artboardProgressCounts(template) === undefined

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
      (template.origin !== 'local' || template.staged === undefined) &&
      sameTemplateSurface(template.surface ?? WORLD_TEMPLATE_SURFACE, surface) &&
      (templateKeys === undefined || templateKeys.has(templateTreeKeyFor(template, servers) ?? '')),
  )
  const drawnByServer = new Map<string, Map<string, ServerCopy>>()
  for (const template of drawn) {
    if (template.origin !== 'server') continue
    const templates = drawnByServer.get(template.server.url) ?? new Map<string, ServerCopy>()
    templates.set(template.serverTemplateId, template)
    drawnByServer.set(template.server.url, templates)
  }
  return {
    servers,
    drawn,
    localOnly: drawn.filter((template): template is LocalTemplate => template.origin === 'local'),
    drawnServerTemplate: (server, id) => drawnByServer.get(server.url)?.get(id),
    progress: (template) =>
      neverCounted(template) ? emptyProgress(0) : pixelAccounting.read(template).progress,
    colourProgress: (template) =>
      neverCounted(template) ? [] : pixelAccounting.read(template).colours,
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
