/** The panel's icons (lib/icons.ts), as a component. */
import { ICON_PATHS, type IconName } from '@/lib/icons';

export type { IconName } from '@/lib/icons';

export function Icon({ name, className }: { name: IconName; className?: string }) {
  return <svg className={className} viewBox="0 0 24 24" aria-hidden="true" dangerouslySetInnerHTML={{ __html: ICON_PATHS[name] }} />;
}
