declare module 'cloudflare:workers' {
  /** The Worker bindings the frontend reads. Node builds alias this module to an empty stub. */
  export const env: App.HostEnv
}
