import { describe, it, expect } from "vitest";
import { nextAlertState, type AlertState } from "../src/health";
import type { HealthStatus } from "../src/health";

const SEED: AlertState = { baseline: null, candidate: null, count: 0 };

// Fold a sequence of observed statuses through the reducer, collecting emits.
function run(seq: HealthStatus[], initial: AlertState = SEED, confirm = 2) {
  let state = initial;
  const emits: HealthStatus[] = [];
  for (const s of seq) {
    const r = nextAlertState(state, s, confirm);
    state = r.state;
    if (r.emit) emits.push(r.emit);
  }
  return { state, emits };
}

describe("nextAlertState", () => {
  it("seeds the baseline on first confirmation without emitting", () => {
    const { state, emits } = run(["ok", "ok"]);
    expect(emits).toEqual([]);
    expect(state.baseline).toBe("ok");
  });

  it("does not emit for a single transient blip", () => {
    // Steady ok, one warn check, back to ok — warn never confirmed.
    const start: AlertState = { baseline: "ok", candidate: "ok", count: 2 };
    const { emits } = run(["warn", "ok"], start);
    expect(emits).toEqual([]);
  });

  it("emits a problem only after it persists for the confirm count", () => {
    const start: AlertState = { baseline: "ok", candidate: "ok", count: 2 };
    const { state, emits } = run(["warn", "warn"], start);
    expect(emits).toEqual(["warn"]);
    expect(state.baseline).toBe("warn");
  });

  it("emits recovery once ok is confirmed after a problem", () => {
    const start: AlertState = { baseline: "warn", candidate: "warn", count: 2 };
    const { state, emits } = run(["ok", "ok"], start);
    expect(emits).toEqual(["ok"]);
    expect(state.baseline).toBe("ok");
  });

  it("flapping that never holds for the confirm count emits nothing", () => {
    const start: AlertState = { baseline: "ok", candidate: "ok", count: 2 };
    const { emits } = run(["warn", "ok", "warn", "ok", "error", "ok"], start);
    expect(emits).toEqual([]);
  });

  it("escalates warn → error when the worse status is confirmed", () => {
    const start: AlertState = { baseline: "warn", candidate: "warn", count: 2 };
    const { emits } = run(["error", "error"], start);
    expect(emits).toEqual(["error"]);
  });

  it("does not re-emit a steady confirmed status", () => {
    const start: AlertState = { baseline: "error", candidate: "error", count: 2 };
    const { emits } = run(["error", "error", "error"], start);
    expect(emits).toEqual([]);
  });
});
