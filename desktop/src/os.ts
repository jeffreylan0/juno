/** Which system the app runs on, from the webview (no await needed). */
const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent;
export const MAC = /Mac/.test(ua);
export const WINDOWS = /Windows/.test(ua);
