/**
 * Everything the product calls itself, in one place, so a rename is one edit.
 *
 * The outward contact is info@humanbn.com (Stripe, the Google sign-in
 * screen, the privacy policy). The management address that owns the service
 * accounts is never written into this public repository.
 */
import { MAC } from './os';

export const BRAND = {
  /** Window titles, settings and every sentence that names the product. */
  name: 'Juno',
  /** How copy refers to the icon that starts a selection. */
  iconName: MAC ? 'the menu bar icon' : 'the tray icon',
  /** The maker's site. */
  homepage: 'https://humanbn.com',
  /** Published from legal/ in the repository. */
  privacy: 'https://humanbn.com/privacy',
  terms: 'https://humanbn.com/terms',
} as const;
