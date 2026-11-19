import { WPLACE_PALETTE } from '@caelestis/shared'
import { templateBusy } from '../application/template-busy.js'
import { warn } from '../debug.js'
import {
  type Appearance,
  type AppearanceGroup,
  DEFAULT_APPEARANCE,
} from '../templates/appearance.js'
import { clearAppearancePreview, setAppearancePreview } from '../templates/appearance-preview.js'
import { appearanceOf, type PlacedTemplate, templateById } from '../templates/catalog.js'
import { setAppearance, setLocalVisible, setOwnsGroup } from '../templates/template-edits.js'
import { type AppearanceChange, type AppearanceStore, appearanceLabel } from './appearance.js'
import { overlayAppearanceState } from './overlay-appearance-state.js'
import { type OverlayFailureKey, overlayFailures } from './overlay-failures.js'

/**
 * The overlay menu's writes: what the user asked of one template, held until storage answers.
 *
 * There is one menu element for the whole map, so a completion that assumes it still belongs to
 * whatever is on screen will report template A's failure under template B's heading. Every write
 * goes through {@link settle}, which records the outcome against the id it was started for, and
 * lets the next render decide whether that is something to show.
 */

/**
 * The frame's own view of the store.
 *
 * The frame snapshot keeps every row in one coherent catalog generation. A write dispatched later
 * must use `templateById` instead, because it composes against whatever is current at that point.
 */
let frameTemplates: Map<string, PlacedTemplate> | null = null

/**
 * Read templates from `templates` for the duration of one render.
 *
 * A write dispatched later composes against `storedAppearance`, and it must see the store as it is
 * *then*: holding a frame's snapshot past the frame would hand it the values from whenever the map
 * last moved.
 */
export const withFrameTemplates = (templates: readonly PlacedTemplate[], run: () => void): void => {
  frameTemplates = new Map(templates.map((template) => [template.id, template]))
  try {
    run()
  } finally {
    frameTemplates = null
  }
}

export const templateFor = (id: string): PlacedTemplate | undefined =>
  frameTemplates?.get(id) ?? templateById(id)

/** The template's name as it is *now*: a name captured at build time goes stale on a rename. */
export const nameFor = (id: string): string => templateFor(id)?.name ?? 'this template'

const storedAppearance = (id: string): Appearance => {
  const template = templateFor(id)
  return template === undefined ? DEFAULT_APPEARANCE : appearanceOf(template)
}

/** The appearance with every unacknowledged write applied. */
export const appearanceFor = (id: string): Appearance =>
  overlayAppearanceState.current(id, storedAppearance(id))

/** The latest visible edit, including one whose gesture has not reached durable storage yet. */
export const draftedAppearanceFor = (id: string): Appearance =>
  overlayAppearanceState.drafted(id, storedAppearance(id))

/**
 * What the user has asked for but IndexedDB has not acknowledged yet.
 *
 * `setAppearance` and `setLocalVisible` publish to `localTemplates()` only after awaiting the
 * durable write, so between a click and its acknowledgement the store still reports the old value.
 * Editing from the store alone therefore loses every update made inside that window: pick Dot,
 * click a swatch before the write lands, and the swatch's spread puts the shape back to `full`.
 *
 * `seq` is what releases it: the *latest* request owns the intent, so an earlier one completing
 * cannot clear a later one's. Comparing the value instead makes hide → show → hide drop the third
 * request's intent, because it reads the same `false` the first one wrote.
 */
const visibleIntents = new Map<string, { readonly seq: number; readonly value: boolean }>()
let visibleSequence = 0

export const visibleFor = (id: string): boolean =>
  visibleIntents.get(id)?.value ?? templateFor(id)?.visible ?? false

/** Record the latest visibility intent, and hand back the token that may release it. */
export const intendVisible = (id: string, value: boolean): number => {
  const seq = ++visibleSequence
  visibleIntents.set(id, { seq, value })
  return seq
}

/** Release it, unless a later action on the same template has taken ownership. */
export const releaseVisible = (id: string, seq: number): void => {
  if (visibleIntents.get(id)?.seq === seq) visibleIntents.delete(id)
}

/**
 * One write at a time per template, with the payload composed at dispatch.
 *
 * `setAppearance` takes a whole `Appearance`, so a queued edit carries a snapshot of everything,
 * including fields it never touched. If an earlier write conflicts and reconciles another tab's
 * change in between, a snapshot taken before that would put the old value straight back. Composing
 * against the store at the moment the write actually goes out keeps the patch to what was clicked.
 */
const queues = new Map<string, Promise<unknown>>()

const enqueue = async <T>(id: string, run: () => Promise<T>): Promise<T> => {
  const previous = queues.get(id) ?? Promise.resolve()
  const next = previous.then(run, run)
  const settled = next.catch(() => undefined)
  queues.set(id, settled)
  // Drop the tail once it is no longer current, the way `writeInOrder` does, rather than retaining
  // a settled promise per template for the lifetime of the page.
  void settled.then(() => {
    if (queues.get(id) === settled) queues.delete(id)
  })
  return await next
}

interface DurableWrite {
  /** The failures this write reports under, and clears when it succeeds. */
  readonly keys: readonly OverlayFailureKey[]
  readonly run: () => Promise<boolean>
  readonly refused: (name: string) => string
  /** Release this write's intent; runs however it ends. */
  readonly release: () => void
  /** Has the thing this write asked for become true, by any route? */
  readonly satisfied: () => boolean
  /** Queue behind this template's other overlay writes. */
  readonly serialise: boolean
  readonly finished?: () => void
}

/**
 * Run one durable write for `id`, and make sure its outcome is recorded no matter what.
 *
 * The reporting is deliberately *not* conditional on this still being the latest request. Releasing
 * intent is (an older completion must not drop a newer one's), but a refused write is news
 * regardless of what has been clicked since, and tying the two together makes any second click
 * silence the first one's failure.
 */
export const settle = (id: string, write: DurableWrite, rerender: () => void): void => {
  // Not cleared up front: a retry that stalls would take the banner away and show optimistic state
  // indefinitely, when what the user knows so far is still that the last attempt was refused.
  rerender()
  const fail = (): void => {
    for (const key of write.keys) overlayFailures.record(id, key, write.refused, write.satisfied)
  }
  void (write.serialise ? enqueue(id, write.run) : write.run())
    .then(
      (saved) => {
        if (saved) overlayFailures.clear(id, ...write.keys)
        else fail()
      },
      (error: unknown) => {
        // Without this the intent is never released and the menu asserts, indefinitely, a state
        // that was never saved.
        warn('install', `${write.keys.join(', ')} for ${nameFor(id)} threw`, error)
        fail()
      },
    )
    .finally(() => {
      write.release()
      write.finished?.()
      rerender()
    })
}

export const commitVisible = (id: string, next: boolean, rerender: () => void): void => {
  const seq = intendVisible(id, next)
  settle(
    id,
    {
      keys: ['visible'],
      run: async () => await setLocalVisible(id, next),
      refused: (name) => `Could not change visibility for “${name}”.`,
      release: () => releaseVisible(id, seq),
      satisfied: () => templateFor(id)?.visible === next,
      // Not through `enqueue`: `writeInOrder` already serialises by id, and queueing behind our own
      // appearance writes means a tree-row toggle made *after* this click can be applied *before*
      // it and then overwritten, the more recent action losing.
      serialise: false,
    },
    rerender,
  )
}

const groupForProperty = (property: string): AppearanceGroup =>
  property.startsWith('hiddenColours')
    ? 'colours'
    : property.startsWith('mark') ||
        property.startsWith('marker') ||
        property.startsWith('unpainted') ||
        property.startsWith('dimOthers') ||
        property.startsWith('other')
      ? 'markers'
      : 'pixels'

const commitAppearance = (
  id: string,
  { properties, label, patch, satisfied }: AppearanceChange,
  rerender: () => void,
  finished: () => void = () => {},
): void => {
  const seq = overlayAppearanceState.intend(id, properties, patch)
  settle(
    id,
    {
      keys: properties.map((property): OverlayFailureKey => `appearance:${property}`),
      run: async () => {
        for (const group of new Set(properties.map(groupForProperty))) {
          if (!(await setOwnsGroup(id, group, true))) return false
        }
        const base = storedAppearance(id)
        return await setAppearance(id, { ...base, ...patch(base) })
      },
      refused: (name) => `Could not change ${label} for “${name}”.`,
      release: () => overlayAppearanceState.release(id, properties, seq),
      satisfied:
        satisfied ??
        (() => {
          const stored = storedAppearance(id)
          const asked = { ...stored, ...patch(stored) }
          return properties.every((property) => {
            const field = property.split(':')[0] as keyof Appearance
            return JSON.stringify(stored[field]) === JSON.stringify(asked[field])
          })
        }),
      serialise: true,
      finished,
    },
    rerender,
  )
}

/** Commit a previewed value, and drop the preview once storage has answered. */
const commitPreviewed = <K extends keyof Appearance>(
  id: string,
  key: K,
  value: Appearance[K],
  label: string,
  rerender: () => void,
): void =>
  commitAppearance(
    id,
    { properties: [key], label, patch: () => ({ [key]: value }) },
    rerender,
    () => clearAppearancePreview(id, key, value),
  )

/**
 * Write out every draft for `id`, because the gesture that would have committed them is over.
 *
 * One place, reached by every teardown, rather than each of them knowing how to get a value out of
 * an element it is about to remove.
 */
export const flushDrafts = (id: string, rerender: () => void): void => {
  // Taken and cleared *before* any dispatch. `settle` repaints synchronously, and that repaint can
  // come straight back through a teardown into here: iterating a snapshot while entries are still
  // in the map means the re-entrant call commits one and the outer loop commits it again.
  for (const [property, value] of overlayAppearanceState.takeDrafts(id)) {
    commitPreviewed(id, property, value, appearanceLabel(property), rerender)
  }
}

/**
 * One template's own appearance as a store: drafts while dragging, queued writes after.
 *
 * Without `layout`, which belongs to the menu that hosts the editor.
 */
export const templateAppearanceStore = (
  id: string,
  rerender: () => void,
): Omit<AppearanceStore, 'layout'> => {
  // A template being deleted takes no new edits; a draft flushed by a teardown still writes.
  const unlessDeleting =
    <A extends unknown[]>(edit: (...args: A) => void) =>
    (...args: A): void => {
      if (templateBusy(id, 'deleting')) rerender()
      else edit(...args)
    }
  return {
    preview: (key, value) => {
      overlayAppearanceState.setDraft(id, key, value)
      setAppearancePreview(id, key, value)
      rerender()
    },
    commitPreview: (key, value, label) => {
      overlayAppearanceState.clearDraft(id, key)
      if (templateBusy(id, 'deleting')) {
        rerender()
        clearAppearancePreview(id, key, value)
      } else commitPreviewed(id, key, value, label, rerender)
    },
    commit: unlessDeleting((change: AppearanceChange) => commitAppearance(id, change, rerender)),
    toggleColour: unlessDeleting((index: number, visible: boolean) =>
      commitAppearance(
        id,
        {
          properties: [`hiddenColours:${index}`],
          label: `the ${WPLACE_PALETTE[index]?.name ?? 'selected'} colour filter`,
          patch: (base) => {
            const next = new Set(base.hiddenColours)
            if (visible) next.delete(index)
            else next.add(index)
            return { hiddenColours: [...next] }
          },
          satisfied: () => storedAppearance(id).hiddenColours.includes(index) === !visible,
        },
        rerender,
      ),
    ),
    groupOwned: (group, owned) => {
      void setOwnsGroup(id, group, owned)
        .catch((error: unknown) =>
          warn('install', `could not change ${group} ownership`, String(error)),
        )
        .finally(rerender)
    },
  }
}

/** Drop every write-side memory of a template that has gone. */
export const forgetWrites = (id: string): void => {
  overlayAppearanceState.forget(id)
  clearAppearancePreview(id)
  visibleIntents.delete(id)
  queues.delete(id)
  overlayFailures.forget(id)
}

/** Every template with a write-side memory. */
export const writtenIds = (): readonly string[] => [
  ...overlayAppearanceState.ids(),
  ...visibleIntents.keys(),
  ...queues.keys(),
  ...overlayFailures.ids(),
]
