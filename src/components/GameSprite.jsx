import React from 'react';
import { spritePosition } from './sprites';

export default function GameSprite({ sprite, className = '' }) {
  if (!sprite) return null;
  return (
    <span
      aria-hidden="true"
      className={`game-art game-art--${sprite.sheet} ${className}`}
      style={{ backgroundPosition: spritePosition(sprite) }}
    />
  );
}
