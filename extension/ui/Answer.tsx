import { useMemo } from 'react';
import { splitWhatIRead } from '@shared/prompts';
import { renderMarkdown } from '@/lib/render';
import { WhatIRead } from './WhatIRead';

export function Answer({ text, streaming }: { text: string; streaming: boolean }) {
  const { read, body } = useMemo(() => splitWhatIRead(text), [text]);
  const html = useMemo(() => renderMarkdown(body), [body]);
  return (
    <div className={`answer${streaming ? ' streaming' : ''}`}>
      {read !== null && <WhatIRead text={read} />}
      <div className="markdown" dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  );
}
