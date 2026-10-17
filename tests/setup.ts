/** Every test file starts with a fresh fake `browser`, as the app's pages start with theirs. */
import { fakeBrowser } from '@webext-core/fake-browser';
import { beforeEach } from 'vitest';

Object.assign(globalThis, { browser: fakeBrowser, chrome: fakeBrowser });
beforeEach(() => fakeBrowser.reset());
