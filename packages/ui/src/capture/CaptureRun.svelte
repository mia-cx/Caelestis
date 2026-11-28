<script lang="ts">
  import {
    CAPTURE_LEAD_STEP_MS,
    CAPTURE_STAGGER_STEP_MS,
    MAX_CAPTURE_LEAD_MS,
    MAX_CAPTURE_STAGGER_MS,
    MIN_CAPTURE_LEAD_MS,
    MIN_CAPTURE_STAGGER_MS,
  } from '@caelestis/shared'
  import Button from '../foundations/Button.svelte'
  import Icon from '../foundations/Icon.svelte'
  import type { CaptureRunIntent, CaptureRunMember, CaptureRunModel } from './model.js'

  let { model, onIntent }: { model: CaptureRunModel; onIntent: (intent: CaptureRunIntent) => void } =
    $props()

  /** A leg for every painter, or the fewest legs with the other painters in reserve. */
  const DISTRIBUTIONS = [
    { id: 'even', label: 'Even' },
    { id: 'reserve', label: 'Reserve' },
  ] as const

  /** Whole seconds left at which the countdown is announced; it stays silent in between. */
  const ANNOUNCED_SECONDS = [1, 2, 3, 5, 10] as const

  const gathering = $derived(model.phase === 'gathering')
  const listing = $derived(model.phase === 'list')
  const painters = (n: number): string => `${n} ${n === 1 ? 'painter' : 'painters'}`
  const needs = (n: number): string => `Needs ${n} more ${n === 1 ? 'painter' : 'painters'}`
  /** What a member's row says under their name, e.g. "Host · Closes wall". */
  const roles = (member: CaptureRunMember): string =>
    [member.hosts ? 'Host' : '', member.closes ? 'Closes wall' : member.reserve ? 'Reserve' : '']
      .filter(Boolean)
      .join(' · ')
  /** The rows the host can move; the closer's place is fixed. */
  const movable = $derived(model.members.filter((member) => !member.closes))
  const counting = $derived(model.phase === 'countdown')
  const ordinal = new Intl.PluralRules('en', { type: 'ordinal' })
  const SUFFIX: Partial<Record<Intl.LDMLPluralRule, string>> = { one: 'st', two: 'nd', few: 'rd' }
  const nth = (n: number): string => `${n}${SUFFIX[ordinal.select(n)] ?? 'th'}`

  /** This painter's slot, or the first painter's for everyone else, while counting down. */
  const mine = $derived(model.mySlotAt !== null)
  const deadline = $derived(counting ? (model.mySlotAt ?? model.startsAt) : null)

  /** The frame clock, in `performance.now()` time; it only ticks while a deadline is set. */
  let now = $state(performance.now())
  $effect(() => {
    if (deadline === null) return
    now = performance.now()
    let frame = requestAnimationFrame(function tick(at) {
      now = at
      frame = requestAnimationFrame(tick)
    })
    return () => cancelAnimationFrame(frame)
  })
  const left = $derived(deadline === null ? 0 : Math.max(0, deadline - now))

  const pad = (n: number, width: number): string => String(n).padStart(width, '0')
  /** `mm:ss.mmm`, e.g. 00:09.437. */
  const clock = (ms: number): string => {
    const whole = Math.floor(ms)
    return `${pad(Math.floor(whole / 60_000), 2)}:${pad(Math.floor(whole / 1000) % 60, 2)}.${pad(whole % 1000, 3)}`
  }
  const seconds = (n: number): string => `${n} ${n === 1 ? 'second' : 'seconds'}`

  /** Polite and text-only: the string, and so the DOM, changes only on the announced seconds. */
  const announcement = $derived.by(() => {
    if (model.phase === 'gathering') return model.locked ? 'Wall locked in' : 'In capture lobby'
    if (model.phase === 'done') return 'Capture finished'
    if (!counting) return ''
    if (deadline === null || left === 0) return mine ? 'Paint now' : 'Painting'
    const mark = ANNOUNCED_SECONDS.find((second) => second >= Math.ceil(left / 1000))
    if (mark === undefined) return 'Countdown started'
    return mine ? `Paint in ${seconds(mark)}` : `First painter in ${seconds(mark)}`
  })

  const guarding = $derived(model.anchor !== null && (model.phase === 'done' || (mine && left === 0)))
  /** The clock, the anchor watch or the finish: what the card shows even when collapsed. */
  const glance = $derived(guarding || counting || model.phase === 'done')

  /** The bar's line under the title: open lobbies, or the lobby's size and, once locked, readiness. */
  const summary = $derived.by(() => {
    if (listing) return [model.lobbies.length === 0 ? 'None open' : `${model.lobbies.length} open`]
    const size = painters(model.members.length)
    // The legs Start countdown waits on: guards and reserves don't hold it.
    const legs = model.members.filter((member) => member.length > 0 && !member.guard)
    if (!gathering || legs.length === 0) return [size]
    const ready = legs.filter((member) => member.drafted >= member.length).length
    return [size, `${ready} of ${legs.length} ready`]
  })

  /** The host's settings fold away to their values; open while they set up a lobby. */
  let settingsOpen = $state(false)
  const guards = (n: number): string => `${n} ${n === 1 ? 'guard' : 'guards'}`
  const settingsSummary = $derived([
    painters(model.painters),
    guards(model.guards),
    DISTRIBUTIONS.find(({ id }) => id === model.distribution)?.label ?? '',
    `${model.staggerMs} ms`,
    `${model.leadMs / 1000} s`,
  ])

  const clampPainters = (n: number): number => Math.min(model.maxPainters, Math.max(1, Math.round(n)))
  const setPainters = (painters: number): void => onIntent({ type: 'set-painters', painters })
  const typePainters = (event: Event & { currentTarget: HTMLInputElement }): void => {
    const typed = Number(event.currentTarget.value)
    const painters = Number.isFinite(typed) ? clampPainters(typed) : model.painters
    // The model may not change, so put a refused or clamped value back by hand.
    event.currentTarget.value = String(painters)
    if (painters !== model.painters) setPainters(painters)
  }
</script>

<!-- A summary's values, each kept whole: a long summary wraps between them rather than hiding one. -->
{#snippet parts(values: readonly string[])}
  {#each values as value, index (index)}{#if index > 0}{' · '}{/if}<span class="part">{value}</span>{/each}
{/snippet}

<section class="card caelestis-surface" class:bare={model.collapsed && !glance && !model.message} aria-labelledby="capture-run-title">
  <!-- The bar: it stays when the card collapses, and toggles the rest. -->
  <h2 class="bar">
    <button type="button" class="disclosure" aria-expanded={!model.collapsed} aria-controls="capture-run-body" onclick={() => onIntent({ type: 'set-collapsed', collapsed: !model.collapsed })}>
      <span class="mark"><Icon name="painters" size="1.125rem" /></span>
      <span class="heading">
        <span class="title"><span id="capture-run-title">{listing ? 'Capture lobbies' : 'Capture lobby'}</span><span class="chevron"><Icon name="expandMore" /></span></span>
        <span class="summary">{@render parts(summary)}</span>
      </span>
    </button>
  </h2>

  {#if guarding}
    <div class="clock" class:cut={model.anchor === 'cut'}>
      <p class="lead"><span>Anchor guard</span></p>
      <p class="big">{model.anchor === 'cut' ? 'Anchor cut' : 'Anchor holding'}</p>
      {#if model.anchor === 'cut'}<p>Repaint your line.</p>{/if}
    </div>
  {:else if counting}
    {@const atSlot = mine && left === 0}
    <!-- Hidden from screen readers: the live region below speaks it on whole seconds instead. -->
    <div class="clock" class:now={atSlot} aria-hidden="true">
      <p class="lead">
        <span>{left > 0 ? (mine ? 'Paint in' : 'First painter in') : mine ? 'Paint now' : 'Painting'}</span>
        {#if model.anchor !== null}<span class="turn">Anchor guard</span>{:else if model.myTurn !== null}<span class="turn">{nth(model.myTurn)} of {model.turns}</span>{/if}
      </p>
      <p class="big">{clock(left)}</p>
    </div>
  {:else if model.phase === 'done'}
    <p class="big done">Capture finished</p>
  {/if}

  {#if model.message}<p class="message">{model.message}</p>{/if}

  <div class="body" id="capture-run-body" hidden={model.collapsed}>
    {#if listing}
      {#if model.lobbies.length > 0}
        <ul class="lobbies" aria-label="Open lobbies">
          {#each model.lobbies as lobby (lobby.id)}
            <li>
              <span class="plan">
                <span class="plan-label">{lobby.name}</span>
                <span class="plan-stats">{painters(lobby.members)}</span>
              </span>
              <Button label="Join" size="compact" kind="primary" disabled={!lobby.canJoin} onclick={() => onIntent({ type: 'join', id: lobby.id })}>Join<span class="hidden"> {lobby.name}</span></Button>
            </li>
          {/each}
        </ul>
      {/if}
    {:else}
      {#if model.canRun && gathering}
        <div class="settings">
          <button type="button" class="disclosure" aria-expanded={settingsOpen} aria-controls="capture-run-settings" onclick={() => (settingsOpen = !settingsOpen)}>
            <span class="heading">
              <span class="title">Settings<span class="chevron"><Icon name="expandMore" /></span></span>
              <span class="summary">{@render parts(settingsSummary)}</span>
            </span>
          </button>
          <div class="grid" id="capture-run-settings" hidden={!settingsOpen}>
            <label for="capture-run-painters">Painters</label>
            <div class="stepper">
              <Button label="Fewer painters" kind="ghost" size="small" iconOnly disabled={model.painters <= 1} onclick={() => setPainters(model.painters - 1)}><Icon name="remove" /></Button>
              <input id="capture-run-painters" class="caelestis-field" type="number" inputmode="numeric" min="1" max={model.maxPainters} value={model.painters} onchange={typePainters} />
              <Button label="More painters" kind="ghost" size="small" iconOnly disabled={model.painters >= model.maxPainters} onclick={() => setPainters(model.painters + 1)}><Icon name="add" /></Button>
            </div>
            <span class="label" id="capture-run-guards">Anchor guards</span>
            <div class="stepper" role="group" aria-labelledby="capture-run-guards">
              <Button label="Fewer guards" kind="ghost" size="small" iconOnly disabled={model.guards <= 0} onclick={() => onIntent({ type: 'set-guards', guards: model.guards - 1 })}><Icon name="remove" /></Button>
              <output class="caelestis-field">{model.guards}</output>
              <Button label="More guards" kind="ghost" size="small" iconOnly disabled={model.guards >= model.maxGuards} onclick={() => onIntent({ type: 'set-guards', guards: model.guards + 1 })}><Icon name="add" /></Button>
            </div>
            <span class="label" id="capture-run-distribution">Legs</span>
            <div class="choices" role="group" aria-labelledby="capture-run-distribution">
              {#each DISTRIBUTIONS as option (option.id)}
                <Button label={option.label} size="small" pressed={model.distribution === option.id} onclick={() => onIntent({ type: 'set-distribution', distribution: option.id })} />
              {/each}
            </div>
            <span class="label" id="capture-run-stagger">Stagger</span>
            <div class="stepper" role="group" aria-labelledby="capture-run-stagger">
              <Button label="Shorter stagger" kind="ghost" size="small" iconOnly disabled={model.staggerMs <= MIN_CAPTURE_STAGGER_MS} onclick={() => onIntent({ type: 'set-stagger', staggerMs: model.staggerMs - CAPTURE_STAGGER_STEP_MS })}><Icon name="remove" /></Button>
              <output class="caelestis-field wide">{model.staggerMs} ms</output>
              <Button label="Longer stagger" kind="ghost" size="small" iconOnly disabled={model.staggerMs >= MAX_CAPTURE_STAGGER_MS} onclick={() => onIntent({ type: 'set-stagger', staggerMs: model.staggerMs + CAPTURE_STAGGER_STEP_MS })}><Icon name="add" /></Button>
            </div>
            <span class="label" id="capture-run-lead">Countdown</span>
            <div class="stepper" role="group" aria-labelledby="capture-run-lead">
              <Button label="Shorter countdown" kind="ghost" size="small" iconOnly disabled={model.leadMs <= MIN_CAPTURE_LEAD_MS} onclick={() => onIntent({ type: 'set-lead', leadMs: model.leadMs - CAPTURE_LEAD_STEP_MS })}><Icon name="remove" /></Button>
              <output class="caelestis-field wide">{model.leadMs / 1000} s</output>
              <Button label="Longer countdown" kind="ghost" size="small" iconOnly disabled={model.leadMs >= MAX_CAPTURE_LEAD_MS} onclick={() => onIntent({ type: 'set-lead', leadMs: model.leadMs + CAPTURE_LEAD_STEP_MS })}><Icon name="add" /></Button>
            </div>
          </div>
        </div>
      {/if}

      {#if model.members.length > 0}
        <ol class="members" aria-label="Paint order">
          {#each model.members as member, index (member.id)}
            {@const ready = member.length > 0 && member.drafted >= member.length}
            <li class:me={member.me} class:ordered={model.canRun && gathering && !member.closes}>
              {#if member.guard}<span class="place" aria-label="Anchor guard" title="Anchor guard">G</span>{:else}<span class="place">{index + 1}</span>{/if}
              <span class="swatch" style:background-color={member.colour} aria-hidden="true"></span>
              <span class="who">
                <span class="name" title={member.name}>{member.name}{#if member.me}<span class="you">· You</span>{/if}</span>
                {#if roles(member)}<span class="role">{roles(member)}</span>{/if}
              </span>
              {#if member.length > 0}
                <span class="ready" class:done={ready} aria-label={`${member.drafted} of ${member.length} pixels drafted`}>{#if ready}<Icon name="check" size="0.875rem" />{/if}{member.drafted}/{member.length}</span>
              {/if}
              {#if member.me && member.length > 0 && model.phase !== 'done'}
                <Button label="Show my line" kind="ghost" size="compact" iconOnly onclick={() => onIntent({ type: 'show-line' })}><Icon name="flyTo" size="0.875rem" /></Button>
              {/if}
              <!-- The closer keeps their place: their row doesn't move, and moves step over it. -->
              {#if model.canRun && gathering && !member.closes}
                {@const place = movable.indexOf(member)}
                <span class="order">
                  <Button label={`Give ${member.name} the closing leg`} title="Give closing leg" kind="ghost" size="compact" iconOnly onclick={() => onIntent({ type: 'closer', id: member.id })}><Icon name="flag" size="0.875rem" /></Button>
                  <Button label={`Move ${member.name} up`} kind="ghost" size="compact" iconOnly disabled={place === 0} onclick={() => onIntent({ type: 'move', id: member.id, by: -1 })}><Icon name="expandLess" size="0.875rem" /></Button>
                  <Button label={`Move ${member.name} down`} kind="ghost" size="compact" iconOnly disabled={place === movable.length - 1} onclick={() => onIntent({ type: 'move', id: member.id, by: 1 })}><Icon name="expandMore" size="0.875rem" /></Button>
                </span>
              {/if}
            </li>
          {/each}
        </ol>
      {/if}

      {#if (model.role === 'painter' || model.role === 'guard') && gathering && model.locked}
        <ol class="steps" aria-label="What to do">
          <li>Make your way over to your leg by drawing like a caterpillar</li>
          <li>Wait for the countdown</li>
          <li>Click Paint when your timer hits 0</li>
          {#if model.role === 'guard'}<li>Watch and repair your anchor point</li>{/if}
        </ol>
      {/if}

      {#if model.canRun && gathering && (model.locked || model.proposals.length > 0)}
        <div class="plans">
          {#if model.locked}
            {#if model.needs > 0}<p class="plan-stats">{needs(model.needs)}</p>{/if}
            <Button label="Cancel proposed shape" size="small" onclick={() => onIntent({ type: 'unlock' })} />
          {:else}
            <ul aria-label="Proposals">
              {#each model.proposals as proposal (proposal.id)}
                <li>
                  <span class="plan">
                    <span class="plan-label">{proposal.label}</span>
                    <span class="plan-stats">Gains {proposal.gained.toLocaleString()} · paints {proposal.pixels.toLocaleString()}</span>
                    {#if proposal.needs > 0}<span class="plan-stats">{needs(proposal.needs)}</span>{/if}
                  </span>
                  <Button label="Lock in" size="compact" disabled={proposal.needs > 0} onclick={() => onIntent({ type: 'lock', id: proposal.id })}>Lock in<span class="hidden"> {proposal.label}</span></Button>
                </li>
              {/each}
            </ul>
          {/if}
        </div>
      {/if}
    {/if}

    {#if listing ? model.canOpen : gathering || model.phase === 'done' || model.canRun}
      <footer>
        {#if listing}
          <Button label="New lobby" kind={model.lobbies.length > 0 ? 'default' : 'primary'} size="small" onclick={() => onIntent({ type: 'open' })} />
        {:else}
          {#if model.phase !== 'countdown'}<Button label="Leave" kind="ghost" size="small" onclick={() => onIntent({ type: 'leave' })} />{/if}
          {#if model.canRun}
            <span class="end">
              <Button label="Close lobby" kind="danger-ghost" size="small" onclick={() => onIntent({ type: 'close' })} />
              {#if gathering && model.locked}<Button label="Start countdown" kind="primary" size="small" disabled={!model.canStart} onclick={() => onIntent({ type: 'go' })} />{/if}
              {#if model.phase === 'done'}<Button label="Plan next shape" kind="primary" size="small" onclick={() => onIntent({ type: 'unlock' })} />{/if}
            </span>
          {/if}
        {/if}
      </footer>
    {/if}
  </div>

  <!-- Mounted for the card's lifetime so changes are announced; not atomic, so a countdown tick
       does not repeat the message. -->
  <div class="hidden" role="status">
    <p>{announcement}</p>
    <p>{model.message ?? ''}</p>
  </div>
</section>

<style>
  .card {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    box-sizing: border-box;
    inline-size: 17rem;
    max-inline-size: 100%;
    max-block-size: inherit;
    overflow-y: auto;
    padding: 0.25rem 0.75rem 0.75rem;
    border: 1px solid var(--caelestis-border);
    border-radius: var(--caelestis-radius);
    background: var(--caelestis-surface);
    color: var(--caelestis-text);
    box-shadow: var(--caelestis-popover-shadow);
    font: 400 0.8125rem/1.4 var(--caelestis-font);
  }
  /* Collapsed to the bar alone, the card frames it evenly. */
  .card.bare { padding-block-end: 0.25rem; }
  p { margin: 0; }
  h2 { margin: 0; font: inherit; }
  .body { display: flex; flex-direction: column; gap: 0.5rem; }

  /* The bar's button spans the card, so the whole bar toggles it; the settings use the same row. */
  /* The chevron rides the title line, so the summary under it has the full width. */
  .disclosure {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    box-sizing: border-box;
    inline-size: calc(100% + 1rem);
    min-block-size: 2.5rem;
    margin-inline: -0.5rem;
    padding: 0.25rem 0.5rem;
    border: 0;
    border-radius: calc(var(--caelestis-radius) - 2px);
    background: transparent;
    color: inherit;
    font: inherit;
    text-align: start;
    cursor: pointer;
    touch-action: manipulation;
  }
  @media (hover: hover) {
    .disclosure:hover { background: color-mix(in oklab, currentColor 8%, transparent); }
  }
  .disclosure:focus-visible { outline: 2px solid var(--caelestis-focus); outline-offset: -2px; }
  .heading { display: flex; flex: 1; flex-direction: column; min-inline-size: 0; }
  .title { display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; font: 600 0.875rem/1.25rem var(--caelestis-font); }
  .mark { display: grid; flex: none; place-items: center; }
  .summary { color: var(--caelestis-muted-text); font-size: 0.75rem; line-height: 1.3; font-variant-numeric: tabular-nums; }
  .part { white-space: nowrap; }
  .chevron { display: grid; flex: none; place-items: center; color: var(--caelestis-muted-text); }
  [aria-expanded='true'] .chevron { rotate: 180deg; }
  @media (prefers-reduced-motion: no-preference) {
    .chevron { transition: rotate var(--caelestis-duration-quick) var(--caelestis-ease-smooth-out); }
  }

  .place, .ready, .plan-stats, .turn, .big { font-variant-numeric: tabular-nums; }

  .settings { display: flex; flex-direction: column; gap: 0.5rem; padding-block-end: 0.5rem; border-block-end: 1px solid var(--caelestis-border); }
  .settings .title { font-size: 0.8125rem; }
  .grid { display: grid; grid-template-columns: max-content 1fr; align-items: center; gap: 0.5rem; }
  .grid :is(label, .label) { font-weight: 600; }
  .grid .stepper output {
    display: grid;
    place-items: center;
    inline-size: 3rem;
    block-size: 2rem;
    font: 600 0.875rem/1 var(--caelestis-font);
    font-variant-numeric: tabular-nums;
  }
  .grid .stepper output.wide { inline-size: 4.5rem; }
  .body[hidden], .grid[hidden] { display: none; }
  .stepper, .choices { display: flex; align-items: center; gap: 0.125rem; }
  .stepper input {
    inline-size: 3rem;
    block-size: 2rem;
    padding: 0 0.25rem;
    border: 1px solid var(--caelestis-border);
    border-radius: var(--caelestis-radius);
    background: var(--caelestis-raised-surface);
    color: inherit;
    font: 600 0.875rem/1 var(--caelestis-font);
    font-variant-numeric: tabular-nums;
    text-align: center;
    appearance: textfield;
  }
  .stepper input::-webkit-inner-spin-button, .stepper input::-webkit-outer-spin-button { margin: 0; appearance: none; }
  .stepper input:focus-visible { outline: 2px solid var(--caelestis-focus); outline-offset: 2px; }

  /* Read at a glance over a live map: large tabular numerals, the lead word smaller. */
  .big { font: 700 1.75rem/1.1 var(--caelestis-font); font-variant-numeric: tabular-nums; }
  .big.done { font-size: 1.25rem; }
  .lead { display: flex; justify-content: space-between; gap: 0.5rem; color: var(--caelestis-muted-text); font-weight: 600; }
  .turn { font-weight: 400; }
  /* At this painter's slot the lead and the zeroed clock both turn primary; the words carry it too. */
  .clock.now :is(.lead span:first-child, .big) { color: var(--caelestis-primary); }
  .clock.cut .big { color: var(--caelestis-danger); }

  .members, .plans ul, .lobbies { display: flex; flex-direction: column; gap: 0.125rem; margin: 0; padding: 0; list-style: none; }
  .members li {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    min-block-size: 1.75rem;
    padding-inline: 0.375rem 0.125rem;
    border-radius: calc(var(--caelestis-radius) - 2px);
  }
  .members li.me { background: var(--caelestis-raised-surface); }
  .place { inline-size: 1rem; color: var(--caelestis-muted-text); text-align: end; }
  .swatch { flex: none; inline-size: 0.75rem; block-size: 0.75rem; border: 1px solid color-mix(in oklab, var(--caelestis-text) 30%, transparent); border-radius: 2px; }
  .who { display: flex; flex: 1; flex-direction: column; min-inline-size: 0; }
  .name, .role { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .you { margin-inline-start: 0.25em; color: var(--caelestis-muted-text); }
  .role { color: var(--caelestis-muted-text); font-size: 0.75rem; line-height: 1.2; }
  .ready { display: inline-flex; align-items: center; gap: 0.125rem; color: var(--caelestis-muted-text); }
  .ready.done { color: var(--caelestis-success); }
  .order { display: inline-flex; }

  .plans { display: flex; flex-direction: column; align-items: start; gap: 0.375rem; padding-block-start: 0.5rem; border-block-start: 1px solid var(--caelestis-border); }
  .plans ul { align-self: stretch; }
  .plans li, .lobbies li { display: flex; align-items: center; gap: 0.5rem; padding: 0.25rem 0.375rem; border-radius: calc(var(--caelestis-radius) - 2px); }
  .plan { display: flex; flex: 1; flex-direction: column; min-inline-size: 0; }
  .plan-label { font-weight: 600; overflow-wrap: anywhere; }
  .plan-stats { color: var(--caelestis-muted-text); font-size: 0.75rem; }

  .message { color: var(--caelestis-muted-text); overflow-wrap: anywhere; }

  .steps { display: flex; flex-direction: column; gap: 0.375rem; margin: 0; padding-inline-start: 1.25rem; }
  .steps li::marker { color: var(--caelestis-muted-text); font-variant-numeric: tabular-nums; }

  footer { display: flex; flex-wrap: wrap; align-items: center; gap: 0.375rem; }
  .end { display: flex; gap: 0.375rem; margin-inline-start: auto; }

  /*
   * A finger needs a 44px target. Every button in the card grows to it, the steppers' fields with
   * them, and a row the host orders puts its buttons on a line of their own under the name.
   */
  @media (pointer: coarse) {
    .card :global(button:is(.compact, .small)) { --button-size: 2.75rem; }
    .disclosure { min-block-size: 2.75rem; }
    /* The 44px steppers keep their width; a long label such as "Anchor guards" wraps instead of
       pushing the card sideways. */
    .grid { grid-template-columns: minmax(0, 1fr) max-content; }
    .grid :is(label, .label) { overflow-wrap: anywhere; }
    .grid .stepper :is(input, output) { block-size: 2.75rem; }
    .grid .stepper output.wide { inline-size: 4rem; }
    .stepper { gap: 0; }
    .members li.ordered { flex-wrap: wrap; row-gap: 0; padding-block-start: 0.375rem; }
    .members li.ordered .who { flex: 1 0 calc(100% - 2.75rem); }
    /* The second line: readiness under the name, the buttons at the end. */
    .members li.ordered .ready { margin-inline-start: 2.75rem; }
    .members li.ordered .order { margin-inline-start: auto; }
  }

  .hidden { position: absolute; inline-size: 1px; block-size: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
</style>
