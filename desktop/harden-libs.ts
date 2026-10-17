/**
 * Build-time edits to two libraries, taking out the only code in the bundle
 * that writes HTML strings into a live page. Each path is dead in the app, so
 * removing it changes nothing a student can see; if either were ever
 * reached, it now fails loudly instead.
 *
 * React (the panel and settings):
 *  - `dangerouslySetInnerHTML`. Nothing here uses it (answers are sanitized
 *    by DOMPurify and inserted as nodes, lib/render.ts), so React's two
 *    `innerHTML` writes for it now throw.
 *
 * DOMPurify (the answer sanitizer):
 *  - its parser fallback, which writes the raw input into a detached
 *    document when DOMParser fails or a non-HTML namespace is configured.
 *    Neither happens here (the namespace is HTML). It now parses nothing, so
 *    it fails safe: an empty answer.
 *
 * Every edit must match, or the build fails: an upgrade that moves the code
 * is caught here, not shipped half-patched.
 */
/** The part of a Vite plugin used here. */
interface Plugin {
  name: string;
  enforce: 'pre';
  transform(code: string, id: string): { code: string; map: null } | null;
}

interface Edit {
  file: RegExp;
  find: RegExp;
  replace: string;
  /** How many times it must match (1 unless said). */
  count?: number;
}

const EDITS: Edit[] = [
  {
    file: /dompurify\/dist\/purify\.es\.mjs$/,
    find: /doc\.documentElement\.innerHTML = IS_EMPTY_INPUT \? emptyHTML : dirtyPayload;/,
    replace: 'void 0;',
  },
  {
    file: /react-dom\/cjs\/react-dom-client\.production\.js$/,
    find: /\(domElement\.innerHTML = key\);/g,
    replace: '(() => { throw Error("dangerouslySetInnerHTML is not used in this app"); })();',
    count: 2,
  },
];

export function hardenLibraries(): Plugin {
  return {
    name: 'harden-libs',
    enforce: 'pre',
    transform(code, id) {
      const path = id.split('?')[0]!.replace(/\\/g, '/');
      const edits = EDITS.filter((e) => e.file.test(path));
      if (!edits.length) return null;
      let out = code;
      for (const e of edits) {
        const found = out.match(new RegExp(e.find.source, 'g'))?.length ?? 0;
        if (found !== (e.count ?? 1)) throw new Error(`harden-libs: expected ${e.count ?? 1} of ${e.find} in ${path}, found ${found}`);
        out = out.replace(e.find, e.replace);
      }
      return { code: out, map: null };
    },
  };
}
