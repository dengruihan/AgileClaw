import { describe, expect, it } from "vitest";
import { formatVaultSiteOrigin, parseVaultSiteParam } from "./vault-save-login-site.js";

describe("parseVaultSiteParam", () => {
  it("accepts bare hosts, hosts with ports, and full URLs", () => {
    expect(parseVaultSiteParam("example.com")).toEqual({
      originScheme: "https",
      originHost: "example.com",
      originPort: 443,
    });
    expect(parseVaultSiteParam(" example.com:8443 ")).toEqual({
      originScheme: "https",
      originHost: "example.com",
      originPort: 8443,
    });
    expect(parseVaultSiteParam("https://example.com/login?next=1")).toEqual({
      originScheme: "https",
      originHost: "example.com",
      originPort: 443,
    });
    expect(parseVaultSiteParam("http://localhost:3000")).toEqual({
      originScheme: "http",
      originHost: "localhost",
      originPort: 3000,
    });
  });

  it("normalizes IDN hosts to their A-label form", () => {
    expect(parseVaultSiteParam("https://例子.com")?.originHost).toBe("xn--fsqu00a.com");
  });

  it("rejects non-http schemes, credentials, and empty input", () => {
    expect(parseVaultSiteParam("ftp://example.com")).toBeUndefined();
    expect(parseVaultSiteParam("https://user:pass@example.com")).toBeUndefined();
    expect(parseVaultSiteParam("   ")).toBeUndefined();
    expect(parseVaultSiteParam("https://")).toBeUndefined();
  });

  it("formats origins without redundant default ports", () => {
    expect(
      formatVaultSiteOrigin({ originScheme: "https", originHost: "example.com", originPort: 443 }),
    ).toBe("https://example.com");
    expect(
      formatVaultSiteOrigin({ originScheme: "http", originHost: "localhost", originPort: 3000 }),
    ).toBe("http://localhost:3000");
  });
});
