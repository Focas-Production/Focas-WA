import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sendTypingIndicator } from "./meta-api";

const ARGS = {
  phoneNumberId: "test-phone",
  accessToken: "test-token",
  messageId: "wamid.INBOUND123",
} as const;

const okResponse = () =>
  Promise.resolve(new Response(JSON.stringify({ success: true }), { status: 200 }));

describe("sendTypingIndicator", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(okResponse));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("POSTs the read + typing_indicator payload to the messages endpoint", async () => {
    await sendTypingIndicator(ARGS);

    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];

    expect(String(url)).toMatch(/\/test-phone\/messages$/);
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer test-token");

    const body = JSON.parse(init.body);
    expect(body).toEqual({
      messaging_product: "whatsapp",
      status: "read",
      message_id: "wamid.INBOUND123",
      typing_indicator: { type: "text" },
    });
  });

  it("throws Meta's error message on a non-2xx response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              error: { message: "Message too old to mark as read" },
            }),
            { status: 400 },
          ),
        ),
      ),
    );

    await expect(sendTypingIndicator(ARGS)).rejects.toThrow(
      /Message too old/,
    );
  });

  it("falls back to a status message when the error body is not JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response("boom", { status: 500 }))),
    );

    await expect(sendTypingIndicator(ARGS)).rejects.toThrow(
      /Meta API error: 500/,
    );
  });
});
