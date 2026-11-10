// Desktop app download targets. The Apps page owns these URLs; the guided node
// pairing handoff links to them so both surfaces never drift apart. Kept in a
// side-effect-free module: importing the Apps page would pull its stylesheet
// and native-chrome setup into other consumers.
export type AppDownloadLink = {
  id: "macos" | "windows" | "linux";
  href: string;
};

const RELEASES_DOWNLOAD_URL = "https://github.com/openclaw/openclaw/releases";
const WINDOWS_NODE_DOWNLOAD_URL =
  "https://github.com/openclaw/openclaw-windows-node/releases/latest";

export const APP_DOWNLOAD_LINKS: readonly AppDownloadLink[] = [
  { id: "macos", href: RELEASES_DOWNLOAD_URL },
  { id: "windows", href: WINDOWS_NODE_DOWNLOAD_URL },
  { id: "linux", href: RELEASES_DOWNLOAD_URL },
];
