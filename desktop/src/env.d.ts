/** What the build and the pages' globals provide (vite.config.ts, platform/install.ts). */
interface ImportMetaEnv {
  /** Accounts: the Supabase project, and its publishable key. */
  readonly WXT_SUPABASE_URL?: string;
  readonly WXT_SUPABASE_KEY?: string;
  /** Hosted answers: the Worker's address. */
  readonly WXT_GATEWAY_URL?: string;
  /** The end-to-end tests' build. */
  readonly SAI_E2E?: string;
}

/** The app's WebExtension-shaped `browser` (platform/browser.ts), put on every page by platform/install.ts. */
declare const browser: ReturnType<typeof import('./platform/browser').createBrowser>;
