<script lang="ts">
  import SectionHeader from '../foundations/SectionHeader.svelte'
  import SettingRow from '../foundations/SettingRow.svelte'
  import Toggle from '../foundations/Toggle.svelte'
  import { SIMULATED_INPUT_FLAGS, shortcutLabel } from '@caelestis/shared'
  import { SIMULATED_INPUT } from '../simulated-input.js'
  import type { GlobalSettingsIntent, GlobalSettingsModel, SettingsBooleanKey } from './model.js'

  /**
   * One section of the settings that apply to every Wplace tab. The panel's Settings view places
   * each between its own sections; the extension's popup shows them in a row.
   */
  let {
    section,
    model,
    onIntent,
  }: {
    section: 'notifications' | 'contribution' | 'painters' | 'wplace-performance' | 'diagnostics' | 'accessibility' | 'dangerous'
    model: GlobalSettingsModel
    onIntent?: ((intent: GlobalSettingsIntent) => void) | undefined
  } = $props()

  const set = (key: SettingsBooleanKey, value: boolean): void => onIntent?.({ type: 'set-boolean', key, value })
</script>

{#if section === 'notifications'}
  <SectionHeader title="Notifications" icon="bell" />
  <p class="subtle">Toast messages inside Wplace only.</p>
  <SettingRow label="Template regressions" hint="When a template loses progress.">{#snippet children()}<Toggle label="Template regressions" checked={model.notifyRegressions} onChange={(value) => set('notifyRegressions', value)} />{/snippet}</SettingRow>
  <SettingRow label="Sustained griefing" hint="When damage to a template continues.">{#snippet children()}<Toggle label="Sustained griefing" checked={model.notifyGriefing} onChange={(value) => set('notifyGriefing', value)} />{/snippet}</SettingRow>
  {#if model.notifyUpdates !== undefined}
    <SettingRow label="Userscript updates" hint="When a new Caelestis version is available.">{#snippet children()}<Toggle label="Userscript updates" checked={model.notifyUpdates ?? true} onChange={(value) => set('notifyUpdates', value)} />{/snippet}</SettingRow>
  {/if}
  <SettingRow label="Action feedback" hint="Progress and success messages. Errors and action warnings always appear.">{#snippet children()}<Toggle label="Action feedback" checked={model.notifyActivity} onChange={(value) => set('notifyActivity', value)} />{/snippet}</SettingRow>
{:else if section === 'contribution'}
  <SectionHeader title="Contribution" icon="share" />
  <SettingRow label="Report my activity" hint="Shares paint activity only in areas covered by server templates, and only with the servers providing those templates.">{#snippet children()}<Toggle label="Report my activity" checked={model.reportPaints} onChange={(value) => set('reportPaints', value)} />{/snippet}</SettingRow>
  <SettingRow label="Share tiles" hint="Shares fetched tiles only in areas covered by server templates, and only with the servers providing those templates.">{#snippet children()}<Toggle label="Share tiles" checked={model.shareTiles} onChange={(value) => set('shareTiles', value)} />{/snippet}</SettingRow>
{:else if section === 'painters'}
  <SectionHeader title="Painters" icon="share" />
  <SettingRow label="Share where I am" hint="Other painters on the same server see the area you are looking at and the pixels you have drafted, while this tab is open. Nothing is stored.">{#snippet children()}<Toggle label="Share where I am" checked={model.sharePresence} onChange={(value) => set('sharePresence', value)} />{/snippet}</SettingRow>
  <SettingRow label="Show other painters" hint="The painters button on the rail and Q switch this too.">{#snippet children()}<Toggle label="Show other painters" checked={model.showPresence} onChange={(value) => set('showPresence', value)} />{/snippet}</SettingRow>
  <SettingRow label="Show painters' viewports" hint="Where they are looking and what they have drafted.">{#snippet children()}<Toggle label="Show painters' viewports" checked={model.showPresenceViewports} disabled={!model.showPresence} onChange={(value) => set('showPresenceViewports', value)} />{/snippet}</SettingRow>
  <SettingRow label="Show region claims" hint="Yours and theirs. Your own claim's fill steps aside while the pointer is inside it.">{#snippet children()}<Toggle label="Show region claims" checked={model.showPresenceClaims} disabled={!model.showPresence} onChange={(value) => set('showPresenceClaims', value)} />{/snippet}</SettingRow>
  <SettingRow label="Claims only while painting" hint="Hide claims until Wplace's paint drawer is open.">{#snippet children()}<Toggle label="Claims only while painting" checked={model.showPresenceClaimsOnlyWhilePainting} disabled={!model.showPresence || !model.showPresenceClaims} onChange={(value) => set('showPresenceClaimsOnlyWhilePainting', value)} />{/snippet}</SettingRow>
{:else if section === 'wplace-performance'}
  {#if (model.wplacePatches ?? []).length > 0}
    <SectionHeader title="Wplace performance" icon="tune" />
    <p class="subtle">Caelestis fixes waste in Wplace's own client. Turn a fix off if Wplace looks or behaves wrong.</p>
    {#each model.wplacePatches ?? [] as patch (patch.id)}
      <SettingRow label={patch.label} hint={patch.hint}>{#snippet children()}<Toggle label={patch.label} checked={patch.enabled} onChange={(value) => onIntent?.({ type: 'set-wplace-patch', id: patch.id, enabled: value })} />{/snippet}</SettingRow>
    {/each}
  {/if}
{:else if section === 'diagnostics'}
  <SectionHeader title="Diagnostics" icon="bug" />
  <SettingRow label="Debug logging" hint="Verbose console output for bug reports">{#snippet children()}<Toggle label="Debug logging" checked={model.debugLogging} onChange={(value) => set('debugLogging', value)} />{/snippet}</SettingRow>
  <SettingRow label="Performance profiling" hint="Measures Caelestis CPU, GPU and known buffers. Profiling adds a small overhead.">{#snippet children()}<Toggle label="Performance profiling" checked={model.performanceProfiling} onChange={(value) => set('performanceProfiling', value)} />{/snippet}</SettingRow>
{:else if section === 'accessibility' && model.accessibility !== undefined}
  {@const accessibility = model.accessibility}
  <SectionHeader title="Accessibility" icon="eye" />
  <SettingRow label="FalseType font">{#snippet children()}<Toggle label="FalseType font" checked={accessibility.falseType} onChange={(value) => onIntent?.({ type: 'set-accessibility', key: 'falseType', value })} />{/snippet}</SettingRow>
  <SettingRow label="Caelestis cursors">{#snippet children()}<Toggle label="Caelestis cursors" checked={accessibility.cursors} onChange={(value) => onIntent?.({ type: 'set-accessibility', key: 'cursors', value })} />{/snippet}</SettingRow>
{:else if section === 'dangerous'}
  <SectionHeader title="Dangerous settings" icon="flag" />
  <p class="subtle">These quality-of-life patches don't technically break Wplace's rules, but they use functionality that trips flags in Pawtect, Wplace's anticheat, which are sent with every paint. These flags don't get you banned automatically, especially on a high-trust account with no other evidence of rule-breaking, but Caelestis can't guarantee they won't, so these settings are off by default. With them off, Caelestis trips no Pawtect flags.</p>
  <p class="subtle">Alliance canvases (HQ, avatar and banner) don't check for simulated input, so these features always work there.</p>
  {#each SIMULATED_INPUT as feature (feature.id)}
    <SettingRow label={feature.label}>{#snippet hint()}{#each feature.hint as part}{#if typeof part === 'string'}{part}{:else if 'fixed' in part}<kbd class="hint-key">{part.fixed}</kbd>{:else}<kbd class="hint-key">{shortcutLabel(model.shortcuts.bindings[part.key], model.shortcuts.platform) || 'not set'}</kbd>{/if}{/each}{/snippet}{#snippet details()}<small class="flags">Trips: {#each SIMULATED_INPUT_FLAGS[feature.id] as flag}<code>{flag}</code>{/each}</small>{/snippet}{#snippet children()}<Toggle label={feature.label} checked={model.simulatedInput[feature.id] === true} disabled={feature.extends !== undefined && model.simulatedInput[feature.extends] !== true} onChange={(value) => onIntent?.({ type: 'set-simulated-input', id: feature.id, value })} />{/snippet}</SettingRow>
  {/each}
{/if}

<style>
  .subtle { margin: 0.3rem var(--caelestis-content-inset, 1rem); color: var(--caelestis-muted-text); font-size: 0.72rem; }
  .flags { display: flex; flex-wrap: wrap; align-items: baseline; gap: 0.15rem 0.25rem; margin-block-start: 0.25rem; color: var(--caelestis-muted-text); font-size: 0.72rem; }
  .hint-key, .flags code { padding: 0.05rem 0.3rem; border: 1px solid var(--caelestis-border); border-radius: 0.3rem; background: var(--caelestis-raised-surface); color: var(--caelestis-text); font: 0.7rem/1.3 var(--caelestis-mono-font, ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace); }
</style>
