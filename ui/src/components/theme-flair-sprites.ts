import { svg, type TemplateResult } from "lit";
import type { ThemeAvatarHatId } from "../../../packages/gateway-protocol/src/theme.ts";
import { LOBSTER_HAT_SPRITES } from "./lobster-hat-sprites.ts";

// Avatar hats overlay the top of the circular avatar; the circle's own
// overflow clip crops the crown, which reads as a hat worn, not held.
// Tilted 12°, the angle of Red Hat Display's ascenders.
function avatarLobsterHat(hat: keyof typeof LOBSTER_HAT_SPRITES, brimY: number) {
  return svg`
    <svg class="identity-avatar__hat-svg" viewBox="0 0 100 100" aria-hidden="true">
      <g transform="translate(60 27) rotate(-12) scale(2.2) translate(-60 ${-brimY})">
        ${LOBSTER_HAT_SPRITES[hat]}
      </g>
    </svg>
  `;
}

export const AVATAR_HAT_SPRITES: Record<ThemeAvatarHatId, TemplateResult> = {
  fedora: svg`
    <svg class="identity-avatar__hat-svg" viewBox="0 0 100 100" aria-hidden="true">
      <g transform="rotate(-12 60 25)">
        <ellipse cx="60" cy="27" rx="27" ry="5" fill="#d40000" />
        <path d="M43 27 Q45 7 60 6 Q75 7 77 27 Z" fill="#ee0000" />
        <path d="M44 22 Q60 18 76 22 L76 27 L44 27 Z" fill="#a60000" />
        <path d="M50 10 Q60 6 70 10" stroke="#ff6b6b" stroke-width="1.8" fill="none" stroke-linecap="round" opacity="0.7" />
      </g>
    </svg>
  `,
  crown: avatarLobsterHat("crown", 11),
  santa: avatarLobsterHat("santa", 10.5),
  party: avatarLobsterHat("party", 11),
  pumpkin: avatarLobsterHat("pumpkin", 12),
};
