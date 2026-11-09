import { expect, it } from 'vitest'
import { addDocumentStyle } from '../src/document-style.js'

it('waits for <html> rather than styling the script the page copy starts from', async () => {
  const html = document.documentElement
  html.remove()
  // As at document start, when the manager's copy appends the page copy's script to the document.
  const script = document.createElement('script')
  document.append(script)

  addDocumentStyle('.marker { color: red }')
  script.remove()
  document.append(html)
  await new Promise((resolve) => setTimeout(resolve, 0))

  expect(script.querySelector('style')).toBeNull()
  expect([...html.children].some((child) => child.textContent === '.marker { color: red }')).toBe(
    true,
  )
})
