import type { Plan } from '@shared/payload';

/** Shows the crop that will be sent, so the student sees exactly what the model sees. */
export function Preview({ plan }: { plan: Plan | null }) {
  const image = plan?.parts.find((p) => p.kind === 'image');
  if (!image || image.kind !== 'image') return null;
  return (
    <div className="preview">
      <img src={image.dataUrl} alt="Selected region" width={image.width} height={image.height} />
    </div>
  );
}
