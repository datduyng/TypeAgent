// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { getRequestListener } from "@hono/node-server";
import { Hono, type Context } from "hono";
import type { PrivacyFilter } from "../privacy/privacyFilter.js";
import { daemonApiHandler } from "./routes/daemonApiHandler.js";
import { privacyRedactApiHandler } from "./routes/privacyRedactApiHandler.js";
import { storyCommitsApiHandler } from "./routes/storyCommitsApiHandler.js";

const HTTP_NOT_FOUND = 404;
const HTTP_METHOD_NOT_ALLOWED = 405;
const HTTP_INTERNAL_ERROR = 500;

// Identity route: `daemon status` checks the pid it returns.
export const DAEMON_ROUTE = "/api/daemon";
export const PRIVACY_REDACT_ROUTE = "/api/privacy/redact";

const methodNotAllowed = (allow: "GET" | "POST") => (c: Context) =>
    c.json(
        { error: `Method not allowed: ${c.req.method}` },
        HTTP_METHOD_NOT_ALLOWED,
        { Allow: allow },
    );

// Public story API. Private text never enters this loopback TCP listener.
// Example: GET /api/story/commits/abc123 -> storyCommitsApiHandler, param hash="abc123"
export function createRoute() {
    const app = new Hono()
        .get(DAEMON_ROUTE, daemonApiHandler)
        .get("/api/story/commits/:hash", storyCommitsApiHandler)
        // Known paths with any other method: 405, not 404.
        .all(DAEMON_ROUTE, methodNotAllowed("GET"))
        .all("/api/story/commits/:hash", methodNotAllowed("GET"))
        .notFound((c) =>
            c.json({ error: `Not found: ${c.req.path}` }, HTTP_NOT_FOUND),
        )
        .onError((_error, c) =>
            c.json({ error: "Internal server error" }, HTTP_INTERNAL_ERROR),
        );

    return getRequestListener(app.fetch);
}

// Privacy API. The daemon exposes it only on user-restricted local IPC.
export function createPrivacyRoute(filter: PrivacyFilter) {
    const app = new Hono()
        .post(PRIVACY_REDACT_ROUTE, privacyRedactApiHandler(filter))
        .all(PRIVACY_REDACT_ROUTE, methodNotAllowed("POST"))
        .notFound((c) =>
            c.json({ error: `Not found: ${c.req.path}` }, HTTP_NOT_FOUND),
        )
        .onError((_error, c) =>
            c.json({ error: "Internal server error" }, HTTP_INTERNAL_ERROR),
        );

    return getRequestListener(app.fetch);
}
