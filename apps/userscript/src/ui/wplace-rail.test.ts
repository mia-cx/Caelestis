// @vitest-environment happy-dom
import { expect, it } from 'vitest'
import { findWplaceRail } from './wplace-rail.js'

const wplaceRail = (): HTMLElement => {
  const rail = document.createElement('div')
  for (const label of ['Leaderboard', 'Search']) {
    const button = document.createElement('button')
    button.setAttribute('aria-label', label)
    rail.append(button)
  }
  return rail
}

it("follows Wplace's rail through re-renders and the paint drawer", async () => {
  const wrapper = document.body.appendChild(document.createElement('div'))
  const first = wrapper.appendChild(wplaceRail())
  expect(findWplaceRail()).toBe(first)

  // A re-render inside the wrapper Wplace keeps: the old rail stays connected, but empty.
  const second = wrapper.appendChild(document.createElement('div'))
  second.append(...first.children)
  expect(findWplaceRail()).toBe(second)

  // Painting removes the rail; closing the drawer brings a new one back.
  wrapper.remove()
  expect(findWplaceRail()).toBeNull()
  const third = document.body.appendChild(wplaceRail())
  await new Promise((resolve) => setTimeout(resolve))
  expect(findWplaceRail()).toBe(third)
})
