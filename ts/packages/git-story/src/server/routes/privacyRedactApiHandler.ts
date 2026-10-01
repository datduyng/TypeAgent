// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { Context } from "hono";
import {
    PrivacyFilterError,
    type PrivacyFilter,
} from "../../privacy/privacyFilter.js";

const MAX_TEXT_BYTES = 64 * 1024;
const MAX_BODY_BYTES = 6 * MAX_TEXT_BYTES + 11;
const HTTP_BAD_REQUEST = 400;
const HTTP_CONTENT_TOO_LARGE = 413;
const HTTP_TOO_MANY_REQUESTS = 429;
const HTTP_SERVICE_UNAVAILABLE = 503;
const HTTP_GATEWAY_TIMEOUT = 504;

const INVALID_REQUEST = "Invalid request";
const INPUT_TOO_LARGE = "Input exceeds the privacy filter limit";
const FILTER_BUSY = "Privacy filter is busy";
const FILTER_UNAVAILABLE = "Privacy filter is unavailable";
const FILTER_TIMEOUT = "Privacy filtering timed out";

class BodyTooLargeError extends Error {}

// Allows 64 KiB of UTF-8 text plus worst-case JSON escaping. The stream check
// still applies when Content-Length is absent or wrong.
async function readBody(c: Context): Promise<Uint8Array> {
    const contentLength = c.req.header("content-length");
    if (contentLength !== undefined) {
        if (!/^\d+$/.test(contentLength)) throw new Error(INVALID_REQUEST);
        const length = Number(contentLength);
        if (!Number.isSafeInteger(length)) throw new Error(INVALID_REQUEST);
        if (length > MAX_BODY_BYTES) throw new BodyTooLargeError();
    }

    const reader = c.req.raw.body?.getReader();
    if (!reader) return new Uint8Array();

    const chunks: Uint8Array[] = [];
    let length = 0;
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > MAX_BODY_BYTES) {
            await reader.cancel().catch(() => undefined);
            throw new BodyTooLargeError();
        }
        chunks.push(value);
    }

    const body = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
        body.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return body;
}

// Accepts exactly {"text":"..."}. Empty text remains valid and unchanged.
async function parseText(c: Context): Promise<string> {
    const mediaType = c.req
        .header("content-type")
        ?.split(";", 1)[0]
        .trim()
        .toLowerCase();
    if (mediaType !== "application/json") throw new Error(INVALID_REQUEST);

    const bytes = await readBody(c);
    const json = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const body: unknown = JSON.parse(json);
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
        throw new Error(INVALID_REQUEST);
    }
    const keys = Object.keys(body);
    if (
        keys.length !== 1 ||
        keys[0] !== "text" ||
        typeof (body as { text?: unknown }).text !== "string"
    ) {
        throw new Error(INVALID_REQUEST);
    }
    const text = (body as { text: string }).text;
    if (Buffer.byteLength(text, "utf8") > MAX_TEXT_BYTES) {
        throw new BodyTooLargeError();
    }
    return text;
}

// POST /api/privacy/redact: returns only redacted text and fixed errors.
export const privacyRedactApiHandler = (filter: PrivacyFilter) =>
    async function privacyRedact(c: Context) {
        let text: string;
        try {
            text = await parseText(c);
        } catch (error) {
            if (error instanceof BodyTooLargeError) {
                return c.json(
                    { error: INPUT_TOO_LARGE },
                    HTTP_CONTENT_TOO_LARGE,
                );
            }
            return c.json({ error: INVALID_REQUEST }, HTTP_BAD_REQUEST);
        }

        if (text.length === 0) return c.json({ text });

        try {
            return c.json({
                text: await filter.redact(text, c.req.raw.signal),
            });
        } catch (error) {
            if (error instanceof PrivacyFilterError) {
                switch (error.code) {
                    case "input_too_large":
                        return c.json(
                            { error: INPUT_TOO_LARGE },
                            HTTP_CONTENT_TOO_LARGE,
                        );
                    case "queue_full":
                        return c.json(
                            { error: FILTER_BUSY },
                            HTTP_TOO_MANY_REQUESTS,
                        );
                    case "timeout":
                        return c.json(
                            { error: FILTER_TIMEOUT },
                            HTTP_GATEWAY_TIMEOUT,
                        );
                    case "unavailable":
                        break;
                }
            }
            return c.json(
                { error: FILTER_UNAVAILABLE },
                HTTP_SERVICE_UNAVAILABLE,
            );
        }
    };
