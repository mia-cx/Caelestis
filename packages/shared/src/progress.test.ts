import { describe, expect, it } from 'vitest'
import type { Manifest, Template } from './manifest.js'
import { buildTree, folderPath, folderTemplates } from './progress.js'
import type { TemplateStatus } from './telemetry.js'
import { millis } from './time.js'

const template = (id: string, changes: Partial<Template> = {}): Template => ({
  id,
  nodeId: null,
  name: id,
  version: `${id}-v1`,
  bbox: { minX: 0, minY: 0, maxX: 2, maxY: 2 },
  totalPixels: 4,
  chunks: [],
  published: true,
  finished: false,
  finishedAt: null,
  timelapseFrozen: false,
  createdAt: millis(0),
  updatedAt: millis(0),
  ...changes,
})

const folder = (id: string, parentId: string | null = null) => ({
  id,
  parentId,
  name: id,
  path: `/${id}`,
  createdAt: millis(0),
})

const manifest = (changes: Partial<Manifest>): Manifest => ({
  version: 'catalog',
  season: 1,
  server: { id: 'server', name: 'Server', auth: 'none' },
  nodes: [],
  templates: [],
  tiles: [],
  ...changes,
})

const status = (templateId: string, changes: Partial<TemplateStatus> = {}): TemplateStatus => ({
  templateId,
  correct: 2,
  wrong: 1,
  blank: 1,
  total: 4,
  colours: [
    { index: 1, correct: 2, wrong: 0, blank: 1, total: 3 },
    { index: 2, correct: 0, wrong: 1, blank: 0, total: 1 },
  ],
  observedAt: millis(0),
  ...changes,
})

describe('progress tree', () => {
  it('rolls up published descendants while keeping root templates and the orphan fallback', () => {
    const tree = buildTree(
      manifest({
        nodes: [folder('outer'), folder('inner', 'outer')],
        templates: [
          template('child', { nodeId: 'inner' }),
          template('draft', { nodeId: 'inner', published: false }),
          template('orphan', { nodeId: 'missing' }),
        ],
      }),
      new Map([['child', status('child')]]),
    )
    expect(tree.progress).toEqual({ completed: 2, mismatched: 1, unpainted: 1, known: 4, total: 8 })
    expect(tree.templateCount).toBe(3)
    expect(tree.templates.map((entry) => entry.template.id)).toEqual(['orphan'])
    const outer = tree.folders[0]
    expect(outer?.progress).toEqual({
      completed: 2,
      mismatched: 1,
      unpainted: 1,
      known: 4,
      total: 4,
    })
    expect(outer && folderTemplates(outer).map((entry) => entry.id)).toEqual(['child'])
    expect(folderPath(tree, 'inner').map((entry) => entry.node.id)).toEqual(['outer', 'inner'])
  })

  it('ignores a status measured against a replaced version of the artwork', () => {
    const tree = buildTree(
      manifest({ templates: [template('replaced', { totalPixels: 9 })] }),
      new Map([['replaced', status('replaced')]]),
    )
    const entry = tree.templateById.get('replaced')
    expect(entry?.progress).toEqual({
      completed: 0,
      mismatched: 0,
      unpainted: 0,
      known: 0,
      total: 9,
    })
    expect(entry?.colours).toBeUndefined()
  })

  it('breaks a folder down by colour only when every published artwork reports colours', () => {
    const nodes = [folder('folder')]
    const templates = [template('a', { nodeId: 'folder' }), template('b', { nodeId: 'folder' })]
    const complete = buildTree(
      manifest({ nodes, templates }),
      new Map([
        ['a', status('a')],
        ['b', status('b')],
      ]),
    )
    expect(complete.folderById.get('folder')?.colours).toEqual([
      { index: 1, completed: 4, mismatched: 0, unpainted: 2, known: 6, total: 6 },
      { index: 2, completed: 0, mismatched: 2, unpainted: 0, known: 2, total: 2 },
    ])
    const partial = buildTree(manifest({ nodes, templates }), new Map([['a', status('a')]]))
    expect(partial.folderById.get('folder')?.colours).toBeUndefined()
  })
})
