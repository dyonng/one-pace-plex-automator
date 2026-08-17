import { describe, it, expect } from "vitest";
import { parseArcFilter, isArcIncluded, isArcFilterEmpty } from "../src/arc-filter";

const inc = (f: ReturnType<typeof parseArcFilter>, p: number, t: string) => isArcIncluded(f, p, t);

describe("arc filter", () => {
  it("tracks everything when unset", () => {
    const f = parseArcFilter("", "");
    expect(isArcFilterEmpty(f)).toBe(true);
    expect(inc(f, 0, "Specials")).toBe(true);
    expect(inc(f, 24, "Wano")).toBe(true);
  });

  it("excludes by arc part", () => {
    const f = parseArcFilter("", "0");
    expect(inc(f, 0, "Specials")).toBe(false);
    expect(inc(f, 1, "Romance Dawn")).toBe(true);
  });

  it("excludes by arc title", () => {
    const f = parseArcFilter("", "Specials");
    expect(inc(f, 0, "Specials")).toBe(false);
    expect(inc(f, 24, "Wano")).toBe(true);
  });

  it("restricts to an include list when given", () => {
    const f = parseArcFilter("1, 2, Wano", "");
    expect(inc(f, 1, "Romance Dawn")).toBe(true);
    expect(inc(f, 24, "Wano")).toBe(true);
    expect(inc(f, 5, "Baratie")).toBe(false);
  });

  it("lets exclude win over include, so listing both is unambiguous", () => {
    const f = parseArcFilter("Wano", "Wano");
    expect(inc(f, 24, "Wano")).toBe(false);
  });

  it("matches titles through the spelling canonicalizer", () => {
    // The dataset says Alabasta; users often write Arabasta.
    const f = parseArcFilter("", "Arabasta");
    expect(inc(f, 14, "Alabasta")).toBe(false);
    const g = parseArcFilter("", "Alabasta");
    expect(inc(g, 14, "Arabasta")).toBe(false);
  });

  it("is case- and whitespace-tolerant", () => {
    const f = parseArcFilter("", "  specials ,  WANO  ");
    expect(inc(f, 0, "Specials")).toBe(false);
    expect(inc(f, 24, "Wano")).toBe(false);
  });

  it("ignores empty entries and stray commas", () => {
    const f = parseArcFilter(",, ,", " , ");
    expect(isArcFilterEmpty(f)).toBe(true);
    expect(inc(f, 0, "Specials")).toBe(true);
  });

  it("treats a numeric entry as an arc part, not a title", () => {
    const f = parseArcFilter("", "24");
    expect(inc(f, 24, "Wano")).toBe(false);  // part 24 is excluded
    expect(inc(f, 5, "24")).toBe(true);      // an arc merely *titled* "24" is not
  });
});
