import type { CSSProperties } from 'react';
import icon from '../assets/kanborg-icon.png';

export interface LogoProps {
  /** Visual size of the mark glyph in pixels. Defaults to 14 (modal-chip scale). */
  size?: number;
  /** Show the "KanBorg" wordmark next to the mark. */
  withWordmark?: boolean;
  /** Muted tone reduces the icon opacity; the approved artwork retains its colors. */
  tone?: 'accent' | 'ink' | 'muted';
  className?: string;
  style?: CSSProperties;
}

/** Shared Growing cube mark for the KanBorg app. */
export function Logo({
  size = 14,
  withWordmark = false,
  tone = 'accent',
  className,
  style,
}: LogoProps) {
  const tileSize = size + 8;

  return (
    <span
      className={className}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        fontFamily: 'var(--ff-sans)',
        fontWeight: 500,
        ...style,
      }}
    >
      <img src={icon} alt="" aria-hidden width={tileSize} height={tileSize}
        style={{flexShrink:0,objectFit:'contain',opacity:tone==='muted'?0.65:1}} />
      {withWordmark ? (
        <span
          style={{
            color: 'var(--ink)',
            fontSize: Math.round(size * 1.05),
            letterSpacing: '-0.01em',
          }}
        >
          KanBorg
        </span>
      ) : null}
    </span>
  );
}
