/**
 * Build-time edits to two libraries, taking out the only code in the bundle
 * that evaluates strings, imports a computed URL, or writes HTML strings into
 * a live page. Each path is dead in this extension, so removing it changes
 * nothing a student can see, and it leaves the shipped code free of what
 * browser stores' reviewers rightly flag. If any of it were ever reached, it
 * now fails loudly instead.
 *
 * React (the panel and settings page):
 *  - `dangerouslySetInnerHTML`. Nothing here uses it — answers are sanitized
 *    by DOMPurify and inserted as nodes (lib/render.ts) — so React's two
 *    `innerHTML` writes for it now throw.
 *
 * DOMPurify (the answer sanitizer):
 *  - its parser fallback, which writes the raw input into a detached
 *    document when DOMParser fails or a non-HTML namespace is configured.
 *    Neither happens here (DOMParser is in every browser; the namespace is
 *    HTML). It now parses nothing, so it fails safe: an empty answer.
 *
 * pdf.js (the PDF reader's renderer):
 *  - `Function('return this')()`: core-js's fallback for finding the global
 *    object in engines without `globalThis`. Every browser we support has it.
 *  - The "fake worker", which imports `workerSrc` on the main thread when no
 *    worker is given. The reader always hands pdf.js its own worker.
 *  - The cross-origin worker wrapper, which builds a script from a string.
 *    Our worker is same-origin (and given directly).
 *  - The image decoders' JavaScript fallback, imported only when WebAssembly
 *    is unavailable. The manifest allows WebAssembly ('wasm-unsafe-eval').
 *
 * Every edit must match, or the build fails: a pdf.js upgrade that moves the
 * code is caught here, not shipped half-patched.
 */
/** The part of a Vite plugin used here (Vite itself is WXT's dependency, not ours). */
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
    replace: '(() => { throw Error("dangerouslySetInnerHTML is not used in this extension"); })();',
    count: 2,
  },
  {
    file: /pdfjs-dist\/legacy\/build\/pdf(\.worker)?\.mjs$/,
    find: /\(function \(\) \{ return this; \}\)\(\) \|\| Function\('return this'\)\(\);/,
    replace: 'globalThis;',
  },
  {
    file: /pdfjs-dist\/legacy\/build\/pdf\.mjs$/,
    find: /const worker = await import\(\s*\/\*webpackIgnore: true\*\/\s*\/\*@vite-ignore\*\/\s*this\.workerSrc\);\s*return worker\.WorkerMessageHandler;/,
    replace: 'throw new Error("The PDF reader runs pdf.js in its own worker.");',
  },
  {
    file: /pdfjs-dist\/legacy\/build\/pdf\.mjs$/,
    find: /const wrapper = `await import\("\$\{url\}"\);`;\s*return URL\.createObjectURL\(new Blob\(\[wrapper\], \{\s*type: "text\/javascript"\s*\}\)\);/,
    replace: 'throw new Error("The PDF reader loads no cross-origin worker.");',
  },
  {
    file: /pdfjs-dist\/legacy\/build\/pdf\.worker\.mjs$/,
    find: /const mod = await import\(\s*\/\*webpackIgnore: true\*\/\s*\/\*@vite-ignore\*\/\s*`\$\{WasmImage\.#wasmUrl\}\$\{this\._noWasmFilename\}`\);\s*instance = mod\.default\(\);/,
    replace: 'throw new Error("No JavaScript fallback for the WebAssembly image decoders is shipped.");',
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
