import type { IncomingMessage } from 'node:http'
import type { ObjectStorage } from '@caelestis/storage'
import type { R2Binding } from '@caelestis/storage/r2'

declare module 'node:http' {
  interface IncomingMessage {
    caelestis?: { env: App.HostEnv; objectStorage: ObjectStorage }
  }
}

// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
declare global {
  namespace App {
    // interface Error {}
    /** Set for every request by `hooks.server.ts`. */
    interface Locals {
      objectStorage?: ObjectStorage
      backendEnvironment: HostEnv
    }
    // interface PageData {}
    // interface PageState {}
    interface Platform {
      /** The custom Node server attaches its config to the request before SvelteKit handles it. */
      req: IncomingMessage
    }
    /** Config from Worker bindings on Cloudflare, or from the custom server on Node. */
    interface HostEnv {
      CAELESTIS_BACKEND?: { fetch(request: Request): Promise<Response> }
      CAELESTIS_READ_TOKEN?: string
      CAELESTIS_SERVER?: string
      SOCIAL_IMAGES?: R2Binding
    }
  }
}
