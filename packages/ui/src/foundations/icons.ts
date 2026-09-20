// Pixelarticons (MIT): 24 unit grid drawn in 2 unit strokes, so an icon is whole pixels at 12px and
// 24px and nothing else. Every name here is a role the UI asks for, not a picture.
import alert from '@iconify-icons/pixelarticons/alert'
import arrowLeft from '@iconify-icons/pixelarticons/arrow-left'
import arrowRight from '@iconify-icons/pixelarticons/arrow-right'
import blocks from '@iconify-icons/pixelarticons/blocks'
import brush from '@iconify-icons/pixelarticons/brush'
import bug from '@iconify-icons/pixelarticons/bug'
import check from '@iconify-icons/pixelarticons/check'
import checkboxOn from '@iconify-icons/pixelarticons/checkbox-on'
import chevronDown from '@iconify-icons/pixelarticons/chevron-down'
import chevronRight from '@iconify-icons/pixelarticons/chevron-right'
import chevronUp from '@iconify-icons/pixelarticons/chevron-up'
import chevronsVertical from '@iconify-icons/pixelarticons/chevrons-vertical'
import circle from '@iconify-icons/pixelarticons/circle'
import close from '@iconify-icons/pixelarticons/close'
import closeBox from '@iconify-icons/pixelarticons/close-box'
import colorsSwatch from '@iconify-icons/pixelarticons/colors-swatch'
import discord from '@iconify-icons/pixelarticons/discord'
import download from '@iconify-icons/pixelarticons/download'
import edit from '@iconify-icons/pixelarticons/edit'
import eraser from '@iconify-icons/pixelarticons/eraser'
import expand from '@iconify-icons/pixelarticons/expand'
import externalLink from '@iconify-icons/pixelarticons/external-link'
import eye from '@iconify-icons/pixelarticons/eye'
import eyeClosed from '@iconify-icons/pixelarticons/eye-closed'
import feather from '@iconify-icons/pixelarticons/feather'
import filter from '@iconify-icons/pixelarticons/filter'
import flag from '@iconify-icons/pixelarticons/flag'
import folder from '@iconify-icons/pixelarticons/folder'
import folderPlus from '@iconify-icons/pixelarticons/folder-plus'
import gear from '@iconify-icons/pixelarticons/gear'
import gitBranch from '@iconify-icons/pixelarticons/git-branch'
import github from '@iconify-icons/pixelarticons/github'
import gps from '@iconify-icons/pixelarticons/gps'
import grid from '@iconify-icons/pixelarticons/grid'
import hand from '@iconify-icons/pixelarticons/hand'
import image from '@iconify-icons/pixelarticons/image'
import infoBox from '@iconify-icons/pixelarticons/info-box'
import keyboard from '@iconify-icons/pixelarticons/keyboard'
import label from '@iconify-icons/pixelarticons/label'
import lasso from '@iconify-icons/pixelarticons/lasso'
import layoutSidebarRight from '@iconify-icons/pixelarticons/layout-sidebar-right'
import minus from '@iconify-icons/pixelarticons/minus'
import moon from '@iconify-icons/pixelarticons/moon'
import moreVertical from '@iconify-icons/pixelarticons/more-vertical'
import move from '@iconify-icons/pixelarticons/move'
import notification from '@iconify-icons/pixelarticons/notification'
import pause from '@iconify-icons/pixelarticons/pause'
import pencil from '@iconify-icons/pixelarticons/pencil'
import play from '@iconify-icons/pixelarticons/play'
import plus from '@iconify-icons/pixelarticons/plus'
import pointer from '@iconify-icons/pixelarticons/pointer'
import reload from '@iconify-icons/pixelarticons/reload'
import search from '@iconify-icons/pixelarticons/search'
import server from '@iconify-icons/pixelarticons/server'
import shapes from '@iconify-icons/pixelarticons/shapes'
import share from '@iconify-icons/pixelarticons/share'
import sharpCorner from '@iconify-icons/pixelarticons/sharp-corner'
import sliders from '@iconify-icons/pixelarticons/sliders'
import snowflake from '@iconify-icons/pixelarticons/snowflake'
import sortAlphabetic from '@iconify-icons/pixelarticons/sort-alphabetic'
import square from '@iconify-icons/pixelarticons/square'
import squareCursor from '@iconify-icons/pixelarticons/square-cursor'
import star from '@iconify-icons/pixelarticons/star'
import sun from '@iconify-icons/pixelarticons/sun'
import tangent from '@iconify-icons/pixelarticons/tangent'
import trash from '@iconify-icons/pixelarticons/trash'
import upload from '@iconify-icons/pixelarticons/upload'
import users from '@iconify-icons/pixelarticons/users'

/** The subset of Iconify's icon record the renderer reads. */
export interface IconData {
  readonly body: string
  readonly width?: number | undefined
  readonly height?: number | undefined
}

/** Pin the exported type to the local `IconData` so the declaration stays portable across packages. */
const define = <const Icons extends Record<string, IconData>>(
  icons: Icons,
): { readonly [Name in keyof Icons]: IconData } => icons

export const ICONS = define({
  add: plus,
  arrowBack: arrowLeft,
  bug,
  bell: notification,
  caret: arrowRight,
  check,
  chevronRight,
  close,
  createFolder: folderPlus,
  darkMode: moon,
  discord,
  dock: layoutSidebarRight,
  download,
  error: closeBox,
  expandLess: chevronUp,
  expandMore: chevronDown,
  extension: blocks,
  eye,
  painters: users,
  eyeOff: eyeClosed,
  filter,
  flyTo: gps,
  fitScreen: expand,
  flag,
  folder,
  github,
  gridView: grid,
  image,
  info: infoBox,
  kebab: moreVertical,
  keyboard,
  lightMode: sun,
  move,
  shapes,
  toolSelect: pointer,
  toolDirect: squareCursor,
  toolLasso: lasso,
  toolHand: hand,
  toolPen: feather,
  toolAddAnchor: plus,
  toolDeleteAnchor: minus,
  toolAnchor: tangent,
  toolPencil: pencil,
  toolBrush: brush,
  toolEraser: eraser,
  toolRectangle: square,
  toolEllipse: circle,
  toolPolygon: sharpCorner,
  toolStar: star,
  palette: colorsSwatch,
  pause,
  play,
  popout: externalLink,
  remove: minus,
  rename: edit,
  reset: reload,
  search,
  server,
  settings: gear,
  share,
  snowflake,
  sort: sortAlphabetic,
  tag: label,
  taskAlt: checkboxOn,
  trash,
  treeView: gitBranch,
  tune: sliders,
  unfoldMore: chevronsVertical,
  uploadFile: upload,
  warning: alert,
})

export type IconName = keyof typeof ICONS
