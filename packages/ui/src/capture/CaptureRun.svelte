<script lang="ts">
  import { CAPTURE_STAGGER_STEP_MS, MAX_CAPTURE_STAGGER_MS, MIN_CAPTURE_STAGGER_MS } from '@caelestis/shared'
  import Button from '../foundations/Button.svelte'
  import Icon from '../foundations/Icon.svelte'
  import type { CaptureRunIntent, CaptureRunModel } from './model.js'

  let { model, onIntent }: { model: CaptureRunModel; onIntent: (intent: CaptureRunIntent) => void } =
    $props()

  /** Whole seconds left at which the countdown is announced; it stays silent in between. */
  const ANNOUNCED_SECONDS = [1, 2, 3, 5, 10] as const

  const gathering = $derived(model.phase === 'gathering')
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
    if (model.phase === 'gathering') return 'Capture run open'
    if (model.phase === 'done') return 'Capture run finished'
    if (!counting) return ''
    if (deadline === null || left === 0) return mine ? 'Paint now' : 'Painting'
    const mark = ANNOUNCED_SECONDS.find((second) => second >= Math.ceil(left / 1000))
    if (mark === undefined) return 'Capture run started'
    return mine ? `Paint in ${seconds(mark)}` : `First painter in ${seconds(mark)}`
  })

  const guarding = $derived(model.anchor !== null && (model.phase === 'done' || (mine && left === 0)))

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

<section class="card caelestis-surface" aria-labelledby="capture-run-title">
  <header>
    <Icon name="painters" size="1.125rem" />
    <h2 id="capture-run-title">Capture run</h2>
    {#if model.phase !== 'none'}
      {@const places = model.painters + model.guards}
      <span class="count" aria-label={`${model.members.length} of ${places} places taken`}>{model.members.length}/{places}</span>
    {/if}
  </header>

  {#if model.phase === 'none'}
    {#if model.admin}
      <div class="open">
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
        <span class="label" id="capture-run-stagger">Stagger</span>
        <div class="stepper" role="group" aria-labelledby="capture-run-stagger">
          <Button label="Shorter stagger" kind="ghost" size="small" iconOnly disabled={model.staggerMs <= MIN_CAPTURE_STAGGER_MS} onclick={() => onIntent({ type: 'set-stagger', staggerMs: model.staggerMs - CAPTURE_STAGGER_STEP_MS })}><Icon name="remove" /></Button>
          <output class="caelestis-field wide">{model.staggerMs} ms</output>
          <Button label="Longer stagger" kind="ghost" size="small" iconOnly disabled={model.staggerMs >= MAX_CAPTURE_STAGGER_MS} onclick={() => onIntent({ type: 'set-stagger', staggerMs: model.staggerMs + CAPTURE_STAGGER_STEP_MS })}><Icon name="add" /></Button>
        </div>
        <Button label="Open run" kind="primary" size="small" onclick={() => onIntent({ type: 'open' })} />
      </div>
    {/if}
  {:else}
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
      <p class="big done">Run finished</p>
    {/if}

    {#if model.members.length > 0}
      <ol class="members" aria-label="Paint order">
        {#each model.members as member, index (member.id)}
          {@const ready = member.length > 0 && member.drafted >= member.length}
          <li class:me={member.me}>
            {#if member.guard}<span class="place" aria-label="Anchor guard" title="Anchor guard">G</span>{:else}<span class="place">{index + 1}</span>{/if}
            <span class="swatch" style:background-color={member.colour} aria-hidden="true"></span>
            <span class="who">
              <span class="name" title={member.name}>{member.name}{#if member.me}<span class="you">· You</span>{/if}</span>
              {#if member.closes}<span class="closes">Closes wall</span>{/if}
            </span>
            {#if member.length > 0}
              <span class="ready" class:done={ready} aria-label={`${member.drafted} of ${member.length} pixels drafted`}>{#if ready}<Icon name="check" size="0.875rem" />{/if}{member.drafted}/{member.length}</span>
            {/if}
            {#if member.me && member.length > 0 && model.phase !== 'done'}
              <Button label="Show my line" kind="ghost" size="compact" iconOnly onclick={() => onIntent({ type: 'show-line' })}><Icon name="flyTo" size="0.875rem" /></Button>
            {/if}
            <!-- The closer keeps their place, so no move into or out of it does anything. -->
            {#if model.admin && gathering && !member.closes}
              {@const before = model.members[index - 1]}
              {@const after = model.members[index + 1]}
              <span class="order">
                <Button label={`Move ${member.name} up`} kind="ghost" size="compact" iconOnly disabled={before === undefined || before.closes} onclick={() => onIntent({ type: 'move', id: member.id, by: -1 })}><Icon name="expandLess" size="0.875rem" /></Button>
                <Button label={`Move ${member.name} down`} kind="ghost" size="compact" iconOnly disabled={after === undefined || after.closes} onclick={() => onIntent({ type: 'move', id: member.id, by: 1 })}><Icon name="expandMore" size="0.875rem" /></Button>
              </span>
            {/if}
          </li>
        {/each}
      </ol>
    {:else}
      <p class="empty">No painters yet</p>
    {/if}

    {#if model.role !== null && gathering}
      <ol class="steps" aria-label="What to do">
        <li>Make your way over to your leg by drawing like a caterpillar</li>
        <li>Wait for the countdown</li>
        <li>Click Paint when your timer hits 0</li>
        {#if model.role === 'guard'}<li>Watch and repair your anchor point</li>{/if}
      </ol>
    {/if}

    {#if model.admin && gathering}
      <div class="plans">
        <Button label={model.proposing ? 'Stop planning' : model.proposals.length > 0 ? 'Propose again' : 'Propose plans'} size="small" onclick={() => onIntent({ type: 'propose' })} />
        {#if model.proposals.length > 0}
          <ul aria-label="Plans">
            {#each model.proposals as proposal (proposal.id)}
              <li class:published={proposal.published}>
                <span class="plan">
                  <span class="plan-label">{proposal.label}</span>
                  <span class="plan-stats">Gains {proposal.gained.toLocaleString()} · paints {proposal.pixels.toLocaleString()}</span>
                </span>
                {#if proposal.published}
                  <span class="state"><Icon name="check" size="0.875rem" />Published</span>
                {:else}
                  <Button label="Publish" size="compact" onclick={() => onIntent({ type: 'publish', id: proposal.id })}>Publish<span class="hidden"> {proposal.label}</span></Button>
                {/if}
              </li>
            {/each}
          </ul>
        {/if}
      </div>
    {/if}
  {/if}

  {#if model.message}<p class="message">{model.message}</p>{/if}

  {#if model.phase !== 'none'}
    {@const join = gathering && !model.joined && model.canJoin}
    {@const leave = gathering && model.joined}
    {#if join || leave || model.admin}
      <footer>
        {#if join}<Button label="Join run" kind={model.admin ? 'default' : 'primary'} size="small" onclick={() => onIntent({ type: 'join' })} />{/if}
        {#if leave}<Button label="Leave run" kind="ghost" size="small" onclick={() => onIntent({ type: 'leave' })} />{/if}
        {#if model.admin}
          <span class="end">
            <Button label="Close run" kind="danger-ghost" size="small" onclick={() => onIntent({ type: 'close' })} />
            {#if gathering}<Button label="Go" kind="primary" size="small" disabled={!model.canStart} onclick={() => onIntent({ type: 'go' })} />{/if}
          </span>
        {/if}
      </footer>
    {/if}
  {/if}

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
    padding: 0.625rem 0.75rem 0.75rem;
    border: 1px solid var(--caelestis-border);
    border-radius: var(--caelestis-radius);
    background: var(--caelestis-surface);
    color: var(--caelestis-text);
    box-shadow: var(--caelestis-popover-shadow);
    font: 400 0.8125rem/1.4 var(--caelestis-font);
  }
  p { margin: 0; }
  header { display: flex; align-items: center; gap: 0.5rem; min-block-size: 1.5rem; }
  h2 { flex: 1; margin: 0; font: 600 0.875rem/1.25 var(--caelestis-font); }
  .count, .place, .ready, .plan-stats, .turn, .big { font-variant-numeric: tabular-nums; }
  .count { color: var(--caelestis-muted-text); font-weight: 600; }

  .open { display: flex; flex-wrap: wrap; align-items: center; gap: 0.5rem; }
  .open :is(label, .label) { font-weight: 600; }
  .open .stepper output {
    display: grid;
    place-items: center;
    inline-size: 3rem;
    block-size: 2rem;
    font: 600 0.875rem/1 var(--caelestis-font);
    font-variant-numeric: tabular-nums;
  }
  .open .stepper output.wide { inline-size: 4.5rem; }
  .stepper { display: flex; flex: 1; align-items: center; gap: 0.125rem; }
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

  .members, .plans ul { display: flex; flex-direction: column; gap: 0.125rem; margin: 0; padding: 0; list-style: none; }
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
  .name, .closes { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .you { margin-inline-start: 0.25em; color: var(--caelestis-muted-text); }
  .closes { color: var(--caelestis-muted-text); font-size: 0.75rem; line-height: 1.2; }
  .ready { display: inline-flex; align-items: center; gap: 0.125rem; color: var(--caelestis-muted-text); }
  .ready.done { color: var(--caelestis-success); }
  .order { display: inline-flex; }
  .empty { color: var(--caelestis-muted-text); }

  .plans { display: flex; flex-direction: column; align-items: start; gap: 0.375rem; padding-block-start: 0.5rem; border-block-start: 1px solid var(--caelestis-border); }
  .plans ul { align-self: stretch; }
  .plans li { display: flex; align-items: center; gap: 0.5rem; padding: 0.25rem 0.375rem; border-radius: calc(var(--caelestis-radius) - 2px); }
  .plans li.published { background: var(--caelestis-raised-surface); }
  .plan { display: flex; flex: 1; flex-direction: column; min-inline-size: 0; }
  .plan-label { font-weight: 600; overflow-wrap: anywhere; }
  .plan-stats { color: var(--caelestis-muted-text); font-size: 0.75rem; }
  .state { display: inline-flex; align-items: center; gap: 0.125rem; color: var(--caelestis-success); font-weight: 600; font-size: 0.75rem; }


  .message { color: var(--caelestis-muted-text); overflow-wrap: anywhere; }

  .steps { display: flex; flex-direction: column; gap: 0.375rem; margin: 0; padding-inline-start: 1.25rem; }
  .steps li::marker { color: var(--caelestis-muted-text); font-variant-numeric: tabular-nums; }

  footer { display: flex; flex-wrap: wrap; align-items: center; gap: 0.375rem; }
  .end { display: flex; gap: 0.375rem; margin-inline-start: auto; }

  .hidden { position: absolute; inline-size: 1px; block-size: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
</style>
