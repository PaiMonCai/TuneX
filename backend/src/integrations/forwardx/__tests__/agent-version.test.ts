import { describe, expect, test } from "bun:test";
import { checkAgentVersion } from "../agent-version.ts";
import { admitExecutionSelection } from "../core-contract.ts";

describe("new Link Agent version admission", () => {
  test("rejects the previously admitted malformed and unknown versions", () => {
    const selection = { business_protocol: "tcp", client_front: "plain", carrier: "native_private", driver: "native" } as const;
    for (const version of ["UNKNOWN", "not-semver", "0.14", "01.2.3", "1.2.3-01", "1.2.3\ninvalid"]) {
      expect(admitExecutionSelection(selection, { version, capabilities: ["forward.native.stream.v1"] }).ok).toBe(false);
    }
  });
  test("compares numeric versions rather than strings and ignores build metadata", () => {
    expect(checkAgentVersion("0.9.0", "0.10.0")).toBe("agent_version_too_old");
    expect(checkAgentVersion("v0.10.0+linux-amd64", "0.10.0")).toBeNull();
    expect(checkAgentVersion("0.11.0", "0.10.0")).toBeNull();
    expect(checkAgentVersion("0.0.0", null)).toBeNull();
    expect(checkAgentVersion("1.0.0", "unknown")).toBe("minimum_agent_version_invalid");
  });
  test("prerelease precedence is explicit and handles identifiers without numeric overflow", () => {
    expect(checkAgentVersion("1.0.0-rc.9", "1.0.0")).toBe("agent_version_too_old");
    expect(checkAgentVersion("1.0.0-rc.10", "1.0.0-rc.9")).toBeNull();
    expect(checkAgentVersion("1.0.0-alpha.999999999999999999999", "1.0.0-alpha.999999999999999999998")).toBeNull();
    expect(checkAgentVersion("1.0.0-alpha", "1.0.0-alpha.1")).toBe("agent_version_too_old");
    expect(checkAgentVersion("1.0.0-alpha.1", "1.0.0-alpha.a")).toBe("agent_version_too_old");
  });
});
