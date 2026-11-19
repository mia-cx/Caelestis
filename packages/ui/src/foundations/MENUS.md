# Menus

Render MenuStyles in components that own a select or menu. Svelte installs its CSS once per
document or shadow root. Use `caelestis-select` on native selects, `caelestis-menu` on custom
menu containers, and `caelestis-menu-item` on their choices.

MenuStyles owns borders, corners, padding, typography, hover/focus states, and shadows. Component
styles own width. Menus and their options follow `--caelestis-radius` like every other surface.

A floating menu or popover is a `popover` element placed by `anchorPopover` from `popover.ts`,
which hangs it from its trigger (or a pointer), keeps it inside the viewport, and follows the
trigger while the popover is open. `caelestis-dropdown` gives it the shared position and the
scale-and-fade motion: a popover animates with `:popover-open`; a menu mounted and removed through
`openSurface`/`closeSurface` carries `data-surface` and animates with `data-state`.

`caelestis-field-look` draws the field frame (tinted border, surface, inset shadow) on a search
box and the square triggers beside it.

Use `caelestis-menu-separator` for the hairline between groups of related actions. Render one only
between two non-empty groups, never at either end of a menu. A submenu is another `caelestis-menu`
opened from a `menuitem` that carries `aria-haspopup="menu"` and a trailing chevron. It opens on
mouse hover, tap, Enter, Space, and ArrowRight; ArrowLeft and Escape close it and return focus to
its trigger. Checkable rows use `menuitemcheckbox` with a trailing check when set.

Keep native select, popover, and existing keyboard behavior. Selected marks and action icons
occupy the leading icon column; searchable multi-select lists may retain their trailing checks.

Filter choices, tag suggestions, and favourite actions use these same classes. Two-line tag rows
keep their name and owner layout. Forms keep their field layout inside the shared menu container.
