import { useLayoutEffect, useMemo, useRef } from 'react';
import { splitWhatIRead } from '@shared/prompts';
import { renderMarkdownFragment } from '@/lib/render';
import { WhatIRead } from './WhatIRead';

export function Answer({ text, streaming }: { text: string; streaming: boolean }) {
  const { read, body } = useMemo(() => splitWhatIRead(text), [text]);
  const ref = useRef<HTMLDivElement>(null);
  // Sanitized nodes, appended; no HTML string is ever assigned to the page.
  useLayoutEffect(() => {
    ref.current?.replaceChildren(renderMarkdownFragment(body));
  }, [body]);
  return (
    <div className={`answer${streaming ? ' streaming' : ''}`}>
      {read !== null && <WhatIRead text={read} />}
      <div className="markdown" ref={ref} />
    </div>
  );
}
