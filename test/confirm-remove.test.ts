import { describe, it, expect } from "vitest";
import {
  needsTypeConfirm,
  typeConfirmOk,
  canConfirmRemove,
  CONFIRM_WORD,
  DELETE_CONFIRM_THRESHOLD,
} from "../frontend/src/lib/confirm";

// The mass-removal incident was one select-all plus one click on a modal whose
// list scrolls out of view. These tests pin the gate that makes a large
// file-deleting batch a deliberate act, without adding friction to small ones.

describe("bulk remove confirmation gate", () => {
  it("does not demand typing for a small selection", () => {
    expect(needsTypeConfirm(true, 1)).toBe(false);
    expect(needsTypeConfirm(true, DELETE_CONFIRM_THRESHOLD - 1)).toBe(false);
  });

  it("demands typing at the threshold and above", () => {
    expect(needsTypeConfirm(true, DELETE_CONFIRM_THRESHOLD)).toBe(true);
    expect(needsTypeConfirm(true, 92)).toBe(true);
  });

  it("never demands typing when files are being kept", () => {
    // Removing rows from tracking is reversible by a rescan; deleting files is not.
    expect(needsTypeConfirm(false, 500)).toBe(false);
  });
});

describe("typed confirmation matching", () => {
  it("accepts the word in any case and with surrounding space", () => {
    expect(typeConfirmOk("DELETE")).toBe(true);
    expect(typeConfirmOk("delete")).toBe(true);
    expect(typeConfirmOk("  Delete  ")).toBe(true);
  });

  it("rejects anything else", () => {
    expect(typeConfirmOk("")).toBe(false);
    expect(typeConfirmOk("DEL")).toBe(false);
    expect(typeConfirmOk("deleted")).toBe(false);
    expect(typeConfirmOk("yes")).toBe(false);
  });
});

describe("confirm button enablement", () => {
  it("is enabled immediately for a small batch", () => {
    expect(canConfirmRemove(true, 2, "")).toBe(true);
  });

  it("stays disabled for a large batch until the word is typed", () => {
    expect(canConfirmRemove(true, 20, "")).toBe(false);
    expect(canConfirmRemove(true, 20, "DELET")).toBe(false);
    expect(canConfirmRemove(true, 20, CONFIRM_WORD)).toBe(true);
  });

  it("is enabled for a large batch that keeps its files", () => {
    expect(canConfirmRemove(false, 200, "")).toBe(true);
  });
});
