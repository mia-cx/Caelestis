<script lang="ts">
import {
  readServerUrl,
  readToken,
  serverUrlIsConfigured,
  writeConnection,
} from '#lib/api/client.js'
import { Icon } from '@caelestis/ui'
import { Dialog } from 'bits-ui'
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
  <Dialog.Portal>
    <Dialog.Overlay class="fixed inset-0 isolate z-50 bg-black/10 supports-backdrop-filter:backdrop-blur-xs" />
    <Dialog.Content
      class="fixed top-1/2 left-1/2 z-50 grid w-full max-w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 gap-4 rounded-xl bg-base-100 p-4 text-sm ring-1 ring-base-content/10 outline-none sm:max-w-md"
    >
      <div class="flex flex-col gap-2">
        <Dialog.Title class="text-base leading-none font-medium">
          {serverUrlIsConfigured ? 'Access token' : 'Connect to a template server'}
        </Dialog.Title>
        <Dialog.Description class="text-sm text-base-content/64">
          {serverUrlIsConfigured
            ? 'Enter the access token you use in the userscript.'
            : 'Enter a server URL and, if required, its access token.'}
        </Dialog.Description>
      </div>
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
        <div class="-mx-4 -mb-4 flex flex-col-reverse gap-2 rounded-b-xl border-t border-base-300 bg-base-200/50 p-4 sm:flex-row sm:justify-end">
          <button type="submit" class="btn btn-primary btn-sm">Connect</button>
        </div>
      </form>
      <Dialog.Close class="btn btn-ghost btn-sm btn-square absolute top-2 right-2">
        <Icon name="close" />
        <span class="sr-only">Close</span>
      </Dialog.Close>
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>
