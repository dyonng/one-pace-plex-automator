import { describe, it, expect } from "vitest";
import { buildCastEditParams } from "../src/plex";

describe("buildCastEditParams", () => {
  it("locks the field and sets the item type", () => {
    const p = buildCastEditParams([]);
    expect(p["actor.locked"]).toBe(1);
    expect(p["type"]).toBe(2);
  });

  it("maps each role to indexed actor tag + role params", () => {
    const p = buildCastEditParams([
      { tag: "Mayumi Tanaka", role: "Monkey D. Luffy" },
      { tag: "Kazuya Nakai", role: "Roronoa Zoro" },
    ]);
    expect(p["actor[0].tag"]).toBe("Mayumi Tanaka");
    expect(p["actor[0].role"]).toBe("Monkey D. Luffy");
    expect(p["actor[1].tag"]).toBe("Kazuya Nakai");
    expect(p["actor[1].role"]).toBe("Roronoa Zoro");
  });

  it("omits the role param when the character is empty (still writes the actor)", () => {
    const p = buildCastEditParams([{ tag: "Some Actor", role: "" }]);
    expect(p["actor[0].tag"]).toBe("Some Actor");
    expect(p).not.toHaveProperty("actor[0].role");
  });
});
