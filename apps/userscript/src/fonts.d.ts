/** The build inlines each woff2 import as a `data:` URL. */
declare module '*.woff2' {
  const dataUrl: string
  export default dataUrl
}
