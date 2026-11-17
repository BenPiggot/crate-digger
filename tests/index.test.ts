import { describe, expect, it } from "vitest";
import { VERSION } from "../src/index.js";

describe("toolchain smoke test", () => {
  it("imports TypeScript source through NodeNext .js specifiers", () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
