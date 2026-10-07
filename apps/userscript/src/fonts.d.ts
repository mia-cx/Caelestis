/** The build inlines each woff2 import as a `data:` URL. */
declare module '*.woff2' {
  const dataUrl: string
  export default dataUrl
}

/** The build inlines each png import as a `data:` URL. */
declare module '*.png' {
  const dataUrl: string
  export default dataUrl
}
