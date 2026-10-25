/**
 * An answer, rendered from its Markdown (lib/render.ts), its graphs,
 * diagrams, forms and slides drawn (lib/blocks). While it streams,
 * its text comes out at an even pace rather than in the bursts the network
 * brings: never far behind (it catches up within about a third of a
 * second), and done as soon as the answer is. An answer already there (one
 * opened from the menu) shows at once.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { splitWhatIRead } from '@shared/prompts';
import { enhanceBlocks } from '@/lib/blocks';
import { renderMarkdownFragment } from '@/lib/render';
import { WhatIRead } from './WhatIRead';

/** Each frame lets out this share of what has arrived but is not shown yet. */
const CATCH_UP_FRAMES = 20;
/** Re-rendering the Markdown this often is smooth enough, and cheap enough for a long answer. */
const RENDER_EVERY_MS = 32;

export function Answer({ text, streaming, onPaced }: { text: string; streaming: boolean; onPaced?: () => void }) {
  const paced = usePaced(text, streaming);
  const { read, body } = useMemo(() => splitWhatIRead(paced), [paced]);
  const ref = useRef<HTMLDivElement>(null);
  const after = useRef(onPaced);
  after.current = onPaced;
  const done = !streaming && paced.length >= text.length;
  // Sanitized nodes, appended; no HTML string is ever assigned to the page.
  useLayoutEffect(() => {
    const nodes = renderMarkdownFragment(body);
    enhanceBlocks(nodes, done);
    ref.current?.replaceChildren(nodes);
    after.current?.();
  }, [body, done]);
  return (
    <div className={`answer${done ? '' : ' streaming'}`}>
      {read !== null && <WhatIRead text={read} />}
      <div className="markdown" ref={ref} />
    </div>
  );
}

/** How much of `text` to show: all of it, or (while it streams in) a little more each frame. */
function usePaced(text: string, streaming: boolean): string {
  const [length, setLength] = useState(() => (streaming ? 0 : text.length));
  const shown = useRef(length);
  const target = useRef(text);
  target.current = text;

  useEffect(() => {
    // Replaced by a shorter text (asked again): start from there.
    if (shown.current > text.length) setLength((shown.current = text.length));
    if (shown.current >= text.length) return;
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setLength((shown.current = text.length));
      return;
    }
    let frame = 0;
    let rendered = 0;
    const tick = (now: number) => {
      const goal = target.current.length;
      const behind = goal - shown.current;
      if (behind <= 0) return;
      let next = Math.min(goal, shown.current + Math.max(2, Math.ceil(behind / CATCH_UP_FRAMES)));
      // Never between the two halves of an emoji or other astral character.
      const code = target.current.charCodeAt(next - 1);
      if (code >= 0xd800 && code <= 0xdbff && next < goal) next++;
      shown.current = next;
      if (next >= goal || now - rendered >= RENDER_EVERY_MS) {
        rendered = now;
        setLength(next);
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [text]);

  return text.slice(0, length);
}
