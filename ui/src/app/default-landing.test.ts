import type { RouteLocation } from "@openclaw/uirouter";
import { describe, expect, it } from "vitest";
import { INTERNAL_SESSION_PATH_PARAM } from "../app-route-paths.ts";
import { isNewSessionLanding, newSessionLandingLocation } from "./default-landing.ts";

function location(pathname: string, search = "", hash = ""): RouteLocation {
  return { pathname, search, hash };
}

describe("isNewSessionLanding", () => {
  it.each([
    { name: "bare root", location: location("/") },
    { name: "base path root", location: location("/ui/"), basePath: "/ui" },
    { name: "bare chat", location: location("/chat") },
    { name: "bare chat trailing slash", location: location("/chat/") },
    { name: "base path chat", location: location("/ui/chat"), basePath: "/ui" },
    { name: "bare chat with agent", location: location("/chat", "?agent=research") },
  ])("treats $name as a new-session landing", ({ location: entry, basePath = "" }) => {
    expect(isNewSessionLanding(entry, basePath)).toBe(true);
  });

  it.each([
    { name: "explicit session path", location: location("/chat/main") },
    { name: "explicit agent session path", location: location("/chat/research/telegram/12345") },
    { name: "saved session query", location: location("/chat", "?session=agent%3Amain%3Amain") },
    { name: "draft text query", location: location("/chat", "?draft=hello") },
    { name: "catalog query", location: location("/chat", "?catalog=coding") },
    {
      name: "rewritten internal session path",
      location: location("/chat", `?${INTERNAL_SESSION_PATH_PARAM}=%2Fchat%2Fmain`),
    },
    { name: "plugin page slug", location: location("/research") },
    { name: "another route", location: location("/sessions") },
    {
      name: "other route under the base path",
      location: location("/ui/sessions"),
      basePath: "/ui",
    },
  ])("leaves $name alone", ({ location: entry, basePath = "" }) => {
    expect(isNewSessionLanding(entry, basePath)).toBe(false);
  });
});

describe("newSessionLandingLocation", () => {
  it("drops the session and face markers while naming the draft's agent", () => {
    expect(
      newSessionLandingLocation(
        location("/chat", "?session=agent%3Amain%3Amain&face=dashboard&theme=dark", "#composer"),
        "",
        "research",
      ),
    ).toEqual({ pathname: "/new", search: "?theme=dark&agent=research", hash: "#composer" });
  });

  it("keeps the base path and omits the agent when none is selected", () => {
    expect(newSessionLandingLocation(location("/ui/"), "/ui", null)).toEqual({
      pathname: "/ui/new",
      search: "",
      hash: "",
    });
  });
});
