/**
 * Everything the product calls itself, in one place, so a rename is one edit.
 *
 * When the design formulas land:
 *   1. Change the strings below.
 *   2. Replace assets/brand/icon.svg (square artwork, readable at 16 px).
 *   3. Run `pnpm brand:icons` to regenerate public/icon/*.png.
 *   4. Rebuild. The manifest, page titles, the settings page and every
 *      user-facing sentence that names the product read from here.
 *
 * Do NOT change GECKO_ID when renaming: Firefox identifies the add-on by it,
 * and a new id would ship as a different add-on that existing users never
 * get updated to. The same goes for the Chrome Web Store item once listed.
 */
export const BRAND = {
  /** Full name: store listing, manifest, page titles. Max 75 characters (Chrome). */
  name: 'Selection AI',
  /** Under the icon and in tight spots. Max 12 characters to avoid truncation. */
  shortName: 'Selection AI',
  /** Store and manifest description. Max 132 characters (Chrome). */
  description:
    'Select text, a box, an element or any shape and ask Claude or ChatGPT about exactly that. Math, chemistry and physics render properly.',
  /** Tooltip on the toolbar button. */
  actionTitle: 'Selection AI — select and ask',
  /**
   * How user-facing copy refers to the toolbar button. Students think of the
   * product as a shortcut, so the button is "the shortcut icon".
   */
  iconName: 'the shortcut icon',
} as const;

/** Firefox add-on id. Stable forever; see above. */
export const GECKO_ID = 'selection-ai@amcpmn.org';
