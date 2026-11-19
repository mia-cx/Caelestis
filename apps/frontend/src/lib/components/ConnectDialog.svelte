<script lang="ts">
import {
  readServerUrl,
  readToken,
  serverUrlIsConfigured,
  writeConnection,
} from '#lib/api/client.js'
import { Button } from '#lib/components/ui/button/index.js'
import * as Dialog from '#lib/components/ui/dialog/index.js'
import { useApp } from '#lib/state/app.svelte.js'

const app = useApp()

let { open = $bindable(false) }: { open?: boolean } = $props()

let serverUrl = $state('')
let token = $state('')
let refused = $state<string | null>(null)

$effect(() => {
  if (open) {
    serverUrl = readServerUrl()
    token = readToken() ?? ''
  }
})

const connect = async (event: SubmitEvent): Promise<void> => {
  event.preventDefault()
  try {
    writeConnection(serverUrl, token.length > 0 ? token : null)
  } catch (error) {
    if (!(error instanceof TypeError)) throw error
    refused = `This server URL can't be used: ${error.message}.`
    return
  }
  refused = null
  open = false
  await app.load()
}
</script>

<Dialog.Root bind:open>
  <Dialog.Content class="sm:max-w-md">
    <Dialog.Header>
      <Dialog.Title>
        {serverUrlIsConfigured ? 'Access token' : 'Connect to a template server'}
      </Dialog.Title>
      <Dialog.Description>
        {serverUrlIsConfigured
          ? 'Enter the access token you use in the userscript.'
          : 'Enter a server URL and, if required, its access token.'}
      </Dialog.Description>
    </Dialog.Header>
    <form class="flex flex-col gap-3" onsubmit={connect}>
      {#if !serverUrlIsConfigured}
        <label class="flex flex-col gap-1">
          <span class="text-sm font-medium">Server URL</span>
          <input
            class="input input-bordered w-full text-base sm:text-sm"
            type="url"
            required
            placeholder="https://templates.example.org"
            bind:value={serverUrl}
          />
        </label>
      {/if}
      <label class="flex flex-col gap-1">
        <span class="text-sm font-medium">Access token</span>
        <input
          class="input input-bordered w-full text-base sm:text-sm"
          type="password"
          autocomplete="off"
          placeholder="Leave empty for open servers"
          bind:value={token}
        />
      </label>
      {#if refused !== null}
        <p class="text-sm text-error">{refused}</p>
      {/if}
      {#if app.authRequired}
        <p class="text-sm text-error">This server requires a token with read access.</p>
      {/if}
      <Dialog.Footer>
        <Button type="submit">Connect</Button>
      </Dialog.Footer>
    </form>
  </Dialog.Content>
</Dialog.Root>
