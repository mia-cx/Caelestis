import {
  millis,
  REGION_CLAIM_TTL_MS,
  type Seconds,
  seconds,
  type TemplateRecipe,
  WORLD_TEMPLATE_SURFACE,
} from '@caelestis/shared'
import type { SqlStore } from '../../src/ports/sql-store.js'

const ids = {
  root: '01890f3e-7b2c-7abc-8def-012345678901',
  sibling: '01890f3e-7b2c-7abc-8def-012345678902',
  child: '01890f3e-7b2c-7abc-8def-012345678903',
  cascadeTemplate: '01890f3e-7b2c-7abc-8def-012345678904',
  cascadeVersion: '01890f3e-7b2c-7abc-8def-012345678905',
  otherSeason: '01890f3e-7b2c-7abc-8def-012345678906',
  guardedTemplate: '01890f3e-7b2c-7abc-8def-012345678907',
  guardedVersion: '01890f3e-7b2c-7abc-8def-012345678908',
  nextVersion: '01890f3e-7b2c-7abc-8def-012345678909',
}

const createdAt = millis(1_000)
const hash = 'a'.repeat(64)

/** Authoring inputs a version must keep exactly, whatever the adapter. */
export const contractRecipe: TemplateRecipe = {
  format: 1,
  processor: 'wplace-native',
  processorVersion: 1,
  source: { sha256: 'b'.repeat(64), width: 4, height: 4 },
  width: 1,
  height: 1,
  colorMetric: 'ciede2000',
  dithering: true,
  legacyDecode: false,
  palette: [0, 4, 31],
}

const node = (id: string, parentId: string | null, path: string, name: string, season = 1) => ({
  id,
  surface: WORLD_TEMPLATE_SURFACE,
  season,
  parentId,
  path,
  name,
  description: null,
  createdAt,
})

const version = (
  templateId: string,
  versionId: string,
  nodeId: string | null,
  bbox = { minX: 0, minY: 0, maxX: 1, maxY: 1 },
) => ({
  templateId,
  versionId,
  surface: WORLD_TEMPLATE_SURFACE,
  season: 1,
  nodeId,
  name: 'Template',
  createdWithToken: 'f'.repeat(64),
  createdByUserId: null,
  createdAt,
  bbox,
  totalPixels: 1,
  chunks: [{ tileX: 0, tileY: 0, hash }],
})

const errorName = async (operation: () => Promise<unknown>): Promise<string | null> => {
  try {
    await operation()
    return null
  } catch (error) {
    return error instanceof Error ? error.name : String(error)
  }
}

export const nodeTemplateContractExpected = {
  childPath: '/renamed/child',
  cycleError: 'InvalidNodeParentError',
  pathConflictError: 'NodePathConflictError',
  subtree: { nodes: 2, templates: 1 },
  cascade: { nodes: 2, templates: 1 },
  cascadeTemplateRemoved: true,
  crossSeasonError: 'InvalidNodeParentError',
  rootPlacement: { updated: true, nodeId: null, name: 'Renamed' },
  identityError: 'TemplateIdentityError',
  staleDeleteRefused: true,
  guardedDelete: true,
  guardedTemplateRemoved: true,
  recipe: contractRecipe,
  processedOnly: true,
} as const

/** Exercise node and template guards through any production SqlStore adapter. */
export const runNodeTemplateContract = async (sql: SqlStore) => {
  await sql.insertNode(node(ids.root, null, '/root', 'Root'))
  await sql.insertNode(node(ids.sibling, null, '/sibling', 'Sibling'))
  await sql.insertNode(node(ids.child, ids.root, '/root/child', 'Child'))
  await sql.insertNode(node(ids.otherSeason, null, '/other-season', 'Other season', 2))
  await sql.insertTemplateVersion(version(ids.cascadeTemplate, ids.cascadeVersion, ids.child))
  await sql.insertTemplateVersion({
    ...version(ids.guardedTemplate, ids.guardedVersion, ids.root),
    recipe: contractRecipe,
  })
  const recipe = (await sql.readTemplateVersion(ids.guardedVersion))?.recipe
  const processedOnly = (await sql.readTemplateVersion(ids.cascadeVersion))?.recipe === undefined

  await sql.renameNode(ids.root, 'Renamed', 'renamed')
  const childPath = (await sql.readNode(ids.child))?.path
  const cycleError = await errorName(() => sql.moveNode(ids.root, ids.child, '/renamed/child/root'))
  const pathConflictError = await errorName(() => sql.renameNode(ids.sibling, 'Renamed', 'renamed'))

  const crossSeasonError = await errorName(() =>
    sql.updateTemplate(ids.guardedTemplate, { nodeId: ids.otherSeason }, millis(1_500)),
  )
  const rootPlacementUpdated = await sql.updateTemplate(
    ids.guardedTemplate,
    { nodeId: null, name: 'Renamed' },
    millis(2_000),
  )
  const guardedTemplate = await sql.readTemplate(ids.guardedTemplate)
  const identityError = await errorName(() =>
    sql.insertTemplateVersion(
      version(ids.guardedTemplate, ids.nextVersion, null, { minX: 0, minY: 0, maxX: 2, maxY: 1 }),
      { requireExisting: true },
    ),
  )
  const staleDeleteRefused =
    (await sql.deleteTemplate(ids.guardedTemplate, {
      versionId: ids.guardedVersion,
      updatedAt: millis(1_000),
    })) === false
  const guardedDelete = await sql.deleteTemplate(ids.guardedTemplate, {
    versionId: ids.guardedVersion,
    updatedAt: millis(2_000),
  })

  const subtree = await sql.countNodeSubtree(ids.root)
  const cascade = await sql.deleteNodeCascade(ids.root, subtree)

  return {
    childPath,
    cycleError,
    pathConflictError,
    subtree,
    cascade,
    cascadeTemplateRemoved: (await sql.readTemplate(ids.cascadeTemplate)) === null,
    crossSeasonError,
    rootPlacement: {
      updated: rootPlacementUpdated,
      nodeId: guardedTemplate?.nodeId,
      name: guardedTemplate?.name,
    },
    identityError,
    staleDeleteRefused,
    guardedDelete,
    guardedTemplateRemoved: (await sql.readTemplate(ids.guardedTemplate)) === null,
    recipe,
    processedOnly,
  }
}

const leaderboardIds = {
  published: '01890f3e-7b2c-7abc-8def-012345678911',
  publishedVersion: '01890f3e-7b2c-7abc-8def-012345678912',
  other: '01890f3e-7b2c-7abc-8def-012345678913',
  otherVersion: '01890f3e-7b2c-7abc-8def-012345678914',
  draft: '01890f3e-7b2c-7abc-8def-012345678915',
  draftVersion: '01890f3e-7b2c-7abc-8def-012345678916',
}
const firstDay = seconds(20_000 * 86_400)
const secondDay = seconds(firstDay + 86_400)

export const leaderboardContractExpected = {
  // Painter 20 ties painter 10 on correct pixels and leads on placed ones. Two reporters saw
  // painter 10's first day; the larger view of each counter wins rather than their sum.
  season: [
    {
      wplaceUserId: 20,
      displayName: '20',
      placed: 9,
      correct: 6,
      repairs: 0,
      activeDays: 1,
      lastDay: firstDay,
    },
    {
      wplaceUserId: 10,
      displayName: 'Ten',
      placed: 7,
      correct: 6,
      repairs: 2,
      activeDays: 2,
      lastDay: secondDay,
    },
  ],
  // Admins see the draft; the range keeps only the second day.
  draftsFromSecondDay: [
    {
      wplaceUserId: 20,
      displayName: '20',
      placed: 50,
      correct: 50,
      repairs: 0,
      activeDays: 1,
      lastDay: secondDay,
    },
    {
      wplaceUserId: 10,
      displayName: 'Ten',
      placed: 2,
      correct: 2,
      repairs: 0,
      activeDays: 1,
      lastDay: secondDay,
    },
  ],
} as const

/** Rank painters through any production SqlStore adapter, reporter reduction included. */
export const runLeaderboardContract = async (sql: SqlStore) => {
  for (const [index, [templateId, versionId]] of (
    [
      [leaderboardIds.published, leaderboardIds.publishedVersion],
      [leaderboardIds.other, leaderboardIds.otherVersion],
      [leaderboardIds.draft, leaderboardIds.draftVersion],
    ] as const
  ).entries()) {
    const x = 100 + index * 10
    await sql.insertTemplateVersion(
      version(templateId, versionId, null, { minX: x, minY: 0, maxX: x + 1, maxY: 1 }),
    )
    if (templateId !== leaderboardIds.draft)
      await sql.updateTemplate(templateId, { publishedAt: millis(1_500) }, millis(1_500))
  }
  await sql.rememberPainter(10, 'Ten', millis(1_000))
  const contribution = (
    templateId: string,
    wplaceUserId: number,
    day: Seconds,
    reportedByUserId: number,
    [placed, correct, repairs]: readonly [number, number, number],
  ) => ({
    templateId,
    wplaceUserId,
    day,
    reportedWithToken: 'c'.repeat(64),
    reportedByUserId,
    placed,
    correct,
    repairs,
  })
  await sql.addContributions([
    contribution(leaderboardIds.published, 10, firstDay, 10, [5, 4, 1]),
    contribution(leaderboardIds.published, 10, firstDay, 11, [3, 3, 2]),
    contribution(leaderboardIds.other, 10, secondDay, 10, [2, 2, 0]),
    contribution(leaderboardIds.published, 20, firstDay, 20, [9, 6, 0]),
    contribution(leaderboardIds.draft, 20, secondDay, 20, [50, 50, 0]),
    contribution(leaderboardIds.other, 30, firstDay, 30, [1, 1, 0]),
  ])
  return {
    season: await sql.readLeaderboard({ season: 1, includeUnpublished: false }, 2),
    draftsFromSecondDay: await sql.readLeaderboard(
      {
        // More ids than D1 binds in one statement, as `/telemetry/leaderboard` accepts.
        templateIds: [
          leaderboardIds.published,
          leaderboardIds.other,
          leaderboardIds.draft,
          ...Array.from(
            { length: 200 },
            (_, index) => `01890f3e-7b2c-7abc-8def-${String(index).padStart(12, '0')}`,
          ),
        ],
        fromSeconds: secondDay,
        includeUnpublished: true,
      },
      10,
    ),
  }
}

const tokenA = 'a'.repeat(64)
const tokenB = 'b'.repeat(64)

export const regionRenewalContractExpected = {
  ownedByA1: 'renewed',
  // A credential renews only beside the painter it was listed with.
  tokenAWithPainter2: 'kept',
  ownedByB2: 'renewed',
  tokenBWithPainter1: 'kept',
  withdrawnByA1: 'kept',
  // Renewal follows the owner across seasons and surfaces.
  otherSeasonA1: 'renewed',
  expiredA1: 'gone',
} as const

/** Renew many owners in one call through any production SqlStore adapter. */
export const runRegionRenewalContract = async (sql: SqlStore) => {
  const now = Date.now()
  // Seasons no other contract uses: the integration suite shares one database between cases.
  const claims = [
    ['ownedByA1', tokenA, 1, 7, now + 60_000],
    ['tokenAWithPainter2', tokenA, 2, 7, now + 60_000],
    ['ownedByB2', tokenB, 2, 7, now + 60_000],
    ['tokenBWithPainter1', tokenB, 1, 7, now + 60_000],
    ['withdrawnByA1', tokenA, 1, 7, now + 60_000],
    ['otherSeasonA1', tokenA, 1, 8, now + 60_000],
    ['expiredA1', tokenA, 1, 7, now - 1],
  ] as const
  for (const [id, tokenHash, painter, season, expiresAt] of claims) {
    const rect = { x: 0, y: 0, w: 8, h: 8 }
    await sql.regions.createRegion(
      {
        id,
        season,
        surface: WORLD_TEMPLATE_SURFACE,
        templateId: null,
        claimant: { wplaceUserId: painter, displayName: String(painter) },
        document: { items: [{ id: 'shape', shape: { kind: 'rectangle', ...rect }, op: 'add' }] },
        rect,
        label: id,
        createdAt: now - 120_000,
        expiresAt,
      },
      tokenHash,
    )
  }
  await sql.regions.deleteRegion(
    'withdrawnByA1',
    { tokenHash: tokenA, actorId: 1, admin: false },
    true,
  )
  await sql.regions.renewRegions(
    [
      { tokenHash: tokenA, actorId: 1 },
      { tokenHash: tokenB, actorId: 2 },
      // More owners than D1 binds in one statement, as a full presence room renews.
      ...Array.from({ length: 150 }, (_, index) => ({
        tokenHash: index.toString(16).padStart(64, 'c'),
        actorId: 1_000 + index,
      })),
    ],
    now,
  )
  const renewedUntil = now + REGION_CLAIM_TTL_MS
  const outcomes: Record<string, string> = {}
  for (const [id] of claims) {
    const region = await sql.regions.readRegion(id)
    outcomes[id] = region === null ? 'gone' : region.expiresAt === renewedUntil ? 'renewed' : 'kept'
  }
  return outcomes
}
