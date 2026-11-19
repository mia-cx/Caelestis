import type { Manifest, Node, Template } from './manifest.js'
import type { Alarm, TemplateStatus } from './telemetry.js'

/**
 * How far an artwork has come. completed / mismatched / unpainted are the three meter segments,
 * `known` is how much of the artwork any tile observation has covered, and `total` is every pixel it
 * asks for. The gap between `known` and `total` is unscanned, not unpainted.
 */
export interface Progress {
  readonly completed: number
  readonly mismatched: number
  readonly unpainted: number
  readonly known: number
  readonly total: number
}

/** Progress of the pixels of one palette colour. */
export interface ColourProgress extends Progress {
  readonly index: number
}

export const emptyProgress = (total: number): Progress => ({
  completed: 0,
  mismatched: 0,
  unpainted: 0,
  known: 0,
  total: Math.max(0, total),
})

/**
 * A status counts only while its total matches the artwork's: a status measured against a replaced
 * version would show the old artwork's figures against the new one.
 */
const current = (totalPixels: number, status: TemplateStatus | undefined) =>
  status !== undefined && status.total === totalPixels ? status : undefined

const fromCounts = (counts: { correct: number; wrong: number; blank: number }) => ({
  completed: counts.correct,
  mismatched: counts.wrong,
  unpainted: counts.blank,
  known: counts.correct + counts.wrong + counts.blank,
})

/** The server's figures for an artwork, or undefined when it has none for this version. */
export const progressFromStatus = (
  totalPixels: number,
  status: TemplateStatus | undefined,
): Progress | undefined => {
  const counts = current(totalPixels, status)
  return counts === undefined ? undefined : { ...fromCounts(counts), total: totalPixels }
}

/** Per-colour figures for an artwork, or undefined when the server has none for this version. */
export const colourProgressFromStatus = (
  totalPixels: number,
  status: TemplateStatus | undefined,
): readonly ColourProgress[] | undefined =>
  current(totalPixels, status)?.colours?.map((colour) => ({
    index: colour.index,
    ...fromCounts(colour),
    total: colour.total,
  }))

export const sumProgress = (parts: readonly Progress[]): Progress =>
  parts.reduce(
    (sum, part) => ({
      completed: sum.completed + part.completed,
      mismatched: sum.mismatched + part.mismatched,
      unpainted: sum.unpainted + part.unpainted,
      known: sum.known + part.known,
      total: sum.total + part.total,
    }),
    emptyProgress(0),
  )

/**
 * Sum per-colour progress across artworks. Undefined unless the colour totals add up to `total`,
 * the overall total of the same artworks: a breakdown missing an artwork would misstate every
 * colour's share.
 */
export const sumColourProgress = (
  groups: ReadonlyArray<readonly ColourProgress[]>,
  total: number,
): readonly ColourProgress[] | undefined => {
  const byIndex = new Map<number, ColourProgress>()
  for (const colour of groups.flat()) {
    const held = byIndex.get(colour.index)
    byIndex.set(
      colour.index,
      held === undefined ? colour : { index: colour.index, ...sumProgress([held, colour]) },
    )
  }
  const colours = [...byIndex.values()].sort((left, right) => left.index - right.index)
  return colours.length > 0 && colours.reduce((sum, colour) => sum + colour.total, 0) === total
    ? colours
    : undefined
}

export interface TreeTemplate {
  readonly template: Template
  readonly status: TemplateStatus | undefined
  readonly alarm: Alarm | undefined
  readonly progress: Progress
  readonly colours: readonly ColourProgress[] | undefined
}

/** A manifest folder with its children resolved and its progress rolled up from every descendant. */
export interface TreeFolder {
  readonly node: Node
  readonly folders: TreeFolder[]
  readonly templates: TreeTemplate[]
  readonly progress: Progress
  readonly colours: readonly ColourProgress[] | undefined
  readonly templateCount: number
}

export interface TemplateTree {
  readonly folders: TreeFolder[]
  /** Templates that live at the server root, outside any folder. */
  readonly templates: TreeTemplate[]
  readonly progress: Progress
  readonly colours: readonly ColourProgress[] | undefined
  readonly templateCount: number
  readonly folderById: ReadonlyMap<string, TreeFolder>
  readonly templateById: ReadonlyMap<string, TreeTemplate>
}

const byName = (left: { name: string }, right: { name: string }): number =>
  left.name.localeCompare(right.name)

/**
 * Roll up the published templates and child folders. Drafts are visible to admins but must not
 * change progress for anyone else.
 */
const rollUp = (templates: readonly TreeTemplate[], folders: readonly TreeFolder[]) => {
  const published = templates.filter((entry) => entry.template.published)
  const progress = sumProgress([
    ...published.map((entry) => entry.progress),
    ...folders.map((folder) => folder.progress),
  ])
  return {
    progress,
    colours: sumColourProgress(
      [...published, ...folders].map((part) => part.colours ?? []),
      progress.total,
    ),
    templateCount: templates.length + folders.reduce((n, folder) => n + folder.templateCount, 0),
  }
}

/**
 * Resolve the manifest's flat node and template lists into a tree.
 *
 * A template whose `nodeId` names no node falls back to the root. The manifest already drops
 * orphaned rows, so this only covers a read split between two polls.
 */
export const buildTree = (
  manifest: Manifest,
  statuses: ReadonlyMap<string, TemplateStatus>,
  alarms: ReadonlyMap<string, Alarm> = new Map(),
): TemplateTree => {
  const templatesByNode = new Map<string | null, TreeTemplate[]>()
  const templateById = new Map<string, TreeTemplate>()
  const nodeIds = new Set(manifest.nodes.map((node) => node.id))
  for (const template of manifest.templates) {
    const status = statuses.get(template.id)
    const parent = template.nodeId !== null && nodeIds.has(template.nodeId) ? template.nodeId : null
    const entry: TreeTemplate = {
      template,
      status,
      alarm: alarms.get(template.id),
      progress:
        progressFromStatus(template.totalPixels, status) ?? emptyProgress(template.totalPixels),
      colours: colourProgressFromStatus(template.totalPixels, status),
    }
    templateById.set(template.id, entry)
    templatesByNode.set(parent, [...(templatesByNode.get(parent) ?? []), entry])
  }

  const folderById = new Map<string, TreeFolder>()
  const children = (parentId: string | null) => {
    const folders = manifest.nodes
      .filter((node) => node.parentId === parentId)
      .sort(byName)
      .map((node): TreeFolder => {
        const folder = { node, ...children(node.id) }
        folderById.set(node.id, folder)
        return folder
      })
    const templates = (templatesByNode.get(parentId) ?? []).sort((a, b) =>
      byName(a.template, b.template),
    )
    return { folders, templates, ...rollUp(templates, folders) }
  }
  return { ...children(null), folderById, templateById }
}

/** Every published template inside a folder, including descendants. */
export const folderTemplates = (folder: TreeFolder): Template[] => [
  ...folder.templates.filter((entry) => entry.template.published).map((entry) => entry.template),
  ...folder.folders.flatMap(folderTemplates),
]

/** The folder's ancestors, root first, ending with the folder itself. */
export const folderPath = (tree: TemplateTree, nodeId: string): TreeFolder[] => {
  const path: TreeFolder[] = []
  for (
    let folder = tree.folderById.get(nodeId);
    folder !== undefined && path.length <= tree.folderById.size;
    folder = folder.node.parentId === null ? undefined : tree.folderById.get(folder.node.parentId)
  ) {
    path.unshift(folder)
  }
  return path
}
