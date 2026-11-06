<script lang="ts">
  import SectionHeader from '../foundations/SectionHeader.svelte'
  import SettingRow from '../foundations/SettingRow.svelte'
  import Toggle from '../foundations/Toggle.svelte'
  import type { GlobalSettingsIntent, GlobalSettingsModel, SettingsBooleanKey } from '../types.js'

  /**
   * One section of the settings that apply to every Wplace tab. The panel's Settings view places
   * each between its own sections; the extension's popup shows them in a row.
   */
  let {
    section,
    model,
    onIntent,
  }: {
    section: 'notifications' | 'contribution' | 'painters' | 'wplace-performance' | 'diagnostics' | 'accessibility'
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
{/if}

<style>
  .subtle { margin: 0.3rem var(--caelestis-content-inset, 1rem); color: var(--caelestis-muted-text); font-size: 0.72rem; }
</style>
