import type { CSSProperties } from "react";
const paths: Record<string, React.ReactNode> = {
  play: <path d="m8 5 11 7-11 7Z" />,
  pause: (
    <>
      <path d="M8 5v14M16 5v14" />
    </>
  ),
  next: (
    <>
      <path d="m5 5 10 7-10 7Z" />
      <path d="M19 5v14" />
    </>
  ),
  youtube: (
    <>
      <rect x="3" y="5" width="18" height="14" rx="5" />
      <path d="m10 9 5 3-5 3Z" />
    </>
  ),
  mirror: (
    <>
      <rect x="3" y="4" width="13" height="16" rx="3" />
      <rect x="12" y="9" width="9" height="11" rx="2" />
    </>
  ),
  cast: (
    <>
      <path d="M4 4h16v16h-5M4 20v-1M4 14a6 6 0 0 1 6 6M4 9a11 11 0 0 1 11 11" />
    </>
  ),
  search: (
    <>
      <circle cx="10" cy="10" r="6" />
      <path d="m15 15 5 5" />
    </>
  ),
  close: <path d="m6 6 12 12M6 18 18 6" />,
  plus: <path d="M12 5v14M5 12h14" />,
  full: <path d="M9 3H3v6m12-6h6v6M3 15v6h6m12-6v6h-6" />,
  sound: (
    <>
      <path d="m11 4-6 5H2v6h3l6 5ZM15 8a6 6 0 0 1 0 8M18 5a10 10 0 0 1 0 14" />
    </>
  ),
  mute: (
    <>
      <path d="m11 4-6 5H2v6h3l6 5ZM16 9l6 6m0-6-6 6" />
    </>
  ),
  gear: (
    <>
      <path d="m9 3-1 3-3 1-2 3 2 3v4l3 2 3-1 3 3 3-2 1-3 3-1v-4l-3-1-1-4-4-1Z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  check: <path d="m5 12 4 4L20 5" />,
  arrow: <path d="m7 10 5-5 5 5M12 5v14" />,
  heart: (
    <path d="M20 5a5 5 0 0 0-8 1 5 5 0 0 0-8-1c-5 5 3 12 8 15 5-3 13-10 8-15Z" />
  ),
  bolt: <path d="m13 2-9 12h7l-1 8 10-13h-7Z" />,
  screen: (
    <>
      <rect x="2" y="3" width="20" height="14" rx="3" />
      <path d="M8 21h8m-4-4v4" />
    </>
  ),
  diagnose: <path d="M3 12h4l3-7 4 14 3-7h4" />,
  link: (
    <>
      <path d="m9 15 6-6m-5-3 2-2a5 5 0 0 1 7 7l-2 2m-7-2-3 3a5 5 0 0 1-7-7l3-3" />
    </>
  ),
};
export function Icon({
  name,
  size = 22,
  style,
}: {
  name: string;
  size?: number;
  style?: CSSProperties;
}) {
  return (
    <svg
      width={size}
      height={size}
      style={style}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name] || paths.screen}
    </svg>
  );
}
