// Inline SVG icon set for the TalkTime UI. No icon library — each icon is a
// tiny stroke-based SVG that inherits `currentColor` and is sized by the CSS
// of whatever container it sits in (or by an explicit className).

import type { ReactNode } from 'react';

type IconProps = { className?: string };

function Svg({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export function IconLock({ className }: IconProps) {
  return (
    <Svg className={className}>
      <rect x="4.5" y="10" width="15" height="10.5" rx="2.4" />
      <path d="M8 10V7a4 4 0 0 1 8 0v3" />
    </Svg>
  );
}

export function IconShield({ className }: IconProps) {
  return (
    <Svg className={className}>
      <path d="M12 2.5l7.5 3.2v5.6c0 4.9-3.2 8.4-7.5 9.7-4.3-1.3-7.5-4.8-7.5-9.7V5.7L12 2.5z" />
      <path d="M9 12l2 2 4-4" />
    </Svg>
  );
}

export function IconKey({ className }: IconProps) {
  return (
    <Svg className={className}>
      <circle cx="8.5" cy="15.5" r="4.5" />
      <path d="M11.8 12.2 20 4" />
      <path d="m16.5 4.5 3.5 3.5" />
      <path d="m14 7 2.5 2.5" />
    </Svg>
  );
}

export function IconNodes({ className }: IconProps) {
  return (
    <Svg className={className}>
      <circle cx="12" cy="4.5" r="2.5" />
      <circle cx="5" cy="19" r="2.5" />
      <circle cx="19" cy="19" r="2.5" />
      <path d="M11 6.8 6.2 16.6" />
      <path d="M13 6.8 17.8 16.6" />
      <path d="M7.5 19h9" />
    </Svg>
  );
}

export function IconBolt({ className }: IconProps) {
  return (
    <Svg className={className}>
      <path d="M13 2.5 4.5 14h6l-1.5 7.5L19.5 10h-6L13 2.5z" />
    </Svg>
  );
}

export function IconDatabase({ className }: IconProps) {
  return (
    <Svg className={className}>
      <ellipse cx="12" cy="5.5" rx="7.5" ry="3" />
      <path d="M4.5 5.5v13c0 1.66 3.36 3 7.5 3s7.5-1.34 7.5-3v-13" />
      <path d="M4.5 12c0 1.66 3.36 3 7.5 3s7.5-1.34 7.5-3" />
    </Svg>
  );
}

export function IconSend({ className }: IconProps) {
  return (
    <Svg className={className}>
      <path d="M21.5 2.5 2.5 9.2 11 13l3.8 8.3L21.5 2.5z" />
      <path d="M21.5 2.5 11 13" />
    </Svg>
  );
}

export function IconCheck({ className }: IconProps) {
  return (
    <Svg className={className}>
      <path d="M5 12.5 9.5 17 19 6.5" />
    </Svg>
  );
}

export function IconCheckDouble({ className }: IconProps) {
  return (
    <Svg className={className}>
      <path d="M2 12.8 6.4 17 14.5 7" />
      <path d="m10.8 16.6 1.3 1.4L21 7" />
    </Svg>
  );
}
