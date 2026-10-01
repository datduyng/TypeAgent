// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { Command } from "commander";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
    createPrivacyFilter,
    type PrivacyFilter,
    PrivacyFilterError,
} from "../privacy/privacyFilter.js";
import { readPrivacyReadyManifest } from "../privacy/setup.js";
import {
    createPrivacyEndpoint,
    daemonStateDirectory,
    type DaemonState,
    prepareDaemonStateDirectory,
    readDaemonStateFile,
    removeDaemonStateIfOwned,
    removePrivacyEndpoint,
    writeDaemonStateFile,
} from "../server/daemonState.js";
import { DAEMON_ROUTE } from "../server/router.js";
import { startPrivacyServer, startServer } from "../server/server.js";

// One daemon per user, shared by every project. Each API request names its
// project by absolute path, so the daemon does not depend on any cwd.
//
//   git story daemon start   (from any directory)
//     └─ spawns detached `node daemonMain.js` (no CLI command)
//          └─ listens on 127.0.0.1:51703 (DAEMON_PORT)
//          └─ writes daemon.json with pid, port, and a private IPC endpoint
//   GET /api/story/commits/739e112?project=/Users/me/repo
//   GET /api/story/commits/739e112?project=C:\Users\me\repo  (URL-encoded)
//   git story daemon status  -> reads daemon.json, asks the port for its pid
//   git story daemon stop    -> kills pid; stale daemon.json is cleaned up
//
// Single instance: the bound port is the lock. The OS lets one process
// listen on 127.0.0.1:51703; a second daemon fails with EADDRINUSE. The OS
// frees it when the holder exits or crashes, so no stale lock survives.
// Only the port holder writes daemon.json; others only read it.
//
// The shared state path comes from os.homedir() in daemonState.ts.
const LOG_FILE = "daemon.log";
const START_TIMEOUT_MS = 5000;
const STOP_TIMEOUT_MS = 5000;
const POLL_MS = 50;
const IDENTITY_TIMEOUT_MS = 1000;

// Entry point `start` spawns; not exposed as a CLI command.
const DAEMON_MAIN = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../daemonMain.js",
);

function isAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (e) {
        // EPERM: the process exists but belongs to another user.
        return (e as NodeJS.ErrnoException).code === "EPERM";
    }
}

// True when the server on `state.port` reports `state.pid`. A live pid alone
// is not enough: after a crash or reboot the OS can reuse it.
async function answersAsDaemon(state: DaemonState): Promise<boolean> {
    try {
        const res = await fetch(`${url(state)}${DAEMON_ROUTE}`, {
            signal: AbortSignal.timeout(IDENTITY_TIMEOUT_MS),
        });
        const body = (await res.json()) as { pid?: number };
        return body.pid === state.pid;
    } catch {
        return false;
    }
}

// Running daemon's state, or undefined for a missing, corrupt, or stale
// file. Never deletes: only the port holder owns the file.
async function readState(): Promise<DaemonState | undefined> {
    const state = readDaemonStateFile();
    if (state && isAlive(state.pid) && (await answersAsDaemon(state))) {
        return state;
    }
    return undefined;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const url = (s: DaemonState) => `http://127.0.0.1:${s.port}`;

// Fixed so every client knows where the daemon listens. Chosen from the
// IANA dynamic range (49152-65535) to avoid registered services.
const DAEMON_PORT = 51703;

async function start(): Promise<void> {
    const running = await readState();
    if (running) {
        process.stdout.write(
            `Already running (pid ${running.pid}) at ${url(running)}\n`,
        );
        return;
    }
    const dir = daemonStateDirectory();
    prepareDaemonStateDirectory();
    const log = fs.openSync(path.join(dir, LOG_FILE), "a", 0o600);
    // cwd is the state dir so the daemon never holds a project directory
    // open (Windows cannot delete a directory that is some process's cwd).
    // windowsHide: no console window on Windows.
    const child = spawn(process.execPath, [DAEMON_MAIN], {
        cwd: dir,
        detached: true,
        stdio: ["ignore", log, log],
        windowsHide: true,
    });
    child.unref();
    fs.closeSync(log);
    // Wait for the daemon to write its state; fail fast if it exits first.
    let exited = false;
    child.once("exit", () => (exited = true));
    for (let t = 0; t < START_TIMEOUT_MS && !exited; t += POLL_MS) {
        const state = await readState();
        if (state && state.pid === child.pid) {
            process.stdout.write(
                `Started (pid ${state.pid}) at ${url(state)}\n`,
            );
            return;
        }
        await sleep(POLL_MS);
    }
    // The child exits when a concurrent start won.
    const winner = await readState();
    if (winner) {
        process.stdout.write(
            `Already running (pid ${winner.pid}) at ${url(winner)}\n`,
        );
        return;
    }
    if (!exited) child.kill();
    process.stderr.write(
        `Failed to start daemon, see ${path.join(dir, LOG_FILE)}\n`,
    );
    process.exitCode = 1;
}

async function stop(): Promise<void> {
    const state = await readState();
    if (!state) {
        process.stdout.write("Not running\n");
        return;
    }
    // SIGTERM runs the daemon's cleanup on macOS/Linux. Windows has no signals:
    // Node terminates the process, and the next readState drops the stale file.
    process.kill(state.pid, "SIGTERM");
    for (let t = 0; t < STOP_TIMEOUT_MS; t += POLL_MS) {
        if (!isAlive(state.pid)) {
            removeDaemonStateIfOwned(state.pid);
            process.stdout.write(`Stopped (pid ${state.pid})\n`);
            return;
        }
        await sleep(POLL_MS);
    }
    process.stderr.write(`Daemon (pid ${state.pid}) did not stop\n`);
    process.exitCode = 1;
}

const PRIVACY_REQUEST_TIMEOUT_MS = 240_000;
const MAX_QUEUED_PRIVACY_REQUESTS = 16;

type PrivacyRequest = {
    readonly text: string;
    readonly signal: AbortSignal | undefined;
    readonly controller: AbortController;
    readonly resolve: (text: string) => void;
    readonly reject: (error: PrivacyFilterError) => void;
    readonly onAbort: () => void;
    timer: NodeJS.Timeout | undefined;
    settled: boolean;
};

// One daemon queue bounds model memory and covers generation changes. A new
// generation starts only after the previous request and worker have closed.
function createLazyPrivacyFilter(): PrivacyFilter {
    let current: { name: string; filter: PrivacyFilter } | undefined;
    const queue: PrivacyRequest[] = [];
    let active: PrivacyRequest | undefined;
    let closed = false;

    function settle(
        request: PrivacyRequest,
        result: string | PrivacyFilterError,
    ): void {
        if (request.settled) return;
        request.settled = true;
        if (request.timer !== undefined) clearTimeout(request.timer);
        request.signal?.removeEventListener("abort", request.onAbort);
        if (result instanceof PrivacyFilterError) request.reject(result);
        else request.resolve(result);
    }

    function abort(
        request: PrivacyRequest,
        code: "timeout" | "unavailable",
    ): void {
        const index = queue.indexOf(request);
        if (index !== -1) queue.splice(index, 1);
        settle(request, new PrivacyFilterError(code));
        if (active === request) request.controller.abort();
    }

    async function run(request: PrivacyRequest): Promise<void> {
        try {
            const manifest = readPrivacyReadyManifest();
            if (!manifest) throw new PrivacyFilterError("unavailable");
            if (current?.name !== manifest.generation) {
                await current?.filter.close();
                current = {
                    name: manifest.generation,
                    filter: createPrivacyFilter(manifest),
                };
            }
            const result = await current.filter.redact(
                request.text,
                request.controller.signal,
            );
            settle(request, result);
        } catch (error) {
            settle(
                request,
                error instanceof PrivacyFilterError
                    ? error
                    : new PrivacyFilterError("unavailable"),
            );
        } finally {
            active = undefined;
            startNext();
        }
    }

    function startNext(): void {
        if (active !== undefined || closed) return;
        const next = queue.shift();
        if (next === undefined) return;
        active = next;
        void run(next);
    }

    return {
        redact(text, signal) {
            if (text.length === 0) return Promise.resolve(text);
            if (closed || signal?.aborted) {
                return Promise.reject(new PrivacyFilterError("unavailable"));
            }
            if (
                active !== undefined &&
                queue.length >= MAX_QUEUED_PRIVACY_REQUESTS
            ) {
                return Promise.reject(new PrivacyFilterError("queue_full"));
            }
            return new Promise((resolve, reject) => {
                const controller = new AbortController();
                const request: PrivacyRequest = {
                    text,
                    signal,
                    controller,
                    resolve,
                    reject,
                    onAbort: () => abort(request, "unavailable"),
                    timer: undefined,
                    settled: false,
                };
                request.timer = setTimeout(
                    () => abort(request, "timeout"),
                    PRIVACY_REQUEST_TIMEOUT_MS,
                );
                request.timer.unref();
                signal?.addEventListener("abort", request.onAbort, {
                    once: true,
                });
                queue.push(request);
                startNext();
            });
        },
        async close() {
            if (closed) return;
            closed = true;
            for (const request of queue.splice(0)) {
                settle(request, new PrivacyFilterError("unavailable"));
            }
            if (active !== undefined) {
                settle(active, new PrivacyFilterError("unavailable"));
                active.controller.abort();
            }
            await current?.filter.close();
        },
    };
}

// Daemon body, run by daemonMain.js in the process `start` spawns. Writes the state file once
// listening, removes it on SIGTERM/SIGINT.
// Fails (see daemon.log) when the port is in use.
export async function runDaemon(): Promise<void> {
    const port = DAEMON_PORT;
    const privacyFilter = createLazyPrivacyFilter();
    let server: Awaited<ReturnType<typeof startServer>>;
    try {
        server = await startServer(port);
    } catch (e) {
        process.stderr.write(
            `Cannot listen on port ${port}: ${(e as Error).message}\n`,
        );
        process.exitCode = 1;
        return;
    }

    let privacyEndpoint: string | undefined;
    let privacyServer:
        | Awaited<ReturnType<typeof startPrivacyServer>>
        | undefined;
    if (process.platform !== "win32") {
        const staleEndpoint = readDaemonStateFile()?.privacyEndpoint;
        try {
            removePrivacyEndpoint(staleEndpoint);
            privacyEndpoint = createPrivacyEndpoint();
            privacyServer = await startPrivacyServer(
                privacyEndpoint,
                privacyFilter,
            );
        } catch (e) {
            removePrivacyEndpoint(privacyEndpoint);
            await privacyFilter.close();
            server.closeAllConnections();
            server.close();
            process.stderr.write(
                `Cannot create the private endpoint: ${(e as Error).message}\n`,
            );
            process.exitCode = 1;
            return;
        }
    }

    // Holding the port makes this the only daemon. Publish available endpoints last.
    const state: DaemonState = {
        pid: process.pid,
        port,
        ...(privacyEndpoint === undefined ? {} : { privacyEndpoint }),
    };
    writeDaemonStateFile(state);
    process.stdout.write(`Listening at ${url(state)}\n`);
    let shuttingDown = false;
    const shutdown = () => {
        if (shuttingDown) return;
        shuttingDown = true;
        removeDaemonStateIfOwned(process.pid);
        const finish = async () => {
            try {
                await privacyFilter.close();
                removePrivacyEndpoint(privacyEndpoint);
            } finally {
                process.exit(0);
            }
        };
        if (privacyServer !== undefined) {
            privacyServer.close(() => void finish());
            privacyServer.closeAllConnections();
        } else {
            void finish();
        }
        server.close();
        server.closeAllConnections();
    };
    process.once("SIGTERM", shutdown);
    process.once("SIGINT", shutdown);
}

// `daemon`: manages the per-user HTTP API server.
export const daemonCommand = new Command("daemon").description(
    "Manage the git-story API server shared by all projects",
);

daemonCommand.command("start").description("Start the daemon").action(start);

daemonCommand.command("stop").description("Stop the daemon").action(stop);

daemonCommand
    .command("restart")
    .description("Restart the daemon")
    .action(async () => {
        await stop();
        if (!process.exitCode) await start();
    });

daemonCommand
    .command("status")
    .description("Show whether the daemon is running")
    .action(async () => {
        const state = await readState();
        process.stdout.write(
            state
                ? `Running (pid ${state.pid}) at ${url(state)}\n`
                : "Not running\n",
        );
    });
