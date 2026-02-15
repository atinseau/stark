import { describe, expect, it } from "bun:test";

import { generateIdentity } from "../src/utils/identity.ts";

describe("generateIdentity", () => {
  it("returns an object with id and name properties", () => {
    const identity = generateIdentity();

    expect(identity).toHaveProperty("id");
    expect(identity).toHaveProperty("name");
    expect(typeof identity.id).toBe("string");
    expect(typeof identity.name).toBe("string");
  });

  it("generates a valid UUID v4 for the id", () => {
    const identity = generateIdentity();
    const uuidV4Regex =
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

    expect(identity.id).toMatch(uuidV4Regex);
  });

  it("generates a two-part name (adjective + first name)", () => {
    const identity = generateIdentity();
    const parts = identity.name.split(" ");

    // Should have at least two parts: "Adjective FirstName"
    expect(parts.length).toBeGreaterThanOrEqual(2);
  });

  it("capitalizes the first character of the name", () => {
    const identity = generateIdentity();
    const firstChar = identity.name.charAt(0);

    expect(firstChar).toBe(firstChar.toUpperCase());
  });

  it("generates unique ids across multiple calls", () => {
    const identities = Array.from({ length: 50 }, () => generateIdentity());
    const ids = identities.map((i) => i.id);
    const uniqueIds = new Set(ids);

    expect(uniqueIds.size).toBe(50);
  });

  it("generates non-empty names", () => {
    // Run multiple times to guard against edge cases in faker
    for (let i = 0; i < 20; i++) {
      const identity = generateIdentity();
      expect(identity.name.length).toBeGreaterThan(0);
      expect(identity.name.trim()).toBe(identity.name);
    }
  });

  it("allows overriding the id", () => {
    const customId = "custom-agent-id-001";
    const identity = generateIdentity({ id: customId });

    expect(identity.id).toBe(customId);
    // Name should still be generated
    expect(identity.name.length).toBeGreaterThan(0);
  });

  it("allows overriding the name", () => {
    const customName = "My Custom Agent";
    const identity = generateIdentity({ name: customName });

    expect(identity.name).toBe(customName);
    // ID should still be a valid UUID
    const uuidV4Regex =
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    expect(identity.id).toMatch(uuidV4Regex);
  });

  it("allows overriding both id and name", () => {
    const customId = "pool-agent-42";
    const customName = "Sentinel Prime";
    const identity = generateIdentity({ id: customId, name: customName });

    expect(identity.id).toBe(customId);
    expect(identity.name).toBe(customName);
  });

  it("ignores undefined overrides and still generates values", () => {
    const identity = generateIdentity({ id: undefined, name: undefined });

    expect(identity.id.length).toBeGreaterThan(0);
    expect(identity.name.length).toBeGreaterThan(0);
  });

  it("returns a frozen-compatible object (readonly properties)", () => {
    const identity = generateIdentity();

    // The type system enforces readonly, but verify the shape is correct
    expect(Object.keys(identity).sort()).toEqual(["id", "name"]);
  });
});
