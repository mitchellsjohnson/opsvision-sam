/**
 * Focus and highlight styles that stay visible on every surface (WCAG 2.4.7,
 * 1.4.11: at least 3:1 against adjacent colors). The global rule in index.css
 * draws an accent-deep ring, which suits the light surfaces; the dark header
 * needs its own ring color.
 */

/** A white ring for controls on the dark accent-deep header (about 9:1). */
export const focusOnDark =
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white'

/**
 * Menu items cannot show an outline (focus is a highlight that follows the
 * keyboard and pointer), so the highlight itself is high contrast: white text
 * on the accent color.
 */
export const menuItemHighlight =
  'outline-none data-[highlighted]:bg-accent data-[highlighted]:text-white'
