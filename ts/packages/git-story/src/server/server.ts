// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import fs from "node:fs";
import { createServer, type Server } from "node:http";
import type { PrivacyFilter } from "../privacy/privacyFilter.js";
import { createPrivacyRoute, createRoute } from "./router.js";

// Loopback only: the API reads the repository and has no authentication.
export const LOOPBACK_HOST = "127.0.0.1";
const HTTP_FORBIDDEN = 403;

// Starts the HTTP API on `port` and resolves once listening. Rejects with
// EADDRINUSE when the port is taken.
export function startServer(port: number): Promise<Server> {
    const route = createRoute();
    // Reject any Host other than this loopback address, so a DNS-rebinding
    // web page cannot reach the API. Example: "evil.test:51703" -> 403.
    const server = createServer((req, res) => {
        const allowed = [`${LOOPBACK_HOST}:${port}`, `localhost:${port}`];
        if (!allowed.includes(req.headers.host ?? "")) {
            res.writeHead(HTTP_FORBIDDEN).end();
            return;
        }
        void route(req, res);
    });
    return listen(server, port, LOOPBACK_HOST);
}

// Private input uses a user-scoped Unix socket, never loopback TCP.
export async function startPrivacyServer(
    endpoint: string,
    privacyFilter: PrivacyFilter,
): Promise<Server> {
    const server = createServer(createPrivacyRoute(privacyFilter));
    await listen(server, endpoint);
    if (process.platform !== "win32") fs.chmodSync(endpoint, 0o600);
    return server;
}

function listen(
    server: Server,
    endpoint: number | string,
    host?: string,
): Promise<Server> {
    return new Promise((resolve, reject) => {
        server.once("error", reject);
        const ready = () => {
            server.removeListener("error", reject);
            resolve(server);
        };
        if (typeof endpoint === "number") server.listen(endpoint, host, ready);
        else server.listen(endpoint, ready);
    });
}
