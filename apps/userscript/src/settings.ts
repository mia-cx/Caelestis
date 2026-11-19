import {
  defaultTemplateSort,
  EMPTY_TEMPLATE_FILTERS,
  isRecord,
  isTemplateSortField,
  isWorkIdentity,
  normaliseShortcutOverrides,
  normaliseSimulatedInput,
  PALETTE_SIZE,
  type PainterIdentity,
  parseTemplateFilters,
  type ShortcutOverrides,
  type SimulatedInputSwitches,
  type TemplateFilters,
  type TemplateSortOrder,
  type TemplateSurface,
  templateSurface,
  templateSurfaceKey,
  WORLD_TEMPLATE_SURFACE,
} from '@caelestis/shared'
import { DEFAULT_STUDIO_LAYOUT, parseStudioLayout, type StudioLayout } from '@caelestis/ui/elements'
import { log, warn } from './debug.js'
import { DEFAULT_MARKER_BUDGET, normaliseMarkerBudget } from './marker-budget.js'
import { parseServerInfo, type ServerInfo } from './server-manifest.js'
import { canonicalServerUrl } from './server-url.js'
import { onStoredValueChange, storedValue, storeValue } from './stored-values.js'
import {
  APPEARANCE_GROUPS,
  type Appearance,
  type AppearanceGroup,
  DEFAULT_APPEARANCE,
  normaliseAppearance,
} from './templates/appearance.js'
import { remapPaletteColours, remapStoredAppearance } from './templates/palette-migration.js'

/**
 * Everything the panel remembers between sessions.
 *
 * Kept in stored values (`stored-values.ts`): the userscript manager's storage, the extension's
 * `chrome.storage.local`, or `localStorage` under the CDP dev harness.
 *
 * **Access tokens are a known weak point.** `localStorage` on wplace.live is readable by wplace's
 * own scripts and by every other userscript on the page. The other two are not, which is the whole
 * reason the metadata block asks for `GM_setValue`. Treat the fallback as a development convenience and not as
 * somewhere a real alliance token belongs — see the note in `handoff-userscript-browser.md`.
 */

const STORAGE_KEY = 'caelestis.state.v2'
const LEGACY_STORAGE_KEY = 'caelestis.state.v1'

export interface ServerConnection {
  /** Host and optional base path as the user typed them, normalised — the connection identity. */
  readonly url: string
  readonly info: ServerInfo | null
  readonly token: string | null
  /** False when the saved token was rejected but an open server remains usable anonymously. */
  readonly tokenUsable?: boolean
  readonly status: 'connected' | 'needs-token' | 'unreachable'
  readonly error?: string
  /**
   * Whether our code can administer this server.
   *
   * Nothing in `GET /server` reports scope, so this is established by calling an admin endpoint and
   * seeing what comes back. It gates the create and import controls: offering them to someone who
   * will only ever get a 403 is worse than not offering them.
   */
  readonly isAdmin: boolean
  /** Non-negative season advertised by the validated manifest. */
  readonly season: number | null
  /** Last manifest identity proven for this URL, retained only to validate render-only cache data. */
  readonly lastVerified?: {
    readonly serverId: string
    readonly season: number
  } | null
  /** Runtime-only marker: this probe was deliberately replaced or cancelled, not unreachable. */
  readonly superseded?: true
  /** Set when the probe found a server older than the `/v1` API prefix. */
  readonly apiVersion?: 'legacy'
}

/** A browser-local folder; its metadata is small enough to live in userscript state. */
export interface LocalFolder {
  readonly id: string
  readonly parentId: string | null
  readonly name: string
  readonly visible: boolean
  readonly createdAt?: number
  /** Exact drawing surface. Records written before alliance support are world-scoped. */
  readonly surface?: TemplateSurface
}

/** Browser-owned drawing preferences for an overlay whose pixels remain server-owned. */
export interface ServerTemplatePreference {
  readonly id: string
  readonly appearance: Appearance | null
  readonly owns: readonly AppearanceGroup[]
}

/** Browser-owned defaults and view mode for one alliance artboard. */
export interface AllianceSurfaceAppearance {
  readonly surface: Exclude<TemplateSurface, { readonly kind: 'world' }>
  readonly appearance: Appearance
  readonly onlySelectedColour: boolean
}

type ColourNavigationOrder = 'unpainted-first' | 'mismatched-first'

export interface State {
  readonly servers: readonly ServerConnection[]
  /** Row keys in the user's own order. Keys absent from this list sort after those present. */
  readonly customOrder: readonly string[]
  /** Containers the user explicitly collapsed. Search may reveal them without changing this. */
  readonly collapsed: readonly string[]
  /** Panel width in pixels, dragged by the handle on its left edge. */
  readonly panelWidth: number
  readonly sort: TemplateSortOrder
  readonly filters: TemplateFilters
  /** Palette indices deliberately hidden. Empty means every colour draws. */
  readonly hiddenColours: readonly number[]
  /** World-canvas selected-colour mode. Alliance canvases keep their own value. */
  readonly onlySelectedColour: boolean
  /** Which kind of remaining work a middle-clicked Wplace colour swatch visits first. */
  readonly colourNavigationOrder: ColourNavigationOrder
  /** Features the painter allowed to simulate input on Wplace's controls, which Wplace flags. */
  readonly simulatedInput: SimulatedInputSwitches
  /** Target mismatch or selected-colour markers submitted across one viewport. */
  readonly markerBudget: number
  readonly localFolders: readonly LocalFolder[]
  readonly localClaims: readonly {
    readonly templateId: string
    readonly claimant: PainterIdentity
  }[]
  readonly hiddenScopes: readonly string[]
  readonly serverTemplatePreferences: readonly ServerTemplatePreference[]
  readonly allianceSurfaceAppearances: readonly AllianceSurfaceAppearance[]
  readonly appearance: Appearance
  readonly reportPaints: boolean
  readonly shareTiles: boolean
  /** Publish this tab's viewport and draft to other painters on the same server. */
  readonly sharePresence: boolean
  /** Draw other painters at all: the rail button and Q. */
  readonly showPresence: boolean
  /** With `showPresence`: their viewports and drafts. */
  readonly showPresenceViewports: boolean
  /** With `showPresence`: region claims, theirs and yours. */
  readonly showPresenceClaims: boolean
  /** With `showPresenceClaims`: draw claims only while Wplace's paint drawer is open. */
  readonly showPresenceClaimsOnlyWhilePainting: boolean
  readonly notifyRegressions: boolean
  readonly notifyGriefing: boolean
  readonly notifyUpdates: boolean
  readonly notifyActivity: boolean
  /** Keyboard actions the user rebound. Absent actions keep their default chords. */
  readonly shortcutOverrides: ShortcutOverrides
  /** Where the template studio's windows sit. */
  readonly studioLayout: StudioLayout
}

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const MAX_CUSTOM_ORDER = 200_000
export const MAX_CONNECTED_SERVERS = 32
/** At most every admitted overlay for every configured server may retain a local preference. */
const MAX_SERVER_TEMPLATE_PREFERENCES = MAX_CONNECTED_SERVERS * 64
const MAX_ALLIANCE_SURFACE_APPEARANCES = MAX_CONNECTED_SERVERS * 3
/** As many browser-local folders as a reload will restore. Written past, the rest is dropped. */
export const MAX_LOCAL_FOLDERS = 32_000
const DEFAULT_PANEL_WIDTH = 320

/** What a field's decoder may need beyond its own stored value. */
interface DecodeContext {
  /** The record was written before the palette was reordered. */
  readonly legacyPalette: boolean
  /** The servers already decoded from the same record. */
  readonly servers: readonly ServerConnection[]
  /** Set by a decoder that migrated its value, so the record is written back once. */
  migrated: boolean
}

interface Field<T> {
  readonly default: T
  /** Coerce untrusted stored data. */
  readonly decode: (stored: unknown, context: DecodeContext) => T
}

/**
 * A switch that applies to every tab. It is also stored under its own key, which wins over its copy
 * in the state record: a tab saves its whole record at once, and the toolbar popup changes one
 * switch, so with separate keys neither can write back a stale copy of what the other just changed.
 */
interface GlobalField extends Field<boolean> {
  readonly decode: (stored: unknown) => boolean
  readonly global: true
}

/** A switch whose default is kept unless the stored value is the explicit opposite. */
const flag = (fallback: boolean) => ({
  default: fallback,
  decode: (stored: unknown): boolean => (stored === !fallback ? !fallback : fallback),
})

const globalFlag = (fallback: boolean): GlobalField => ({ ...flag(fallback), global: true })

const uniqueStrings = (stored: unknown, keep: (key: string) => boolean = () => true): string[] =>
  Array.isArray(stored)
    ? [
        ...new Set(stored.filter((key): key is string => typeof key === 'string' && keep(key))),
      ].slice(0, MAX_CUSTOM_ORDER)
    : []

const decodeServers = (stored: unknown): ServerConnection[] => {
  const servers: ServerConnection[] = []
  const seenServers = new Set<string>()
  if (!Array.isArray(stored)) return servers
  for (const candidate of stored) {
    if (!isRecord(candidate) || typeof candidate.url !== 'string') continue
    let url: string
    try {
      url = canonicalServerUrl(candidate.url)
    } catch {
      continue
    }
    if (seenServers.has(url)) continue
    seenServers.add(url)
    const info = parseServerInfo(candidate.info)
    const storedSeason =
      Number.isSafeInteger(candidate.season) && Number(candidate.season) >= 0
        ? Number(candidate.season)
        : null
    const storedIdentity = isRecord(candidate.lastVerified) ? candidate.lastVerified : null
    const lastVerified =
      typeof storedIdentity?.serverId === 'string' &&
      storedIdentity.serverId === info?.id &&
      Number.isSafeInteger(storedIdentity.season) &&
      Number(storedIdentity.season) >= 0
        ? { serverId: storedIdentity.serverId, season: Number(storedIdentity.season) }
        : info !== null && storedSeason !== null
          ? { serverId: info.id, season: storedSeason }
          : null
    servers.push({
      url,
      info,
      token: typeof candidate.token === 'string' ? candidate.token : null,
      status: 'unreachable',
      error: 'Checking connection…',
      isAdmin: false,
      season: null,
      lastVerified,
    })
    if (servers.length >= MAX_CONNECTED_SERVERS) break
  }
  return servers
}

const DEFAULT_SORT = defaultTemplateSort('custom')

const decodeSort = (stored: unknown): TemplateSortOrder => {
  const sort = isRecord(stored) ? stored : {}
  return isTemplateSortField(sort.field) && sort.field !== 'custom'
    ? {
        field: sort.field,
        direction:
          sort.direction === 'asc' || sort.direction === 'desc'
            ? sort.direction
            : defaultTemplateSort(sort.field).direction,
      }
    : DEFAULT_SORT
}

const decodeHiddenColours = (stored: unknown, { legacyPalette }: DecodeContext): number[] => {
  const indices = Array.isArray(stored)
    ? stored.filter((index): index is number => Number.isSafeInteger(index))
    : []
  if (indices.length === 0) return []
  return [
    ...new Set(
      (legacyPalette ? remapPaletteColours(indices) : indices).filter(
        (index): index is number =>
          Number.isSafeInteger(index) && index >= 0 && index < PALETTE_SIZE,
      ),
    ),
  ]
}

const decodeLocalFolders = (stored: unknown): LocalFolder[] => {
  const localFolders: LocalFolder[] = []
  const folderIds = new Set<string>()
  if (!Array.isArray(stored)) return localFolders
  for (const candidate of stored) {
    if (
      !isRecord(candidate) ||
      typeof candidate.id !== 'string' ||
      candidate.id.length > 128 ||
      folderIds.has(candidate.id) ||
      typeof candidate.name !== 'string' ||
      candidate.name.length < 1 ||
      candidate.name.length > 256 ||
      (candidate.parentId !== null && typeof candidate.parentId !== 'string')
    )
      continue
    const surface =
      candidate.surface === undefined
        ? WORLD_TEMPLATE_SURFACE
        : isRecord(candidate.surface)
          ? templateSurface(candidate.surface.kind, candidate.surface.allianceId)
          : null
    if (surface === null) continue
    folderIds.add(candidate.id)
    localFolders.push({
      id: candidate.id,
      parentId: candidate.parentId,
      name: candidate.name,
      ...(typeof candidate.createdAt === 'number' &&
      Number.isFinite(candidate.createdAt) &&
      candidate.createdAt >= 0
        ? { createdAt: candidate.createdAt }
        : {}),
      // Records written before folder visibility existed were visible.
      visible: candidate.visible !== false,
      surface,
    })
    if (localFolders.length >= MAX_LOCAL_FOLDERS) break
  }
  return localFolders
}

const decodeHiddenScopes = (stored: unknown, context: DecodeContext): string[] => {
  const storedScopes = Array.isArray(stored)
    ? stored.filter((key): key is string => typeof key === 'string' && key.length <= 2_048)
    : []
  const migrateServerTemplateScope = (key: string): string => {
    for (const server of context.servers) {
      const prefix = `srv:${server.url}:`
      if (!key.startsWith(prefix)) continue
      const templateId = key.slice(prefix.length)
      if (UUID_V7.test(templateId)) return `srv:${encodeURIComponent(server.url)}:${templateId}`
    }
    return key
  }
  const hiddenScopes = [
    ...new Set(
      storedScopes.flatMap((key) => {
        const legacyNodeId = key.startsWith('node:') ? key.slice('node:'.length) : ''
        if (!UUID_V7.test(legacyNodeId)) return [migrateServerTemplateScope(key)]
        // The old key hid this node id without naming a server. Preserve that meaning for every
        // connection that existed with the setting, then store only the collision-safe form.
        return context.servers.map(
          (server) => `node:${encodeURIComponent(server.url)}:${legacyNodeId}`,
        )
      }),
    ),
  ].slice(0, MAX_CUSTOM_ORDER)
  if (
    hiddenScopes.length !== storedScopes.length ||
    hiddenScopes.some((key, index) => key !== storedScopes[index])
  )
    context.migrated = true
  return hiddenScopes
}

const decodeServerTemplatePreferences = (
  stored: unknown,
  { legacyPalette }: DecodeContext,
): ServerTemplatePreference[] => {
  const preferences: ServerTemplatePreference[] = []
  const preferenceIds = new Set<string>()
  if (!Array.isArray(stored)) return preferences
  for (const candidate of stored) {
    if (
      !isRecord(candidate) ||
      typeof candidate.id !== 'string' ||
      !candidate.id.startsWith('srv:') ||
      candidate.id.length > 2_048 ||
      preferenceIds.has(candidate.id) ||
      !Array.isArray(candidate.owns)
    )
      continue
    const appearance =
      candidate.appearance === null
        ? null
        : normaliseAppearance(
            legacyPalette ? remapStoredAppearance(candidate.appearance) : candidate.appearance,
          )
    if (candidate.appearance !== null && appearance === null) continue
    const owns = [
      ...new Set(
        candidate.owns.filter((group): group is AppearanceGroup =>
          APPEARANCE_GROUPS.includes(group as AppearanceGroup),
        ),
      ),
    ]
    preferenceIds.add(candidate.id)
    preferences.push({ id: candidate.id, appearance, owns })
    if (preferences.length >= MAX_SERVER_TEMPLATE_PREFERENCES) break
  }
  return preferences
}

const decodeAllianceSurfaceAppearances = (stored: unknown): AllianceSurfaceAppearance[] => {
  const appearances: AllianceSurfaceAppearance[] = []
  const surfaces = new Set<string>()
  if (!Array.isArray(stored)) return appearances
  for (const candidate of stored) {
    if (!isRecord(candidate) || !isRecord(candidate.surface)) continue
    const surface = templateSurface(candidate.surface.kind, candidate.surface.allianceId)
    if (surface === null || surface.kind === 'world') continue
    const key = templateSurfaceKey(surface)
    if (surfaces.has(key)) continue
    const appearance = normaliseAppearance(candidate.appearance)
    if (appearance === null) continue
    surfaces.add(key)
    appearances.push({
      surface,
      appearance,
      onlySelectedColour: candidate.onlySelectedColour === true,
    })
    if (appearances.length >= MAX_ALLIANCE_SURFACE_APPEARANCES) break
  }
  return appearances
}

/**
 * Every persisted setting: its default and how a stored copy is read back. Adding a setting means
 * adding it to `State` and here.
 */
const FIELDS = {
  servers: { default: [], decode: (_, context) => context.servers },
  customOrder: {
    default: [],
    decode: (stored) =>
      uniqueStrings(stored, (key) => !(key.startsWith('node:') && UUID_V7.test(key.slice(5)))),
  },
  collapsed: { default: [], decode: (stored) => uniqueStrings(stored) },
  panelWidth: {
    default: DEFAULT_PANEL_WIDTH,
    decode: (stored) =>
      typeof stored === 'number' && Number.isFinite(stored)
        ? Math.min(720, Math.max(260, stored))
        : DEFAULT_PANEL_WIDTH,
  },
  sort: { default: DEFAULT_SORT, decode: decodeSort },
  filters: { default: EMPTY_TEMPLATE_FILTERS, decode: parseTemplateFilters },
  hiddenColours: { default: [], decode: decodeHiddenColours },
  onlySelectedColour: flag(false),
  colourNavigationOrder: {
    default: 'unpainted-first',
    decode: (stored) => (stored === 'mismatched-first' ? 'mismatched-first' : 'unpainted-first'),
  },
  simulatedInput: { default: {}, decode: normaliseSimulatedInput },
  markerBudget: { default: DEFAULT_MARKER_BUDGET, decode: normaliseMarkerBudget },
  localFolders: { default: [], decode: decodeLocalFolders },
  localClaims: {
    default: [],
    decode: (stored) =>
      Array.isArray(stored)
        ? stored
            .filter(
              (claim): claim is State['localClaims'][number] =>
                isRecord(claim) &&
                typeof claim.templateId === 'string' &&
                claim.templateId.length <= 128 &&
                isWorkIdentity(claim.claimant),
            )
            .slice(0, 1000)
        : [],
  },
  hiddenScopes: { default: [], decode: decodeHiddenScopes },
  serverTemplatePreferences: { default: [], decode: decodeServerTemplatePreferences },
  allianceSurfaceAppearances: { default: [], decode: decodeAllianceSurfaceAppearances },
  appearance: {
    default: DEFAULT_APPEARANCE,
    decode: (stored, { legacyPalette }) =>
      normaliseAppearance(
        legacyPalette ? remapStoredAppearance(stored ?? null) : (stored ?? null),
      ) ?? DEFAULT_APPEARANCE,
  },
  // Contribution sharing is opt-out. Missing fields are older saved state, not a decision to
  // disable either feed; an explicit false remains durable across reloads.
  reportPaints: globalFlag(true),
  shareTiles: globalFlag(true),
  sharePresence: globalFlag(true),
  showPresence: globalFlag(true),
  showPresenceViewports: globalFlag(true),
  showPresenceClaims: globalFlag(true),
  showPresenceClaimsOnlyWhilePainting: globalFlag(false),
  notifyRegressions: globalFlag(false),
  notifyGriefing: globalFlag(false),
  notifyUpdates: globalFlag(true),
  notifyActivity: globalFlag(false),
  shortcutOverrides: { default: {}, decode: normaliseShortcutOverrides },
  studioLayout: { default: DEFAULT_STUDIO_LAYOUT, decode: parseStudioLayout },
} satisfies { readonly [K in keyof State]: Field<State[K]> }

const fieldNames = Object.keys(FIELDS) as (keyof State)[]

/** A whole `State`, one field at a time. */
const stateFrom = (field: (name: keyof State) => unknown): State =>
  Object.fromEntries(fieldNames.map((name) => [name, field(name)])) as unknown as State

const DEFAULT_STATE = stateFrom((name) => FIELDS[name].default)

type GlobalSettingName = {
  [K in keyof State]: (typeof FIELDS)[K] extends GlobalField ? K : never
}[keyof State]

const GLOBAL_SETTINGS = fieldNames.filter(
  (name): name is GlobalSettingName => 'global' in FIELDS[name],
)

/** The switches in state that apply to every tab, which the extension's toolbar popup can change. */
export type GlobalSettings = Pick<State, GlobalSettingName>

const SWITCH_PREFIX = 'caelestis.setting.'

const storedSwitches = (): Partial<GlobalSettings> => {
  const switches: Partial<Record<GlobalSettingName, boolean>> = {}
  for (const name of GLOBAL_SETTINGS) {
    try {
      const value = storedValue(`${SWITCH_PREFIX}${name}`)
      if (value === 'true' || value === 'false') switches[name] = value === 'true'
    } catch {
      // The state record's copy stands in.
    }
  }
  return switches
}

const storeSwitches = (patch: Partial<State>): void => {
  for (const name of GLOBAL_SETTINGS) {
    const value = patch[name]
    if (value === undefined) continue
    try {
      storeValue(`${SWITCH_PREFIX}${name}`, String(value))
    } catch (error) {
      warn('install', `could not persist ${name}`, String(error))
    }
  }
}

const globalSettingsFrom = (
  stored: Partial<Record<GlobalSettingName, unknown>>,
): GlobalSettings => {
  const settings: Partial<Record<GlobalSettingName, boolean>> = {}
  for (const name of GLOBAL_SETTINGS) settings[name] = FIELDS[name].decode(stored[name])
  return settings as GlobalSettings
}

const readRaw = (): {
  readonly value: string
  readonly legacyPalette: boolean
} | null => {
  try {
    const current = storedValue(STORAGE_KEY)
    if (current !== null) return { value: current, legacyPalette: false }
    const legacy = storedValue(LEGACY_STORAGE_KEY)
    return legacy === null ? null : { value: legacy, legacyPalette: true }
  } catch (error) {
    warn('install', 'could not read stored state', String(error))
    return null
  }
}

const writeRaw = (value: string): boolean => {
  try {
    storeValue(STORAGE_KEY, value)
    return true
  } catch (error) {
    warn('install', 'could not persist state', String(error))
    return false
  }
}

let state: State = DEFAULT_STATE
const listeners: Array<(next: State) => void> = []

const notifyStateListeners = (): void => {
  for (const listener of listeners) {
    try {
      listener(state)
    } catch (error) {
      // An observer must never turn an already-applied state change into a reported failure.
      warn('install', 'state observer failed', String(error))
    }
  }
}

/**
 * The stored state as a record, or an empty one when nothing readable is stored. Legacy state is
 * left to `loadState`, which migrates it on the first page load.
 */
const storedRecord = (): Record<string, unknown> => {
  try {
    const parsed: unknown = JSON.parse(storedValue(STORAGE_KEY) ?? '{}')
    return isRecord(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

/** The global settings as stored right now, without loading the rest of the state. */
export const storedGlobalSettings = (): GlobalSettings =>
  globalSettingsFrom({ ...storedRecord(), ...storedSwitches() })

/** This tab's global settings. */
export const currentGlobalSettings = (): GlobalSettings => globalSettingsFrom(state)

/** Change one global setting in storage; the toolbar popup's write. Open tabs adopt it from there. */
export const storeGlobalSetting = (key: keyof GlobalSettings, value: boolean): void =>
  storeSwitches({ [key]: value })

/**
 * A global setting changed in the toolbar popup or another tab applies here without a reload. Only
 * those switches are adopted: the rest of this tab's state, such as its live server connections,
 * stays its own.
 */
const adoptStoredGlobalSettings = (key: string): void => {
  if (key !== STORAGE_KEY && !key.startsWith(SWITCH_PREFIX)) return
  const next = storedGlobalSettings()
  if (GLOBAL_SETTINGS.every((name) => state[name] === next[name])) return
  state = { ...state, ...next }
  notifyStateListeners()
}

let followingStoredSettings = false

/** Read the stored settings and follow changes made elsewhere. Runs once, before anything reads them. */
export const loadState = (): State => {
  if (!followingStoredSettings) {
    followingStoredSettings = true
    onStoredValueChange(adoptStoredGlobalSettings)
  }
  const storedRaw = readRaw()
  if (storedRaw === null) {
    // No record yet, but the switches may already be set, from the extension's popup.
    state = { ...state, ...globalSettingsFrom(storedSwitches()) }
    return state
  }
  try {
    // Every field is decoded rather than trusting the stored shape: a build that adds a field must
    // not be broken by state written before it existed.
    const parsed: unknown = JSON.parse(storedRaw.value)
    if (!isRecord(parsed)) throw new TypeError('stored state is not an object')
    const stored: Record<string, unknown> = { ...parsed, ...storedSwitches() }
    const context: DecodeContext = {
      legacyPalette: storedRaw.legacyPalette,
      servers: decodeServers(parsed.servers),
      migrated: false,
    }
    state = stateFrom((name) => FIELDS[name].decode(stored[name], context))
    log('install', 'state loaded', { servers: state.servers.length })
    if (storedRaw.legacyPalette || context.migrated) writeRaw(JSON.stringify(state))
    notifyStateListeners()
  } catch (error) {
    warn('install', 'stored state was unreadable; starting fresh', String(error))
  }
  return state
}

export const getState = (): State => state

/** The global appearance currently shown on the map, including an uncommitted slider gesture. */
let globalAppearancePreview: Appearance | null = null
const allianceAppearancePreviews = new Map<string, Appearance>()

let worldAppearance: {
  readonly source: Appearance
  readonly hiddenColours: readonly number[]
  readonly appearance: Appearance
} | null = null

/** Where this alliance canvas's preferences sit in state, or -1. */
const allianceAppearanceIndex = (key: string): number =>
  state.allianceSurfaceAppearances.findIndex(
    (candidate) => templateSurfaceKey(candidate.surface) === key,
  )

/**
 * The defaults inherited by templates on this exact canvas.
 *
 * The same object until those defaults change, so renderers can compare it by identity.
 */
export const getSurfaceAppearance = (surface: TemplateSurface): Appearance => {
  if (surface.kind === 'world') {
    const source = globalAppearancePreview ?? state.appearance
    if (worldAppearance?.source !== source || worldAppearance.hiddenColours !== state.hiddenColours)
      worldAppearance = {
        source,
        hiddenColours: state.hiddenColours,
        appearance: { ...source, hiddenColours: state.hiddenColours },
      }
    return worldAppearance.appearance
  }
  const key = templateSurfaceKey(surface)
  return (
    allianceAppearancePreviews.get(key) ??
    state.allianceSurfaceAppearances[allianceAppearanceIndex(key)]?.appearance ??
    DEFAULT_APPEARANCE
  )
}

/** Whether this exact canvas follows Wplace's selected paint colour. */
export const onlySelectedColourFor = (surface: TemplateSurface): boolean =>
  surface.kind === 'world'
    ? state.onlySelectedColour
    : (state.allianceSurfaceAppearances[allianceAppearanceIndex(templateSurfaceKey(surface))]
        ?.onlySelectedColour ?? false)

/** Change one alliance canvas's preferences, adding its entry when it has none and there is room. */
const commitAllianceAppearance = (
  surface: Exclude<TemplateSurface, { readonly kind: 'world' }>,
  change: (current: AllianceSurfaceAppearance) => AllianceSurfaceAppearance,
): boolean => {
  const preferences = state.allianceSurfaceAppearances
  const index = allianceAppearanceIndex(templateSurfaceKey(surface))
  if (index === -1 && preferences.length >= MAX_ALLIANCE_SURFACE_APPEARANCES) return false
  return commitState({
    allianceSurfaceAppearances:
      index === -1
        ? [
            ...preferences,
            change({ surface, appearance: DEFAULT_APPEARANCE, onlySelectedColour: false }),
          ]
        : preferences.map((candidate, at) => (at === index ? change(candidate) : candidate)),
  })
}

/** Change the selected-colour view mode without leaking it into another canvas. */
export const setOnlySelectedColourFor = (
  surface: TemplateSurface,
  onlySelectedColour: boolean,
): boolean => {
  if (surface.kind === 'world') {
    setState({ onlySelectedColour })
    return true
  }
  return commitAllianceAppearance(surface, (current) => ({ ...current, onlySelectedColour }))
}

/** Preview one canvas's inherited appearance without leaking it into the world renderer. */
export const previewSurfaceAppearance = (
  surface: TemplateSurface,
  appearance: Appearance | null,
): void => {
  if (surface.kind === 'world') {
    globalAppearancePreview = appearance
    return
  }
  const key = templateSurfaceKey(surface)
  if (appearance === null) allianceAppearancePreviews.delete(key)
  else allianceAppearancePreviews.set(key, appearance)
}

/** Persist one alliance canvas's inherited appearance independently of every other canvas. */
export const setSurfaceAppearance = (
  surface: Exclude<TemplateSurface, { readonly kind: 'world' }>,
  appearance: Appearance,
): boolean => {
  const key = templateSurfaceKey(surface)
  if (
    allianceAppearanceIndex(key) === -1 &&
    state.allianceSurfaceAppearances.length >= MAX_ALLIANCE_SURFACE_APPEARANCES
  )
    return false
  allianceAppearancePreviews.delete(key)
  return commitAllianceAppearance(surface, (current) => ({ ...current, surface, appearance }))
}

export const setState = (patch: Partial<State>): State => {
  if (patch.appearance !== undefined) globalAppearancePreview = null
  if (patch.allianceSurfaceAppearances !== undefined) allianceAppearancePreviews.clear()
  state = { ...state, ...patch }
  writeRaw(JSON.stringify(state))
  storeSwitches(patch)
  notifyStateListeners()
  return state
}

/** Commit only if the browser accepts the durable copy; used where the caller reports save status. */
export const commitState = (patch: Partial<State>): boolean => {
  const next = { ...state, ...patch }
  if (!writeRaw(JSON.stringify(next))) return false
  storeSwitches(patch)
  state = next
  notifyStateListeners()
  return true
}

export const onStateChange = (listener: (next: State) => void): void => {
  listeners.push(listener)
}

export const isScopeVisible = (key: string): boolean => !state.hiddenScopes.includes(key)

export const setScopeVisible = (key: string, visible: boolean): boolean => {
  const hidden = state.hiddenScopes
  if (visible === !hidden.includes(key)) return true
  return commitState({
    hiddenScopes: visible ? hidden.filter((candidate) => candidate !== key) : [...hidden, key],
  })
}

export const serverTemplatePreference = (id: string): ServerTemplatePreference | undefined =>
  state.serverTemplatePreferences.find((preference) => preference.id === id)

/** Save browser-owned appearance independently of the server-owned pixels and metadata. */
export const setServerTemplatePreference = (
  id: string,
  appearance: Appearance | null,
  owns: readonly AppearanceGroup[],
): boolean => {
  if (!id.startsWith('srv:') || id.length > 2_048) return false
  const preferences = state.serverTemplatePreferences
  const index = preferences.findIndex((preference) => preference.id === id)
  if (appearance === null && owns.length === 0) {
    if (index !== -1) {
      return commitState({
        serverTemplatePreferences: preferences.filter((_, at) => at !== index),
      })
    }
    return true
  }
  if (index === -1 && preferences.length >= MAX_SERVER_TEMPLATE_PREFERENCES) return false
  const preference: ServerTemplatePreference = {
    id,
    appearance,
    owns: [...new Set(owns)].filter((group) => APPEARANCE_GROUPS.includes(group)),
  }
  return commitState({
    serverTemplatePreferences:
      index === -1
        ? [...preferences, preference]
        : preferences.map((current, at) => (at === index ? preference : current)),
  })
}

export const removeTreeStateKeys = (keys: ReadonlySet<string>): void => {
  const customOrder = state.customOrder.filter((key) => !keys.has(key))
  const collapsed = state.collapsed.filter((key) => !keys.has(key))
  if (
    customOrder.length !== state.customOrder.length ||
    collapsed.length !== state.collapsed.length
  )
    setState({ customOrder, collapsed })
}

/** Drop visibility state that belongs to a disconnected source. */
export const forgetScopes = (keys: Iterable<string>): void => {
  const drop = new Set(keys)
  const hiddenScopes = state.hiddenScopes.filter((key) => !drop.has(key))
  if (hiddenScopes.length !== state.hiddenScopes.length) setState({ hiddenScopes })
}
