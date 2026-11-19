/**
 * What the template tree is in the middle of, kept across rebuilds: the row being renamed and
 * whether a row is being dragged. A rebuild must not take either away from the hand using it.
 */

let renaming: string | null = null
let dragging = false

export const startRenaming = (key: string): void => {
  renaming = key
}

export const currentRenamingKey = (): string | null => renaming

export const finishRenaming = (): void => {
  renaming = null
}

export const isTreeDragActive = (): boolean => dragging

export const setTreeDragActive = (active: boolean): void => {
  dragging = active
}
