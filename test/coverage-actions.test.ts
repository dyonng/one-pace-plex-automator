import { describe, it, expect } from "vitest";
import {
  isActionable,
  actionHint,
  primaryActionLabel,
  downloadSummary,
  withMagnet,
  needsSearch,
} from "../frontend/src/lib/coverage-actions";
import type { CoverageEpisode, CoverageStatus } from "../frontend/src/lib/api";

const ep = (status: CoverageStatus, over: Partial<CoverageEpisode> = {}): CoverageEpisode => ({
  arcPart: 35,
  arcTitle: "Wano",
  episodeNum: 11,
  seasonEpisodeId: "s35e11",
  episodeTitle: "Episode 11",
  datasetCrc32: "AAAAAAAA",
  status,
  diskFilename: null,
  diskCrc32: null,
  hasMagnet: false,
  extended: false,
  ...over,
});

describe("coverage actions: which chips are clickable", () => {
  it("makes a missing episode clickable — it is the one you need to act on", () => {
    expect(isActionable("missing")).toBe(true);
  });

  it("keeps upgradeable clickable", () => {
    expect(isActionable("upgradeable")).toBe(true);
  });

  it("leaves settled states alone", () => {
    for (const s of ["present", "present_unknown", "present_uncatalogued", "downloading"] as CoverageStatus[]) {
      expect(isActionable(s)).toBe(false);
    }
  });
});

describe("coverage actions: modal primary button", () => {
  it("offers Download for a missing episode that has a link", () => {
    expect(primaryActionLabel(ep("missing", { hasMagnet: true }))).toBe("Download");
  });

  it("offers Update for an upgradeable episode that has a link", () => {
    expect(primaryActionLabel(ep("upgradeable", { hasMagnet: true }))).toBe("Update");
  });

  it("falls back to a search when there is no link, for either status", () => {
    expect(primaryActionLabel(ep("missing"))).toBe("Search for torrent");
    expect(primaryActionLabel(ep("upgradeable"))).toBe("Search for torrent");
  });
});

describe("coverage actions: tooltips and batch summary", () => {
  it("describes a missing chip as something to find, not compare", () => {
    const hint = actionHint(ep("missing", { hasMagnet: true }));
    expect(hint).toContain("missing");
    expect(hint).toContain("click to download");
    expect(hint).not.toContain("compare");
  });

  it("still says compare for an upgrade", () => {
    expect(actionHint(ep("upgradeable", { hasMagnet: true }))).toContain("compare");
  });

  it("says when a missing chip has no link", () => {
    expect(actionHint(ep("missing"))).toContain("no link yet");
  });

  it("splits a batch by link availability", () => {
    const batch = [ep("missing", { hasMagnet: true }), ep("missing"), ep("missing", { hasMagnet: true })];
    expect(withMagnet(batch)).toHaveLength(2);
    expect(needsSearch(batch)).toHaveLength(1);
    expect(downloadSummary(batch)).toBe("2 episodes ready to download, 1 have no link in the feed");
  });

  it("omits the no-link clause when everything is ready", () => {
    expect(downloadSummary([ep("missing", { hasMagnet: true })])).toBe("1 episode ready to download");
  });
});
