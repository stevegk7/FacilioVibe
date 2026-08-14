import type { SVGProps } from 'react';

/**
 * Facilio DSM icon set.
 *
 * House rules, taken from the Atom kit's own iconography:
 *  - 24px canvas, 1.5 stroke, round caps/joins, no fill
 *  - currentColor only — colour comes from the button/chip that hosts it
 *  - geometric and flat: no emoji, no gradients, no decorative detail
 *
 * Emoji were used as placeholders early on; they render differently on every
 * platform, cannot inherit colour, and read as clip-art next to DSM chrome.
 * Everything user-facing uses these instead.
 */
export type IconName =
  | 'compass'
  | 'pin'
  | 'wrench'
  | 'note'
  | 'camera'
  | 'mic'
  | 'sparkle'
  | 'cube'
  | 'qr'
  | 'chevron-down'
  | 'chevron-left'
  | 'close'
  | 'plus'
  | 'check'
  | 'search'
  | 'trash'
  | 'print'
  | 'list'
  | 'location'
  | 'grid'
  | 'route'
  | 'settings'
  | 'home'
  | 'alert'
  | 'external'
  | 'chevron-right';

const PATHS: Record<IconName, JSX.Element> = {
  compass: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M15.5 8.5l-2 5-5 2 2-5z" />
    </>
  ),
  pin: (
    <>
      <path d="M12 21s7-6.2 7-11a7 7 0 1 0-14 0c0 4.8 7 11 7 11z" />
      <circle cx="12" cy="10" r="2.5" />
    </>
  ),
  wrench: <path d="M14.7 6.3a4 4 0 0 0 5 5l-9 9a2.8 2.8 0 0 1-4-4l9-9z" />,
  note: (
    <>
      <path d="M5 4h9l5 5v11H5z" />
      <path d="M14 4v5h5M8.5 13h7M8.5 16.5h4.5" />
    </>
  ),
  camera: (
    <>
      <path d="M4 7h3l1.5-2h7L17 7h3v12H4z" />
      <circle cx="12" cy="13" r="3.5" />
    </>
  ),
  mic: (
    <>
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
    </>
  ),
  sparkle: (
    <>
      <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z" />
      <path d="M18.5 15.5l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7z" />
    </>
  ),
  cube: (
    <>
      <path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z" />
      <path d="M12 12l8-4.5M12 12v9M12 12L4 7.5" />
    </>
  ),
  qr: (
    <>
      <rect x="4" y="4" width="6" height="6" />
      <rect x="14" y="4" width="6" height="6" />
      <rect x="4" y="14" width="6" height="6" />
      <path d="M14 14h3v3h-3zM20 14v3M17 20h3M14 20h0" />
    </>
  ),
  'chevron-down': <path d="M6 9l6 6 6-6" />,
  'chevron-left': <path d="M15 6l-6 6 6 6" />,
  close: <path d="M6 6l12 12M18 6L6 18" />,
  plus: <path d="M12 5v14M5 12h14" />,
  check: <path d="M4 12.5l5 5L20 6.5" />,
  external: (
    <>
      <path d="M14 4h6v6" />
      <path d="M20 4l-9 9" />
      <path d="M20 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h5" />
    </>
  ),
  'chevron-right': <path d="M9 5l7 7-7 7" />,
  search: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="M16.5 16.5L21 21" />
    </>
  ),
  trash: (
    <>
      <path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" />
      <path d="M10 11v6M14 11v6" />
    </>
  ),
  print: (
    <>
      <path d="M7 9V4h10v5M7 18H5v-7h14v7h-2" />
      <path d="M7 14h10v6H7z" />
    </>
  ),
  list: <path d="M4 7h16M4 12h16M4 17h10" />,
  location: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2v3M12 19v3M2 12h3M19 12h3" />
      <circle cx="12" cy="12" r="8" />
    </>
  ),
  grid: (
    <>
      <rect x="4" y="4" width="7" height="7" />
      <rect x="13" y="4" width="7" height="7" />
      <rect x="4" y="13" width="7" height="7" />
      <rect x="13" y="13" width="7" height="7" />
    </>
  ),
  route: (
    <>
      <circle cx="6" cy="18" r="2.5" />
      <circle cx="18" cy="6" r="2.5" />
      <path d="M8.5 18h5a4 4 0 0 0 0-8h-3a4 4 0 0 1 0-8" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 3v2.5M12 18.5V21M4.2 7.5l2.2 1.2M17.6 15.3l2.2 1.2M4.2 16.5l2.2-1.2M17.6 8.7l2.2-1.2" />
    </>
  ),
  home: (
    <>
      <path d="M4 20V9.5L12 4l8 5.5V20z" />
      <path d="M10 20v-6h4v6" />
    </>
  ),
  alert: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7.5v5M12 16h0" />
    </>
  ),
};

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'name'> {
  name: IconName;
  /** Rendered box in px. DSM default is 20 inside buttons, 24 in nav. */
  size?: number;
}

export default function Icon({ name, size = 20, ...rest }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {PATHS[name]}
    </svg>
  );
}
