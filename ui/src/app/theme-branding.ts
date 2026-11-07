/** Static branding for the single Phosphor style. */
export type ThemeMascot = "claw" | "none";
export type ThemeBranding = {
  mascot: ThemeMascot;
  workingPhrases?: readonly string[];
};

let branding: ThemeBranding = { mascot: "claw" };

export function currentThemeBranding(): ThemeBranding {
  return branding;
}

/** Test seam for mascot and favicon branches the single style no longer selects. */
export function setCurrentThemeBranding(value: ThemeBranding): void {
  branding = value;
}
