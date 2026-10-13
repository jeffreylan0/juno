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
 * Do NOT change GECKO_ID once the add-on is listed: Firefox identifies the
 * add-on by it, and a new id would ship as a different add-on that existing
 * users never get updated to. (It last changed with the rename to Juno,
 * before any listing.) The same goes for the Chrome Web Store item.
 *
 * The outward contact is info@humanbn.com (the store listings, Stripe, the
 * Google sign-in screen, the privacy policy). The management address that
 * owns the service accounts is never written into this public repository.
 */
export const BRAND = {
  /** Full name: store listing, manifest, page titles. Max 75 characters (Chrome). */
  name: 'Juno',
  /** Under the icon and in tight spots. Max 12 characters to avoid truncation. */
  shortName: 'Juno',
  /** Store and manifest description. Max 132 characters (Chrome). */
  description:
    'Draw a box or any shape around a problem and ask Claude or ChatGPT about exactly that. Math, chemistry and physics render properly.',
  /** Tooltip on the toolbar button. */
  actionTitle: 'Juno — select and ask',
  /** How user-facing copy refers to the toolbar button. */
  iconName: 'the extension icon',
  /** The maker's site: the manifest's homepage, which the stores link to. */
  homepage: 'https://humanbn.com',
} as const;

/** Firefox add-on id. Stable forever once listed; see above. */
export const GECKO_ID = 'juno@humanbn.com';

/**
 * The public half of the key that fixes the Chrome extension id at
 * bipacelfiohnnmfkhfhkjblblkediabm wherever the unpacked build is loaded.
 * Google sign-in needs a fixed id: Supabase only sends the browser back to
 * redirect URLs on its allow-list, here https://<id>.chromiumapp.org/.
 * Builds with accounts carry it; Chrome Web Store builds (STORE=1) do not,
 * since the store assigns its own id (add that one's URL to the list too).
 * The private half is kept outside the repo; it is only needed to pack a .crx.
 */
export const CHROME_KEY =
  'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEApWfRs+l/eksKctoKLmuVjPTke6CBGDtlnXlXEO7G4vrQr37wLeIOA56wtTNXNnihOT76dOKcZFLaE2Z1s1Tkzl0H5IBmcod4DqSOJ0ISpETqFU6EQbem9NJd7Bf0X3+iqbzh5uDKPKOMlYp3ht9oSxyIUGXmI9ggkJy5vLnR3TdBIA4CEOTobuoopFfvz39PHnhDGhIiSd/LTkrqjwgLK8v3bVKorjv9Pkp55Fzymg4etRiqb7K/d3mWcLE6M/+2gvZeDarolBLf0pxJgHdBEESKkzvwi6sGOgfdPkL8uR9gfVk/H9RnQoEZDOjdd+WhPTw2zeeantvmPK1xazfpMQIDAQAB';
