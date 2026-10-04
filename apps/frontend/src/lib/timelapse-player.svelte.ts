import { parseTileKey, type Template, type TileKey } from '@caelestis/shared'
import { untrack } from 'svelte'
import { getArchiveHistory, getTileHistory } from '$lib/api/client'
import { mergeArchiveFrames, type PlaybackFrame } from '$lib/archive-history'
import { persisted } from '$lib/persisted.svelte'
import { type TimelapseLayout, timelapseLayout } from '$lib/render'
import { useApp } from '$lib/state/app.svelte'
import { frameAt, TimelapseClock, transportScale } from '$lib/timelapse'

const timelineOf = (map: ReadonlyMap<TileKey, readonly PlaybackFrame[]>): number[] => {
  const starts = new Set<number>()
  for (const tileFrames of map.values()) {
    for (const frame of tileFrames) starts.add(frame.bucketStart)
  }
  return [...starts].sort((a, b) => a - b)
}

/**
 * One timelapse over a set of templates on a shared world canvas. Each tile loads the history its
 * capturing templates recorded, between the earliest start and latest finish among them.
 *
 * Construct it while a component initialises. `TimelapsePanel` draws it; a linked pace chart seeks
 * it through `seekTo` and `beginScrub`.
 */
export class TimelapsePlayer {
  readonly #templates: () => readonly Template[]
  readonly #app = useApp()

  frames = $state<ReadonlyMap<TileKey, readonly PlaybackFrame[]> | null>(null)
  archiveError = $state<string | null>(null)
  historyEnd = $state(0)
  /** The scrub position: 0..timeline.length, where the last stop is "live". */
  scrub = $state(0)
  playhead = $state(0)
  playing = $state(false)

  // Statuses rebuild the template list often. Reload only when what was recorded can differ.
  readonly #scope = $derived(
    this.templates
      .map((template) => `${template.id}:${template.version}:${template.finishedAt}`)
      .join(' '),
  )
  readonly #season = $derived(this.#app.manifest?.season)
  readonly layout: TimelapseLayout = $derived.by(() => {
    void this.#scope
    return untrack(() => timelapseLayout(this.templates))
  })

  readonly timeline = $derived(this.frames === null ? [] : timelineOf(this.frames))
  readonly #playback = $derived(new TimelapseClock(this.timeline, this.historyEnd))
  // The slider walks a bounded step domain: stepping through recorded seconds made bits-ui build a
  // list of every second in the range on each playhead move, which stalled playback and exhausted
  // memory on phones.
  readonly transport = $derived(
    transportScale(this.timeline[0] ?? this.historyEnd, this.historyEnd),
  )
  readonly live = $derived(this.scrub >= this.timeline.length)
  readonly scrubTime = $derived(this.live ? null : this.timeline[this.scrub])

  /**
   * Each tile shows its live state or its newest snapshot at the scrub time. Missing snapshots keep
   * the tile's last known state.
   */
  readonly hashFor = $derived.by(() => {
    const map = this.frames
    const t = this.scrubTime
    const canvas = this.#app.canvas
    if (t == null || map === null) {
      return (key: TileKey) => canvas.get(key)?.hash
    }
    return (key: TileKey): string | undefined => {
      const tileFrames = map.get(key)
      if (tileFrames === undefined) return undefined
      let hash: string | undefined
      for (const frame of tileFrames) {
        if (frame.bucketStart > t) break
        if (!frame.missing) hash = frame.hash
      }
      return hash
    }
  })

  /** Playback rate: 1× is one recorded hour per 350 ms, independent of snapshot density. */
  readonly #storedSpeed = persisted<number>('caelestis:timelapse-speed', 1)
  readonly speed = $derived(
    Number.isFinite(this.#storedSpeed.value)
      ? Math.min(4, Math.max(0.05, this.#storedSpeed.value))
      : 1,
  )

  constructor(templates: () => readonly Template[]) {
    this.#templates = templates

    $effect(() => {
      const layout = this.layout
      const season = this.#season
      if (season === undefined) return
      return untrack(() => this.#load(layout, season))
    })

    $effect(() => {
      if (!this.playing) return
      const clock = this.#playback
      const end = this.timeline.length
      clock.play(this.speed, (index, time) => {
        this.scrub = index
        this.playhead = Math.floor(time)
        if (index >= end) this.playing = false
      })
      return () => clock.pause()
    })
  }

  get templates(): readonly Template[] {
    return this.#templates()
  }

  setSpeed(value: number): void {
    this.#storedSpeed.value = value
  }

  /** Play from the start after the live stop; otherwise toggle playback in place. */
  toggle(): void {
    if (!this.playing && this.live) {
      this.scrub = 0
      this.playhead = this.timeline[0] ?? this.historyEnd
      this.#playback.seek(this.playhead)
    }
    this.playing = !this.playing
  }

  /**
   * Move the timelapse to a recorded time and pause. The transport and the pace chart both seek
   * through here: times outside the retained history clamp to its ends, and the end stays live.
   */
  seekTo = (time: number): void => {
    const value = Math.floor(
      Math.min(this.historyEnd, Math.max(this.timeline[0] ?? this.historyEnd, time)),
    )
    this.playhead = value
    this.scrub = value >= this.historyEnd ? this.timeline.length : frameAt(this.timeline, value)
    this.#playback.seek(value)
    this.playing = false
  }

  /** A browser-canceled scrub restores both the position and whether playback was running. */
  beginScrub = (): (() => void) => {
    const position = this.playhead
    const wasPlaying = this.playing
    return () => {
      this.seekTo(position)
      this.playing = wasPlaying
    }
  }

  #load(layout: TimelapseLayout, season: number): () => void {
    const generation = { cancelled: false }
    const now = Date.now()
    const endOf = (template: Template): number => Math.floor((template.finishedAt ?? now) / 1_000)
    const fail = (message: string): void => {
      if (!generation.cancelled) this.archiveError = message
    }
    this.historyEnd = Math.max(0, ...this.templates.map(endOf))
    this.frames = null
    this.archiveError = null
    this.playing = false
    // A tile drawn at both ends of the layout still loads its history once.
    const capturing = new Map<TileKey, Set<Template>>()
    for (const { key, templates } of layout.tiles) {
      capturing.set(key, new Set([...(capturing.get(key) ?? []), ...templates]))
    }
    Promise.all(
      [...capturing].map(async ([key, set]) => {
        const templates = [...set]
        const tile = parseTileKey(key)
        if (tile === null) return [key, []] as const
        const from = Math.min(
          ...templates.map((template) => Math.floor(template.createdAt / 1_000)),
        )
        const to = Math.max(...templates.map(endOf)) + 1
        const [archives, response] = await Promise.all([
          Promise.all(
            templates.map((template) =>
              getArchiveHistory(template.id, template.version, tile).then(
                (archive) => archive.frames.filter((frame) => frame.at <= endOf(template)),
                () => {
                  fail('Imported timelapse history could not load.')
                  return []
                },
              ),
            ),
          ),
          getTileHistory(tile.x, tile.y, season, from, to).catch(() => {
            fail('Some timelapse history could not load.')
            return { frames: [] }
          }),
        ])
        return [key, mergeArchiveFrames(response, archives.flat())] as const
      }),
    ).then((entries) => {
      if (generation.cancelled) return
      this.frames = new Map(entries)
      this.scrub = this.timeline.length
      this.playhead = this.historyEnd
    })
    return () => {
      generation.cancelled = true
    }
  }
}
