import type { CoverageEpisode, CoverageStatus } from "./api";

/**
 * Statuses whose chip opens the release modal. A "missing" episode is exactly the
 * one you need to act on, so leaving it non-interactive hid the only route to
 * downloading it — the search was reachable for upgrades but not for gaps.
 */
const ACTIONABLE: CoverageStatus[] = ["missing", "upgradeable"];

export function isActionable(status: CoverageStatus): boolean {
  return ACTIONABLE.includes(status);
}

/** Tooltip body describing what clicking the chip does. */
export function actionHint(ep: CoverageEpisode): string {
  const link = ep.hasMagnet ? "click to download" : "no link yet";
  return ep.status === "missing"
    ? `missing · ${link}\nClick to find a release`
    : `${ep.extended ? "upgrade to Extended cut" : "upgradeable"} · ${link}\nClick to compare releases`;
}

/** Label for the modal's primary button. */
export function primaryActionLabel(ep: CoverageEpisode): string {
  if (!ep.hasMagnet) return "Search for torrent";
  return ep.status === "missing" ? "Download" : "Update";
}

export function withMagnet(eps: CoverageEpisode[]): CoverageEpisode[] {
  return eps.filter((e) => e.hasMagnet);
}

export function needsSearch(eps: CoverageEpisode[]): CoverageEpisode[] {
  return eps.filter((e) => !e.hasMagnet);
}

/** Confirmation text for a batch download: how many can start, how many can't. */
export function downloadSummary(eps: CoverageEpisode[]): string {
  const ready = withMagnet(eps).length;
  const rest = eps.length - ready;
  const parts = [`${ready} episode${ready === 1 ? "" : "s"} ready to download`];
  if (rest > 0) parts.push(`${rest} have no link in the feed`);
  return parts.join(", ");
}
