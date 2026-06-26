import { describe, expect, it } from "vitest";
import {
  DEFAULT_CONNECTOR_LINEAR_PERMISSIONS,
  parsePermissionsFormData,
  permissionsFromRows,
} from "./permissions";

describe("connector Linear permissions", () => {
  it("defaults to read-only Linear issue access", () => {
    expect(DEFAULT_CONNECTOR_LINEAR_PERMISSIONS).toEqual({
      "linear.issues.read": true,
      "linear.issues.write": false,
    });
  });

  it("maps persisted grants into permission state", () => {
    expect(
      permissionsFromRows([
        { scope: "linear.issues.read", granted: false },
        { scope: "linear.issues.write", granted: true },
        { scope: "unknown", granted: true },
      ]),
    ).toEqual({
      "linear.issues.read": false,
      "linear.issues.write": true,
    });
  });

  it("parses setup form data into internal policy scopes", () => {
    const formData = new FormData();
    formData.set("linear.issues.read", "on");

    expect(parsePermissionsFormData(formData)).toEqual({
      "linear.issues.read": true,
      "linear.issues.write": false,
    });
  });
});
