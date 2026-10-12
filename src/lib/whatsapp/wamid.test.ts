import { describe, expect, it } from "vitest";

import { wamidKey } from "./wamid";

describe("wamidKey", () => {
  it("matches a phone-app echo id to the phone-keyed id of the same message", () => {
    // Echo of a message sent from the WhatsApp Business app (keyed on a
    // business-scoped user id) vs. the same message keyed on the phone.
    const echo =
      "wamid.HBgTSU4uMTI1ODk2NzU5MzAyMjI5OBUUABEYFjNFQjBGRDFFOTAxMjU0RTBFNkEzRkUA";
    const phone = `wamid.${Buffer.from(
      "\x1c\x18\x0c918866460937\x15\x02\x00\x11\x18\x163EB0FD1E901254E0E6A3FE\x00",
      "latin1",
    ).toString("base64")}`;
    expect(wamidKey(echo)).toBe("3EB0FD1E901254E0E6A3FE");
    expect(wamidKey(phone)).toBe(wamidKey(echo));
  });

  it("reads outbound (0x11) and inbound (0x12) ids", () => {
    expect(
      wamidKey("wamid.HBgMOTE4ODY2NDYwOTM3FQIAERgUQ0VGNkExREIzREVEMUU2MjBEQzIA"),
    ).toBe("CEF6A1DB3DED1E620DC2");
    expect(
      wamidKey("wamid.HBgLMTY1MDM4Nzk0MzkVAgASGBQzQUFERjg0NDEzNDdFODU3MUMxMAA="),
    ).toBe("3AADF8441347E8571C10");
  });

  it("returns null for anything that isn't a wamid", () => {
    expect(wamidKey(null)).toBeNull();
    expect(wamidKey("")).toBeNull();
    expect(wamidKey("msg_123")).toBeNull();
    expect(wamidKey("wamid.!!!")).toBeNull();
  });
});
