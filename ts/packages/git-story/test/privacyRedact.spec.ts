// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { jest } from "@jest/globals";
import { Hono } from "hono";
import {
    PrivacyFilterError,
    type PrivacyFilter,
} from "../src/privacy/privacyFilter.js";
import { privacyRedactApiHandler } from "../src/server/routes/privacyRedactApiHandler.js";

it("maps redaction results and failures without leaking input", async () => {
    const privateInput = "synthetic private input";
    const cases = [
        [undefined, 200, { text: "[REDACTED:PII]" }],
        [
            "input_too_large",
            413,
            { error: "Input exceeds the privacy filter limit" },
        ],
        ["queue_full", 429, { error: "Privacy filter is busy" }],
        ["unavailable", 503, { error: "Privacy filter is unavailable" }],
        ["timeout", 504, { error: "Privacy filtering timed out" }],
        ["unexpected", 503, { error: "Privacy filter is unavailable" }],
    ] as const;

    for (const [failure, status, expected] of cases) {
        const redact = jest.fn(async () => {
            if (failure === "unexpected") throw new Error(privateInput);
            if (failure !== undefined) throw new PrivacyFilterError(failure);
            return "[REDACTED:PII]";
        });
        const filter: PrivacyFilter = { redact, close: async () => undefined };
        const app = new Hono().post("/", privacyRedactApiHandler(filter));
        const response = await app.request("/", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ text: privateInput }),
        });
        const body: unknown = await response.json();

        expect(response.status).toBe(status);
        expect(body).toEqual(expected);
        expect(redact).toHaveBeenCalledWith(
            privateInput,
            expect.any(AbortSignal),
        );
        expect(JSON.stringify(body)).not.toContain(privateInput);
    }
});
