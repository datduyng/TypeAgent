// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { Command } from "commander";
import http from "node:http";
import {
    PrivacySetupError,
    setupPrivacy,
    validatePrivacyReadyManifest,
} from "../privacy/setup.js";
import { readDaemonStateFile } from "../server/daemonState.js";
import { PRIVACY_REDACT_ROUTE } from "../server/router.js";
const MAX_INPUT_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 250_000;

class PrivacyCommandError extends Error {}

async function readBoundedStdin(): Promise<string> {
    if (process.stdin.isTTY) {
        throw new PrivacyCommandError(
            "git story privacy redact reads text from stdin",
        );
    }
    const chunks: Buffer[] = [];
    let size = 0;
    try {
        for await (const value of process.stdin) {
            const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
            size += chunk.length;
            if (size > MAX_INPUT_BYTES) {
                process.stdin.pause();
                throw new PrivacyCommandError(
                    "Input exceeds the privacy filter limit",
                );
            }
            chunks.push(chunk);
        }
    } catch (error) {
        if (error instanceof PrivacyCommandError) throw error;
        throw new PrivacyCommandError("Failed to read privacy filter input");
    }
    try {
        return new TextDecoder("utf-8", { fatal: true }).decode(
            Buffer.concat(chunks, size),
        );
    } catch {
        throw new PrivacyCommandError(
            "Privacy filter input is not valid UTF-8",
        );
    }
}

async function requestRedaction(text: string): Promise<{
    status: number;
    body: unknown;
}> {
    const state = readDaemonStateFile();
    if (!state) {
        throw new PrivacyCommandError(
            "git-story daemon is not running; run git story daemon start",
        );
    }
    if (!state.privacyEndpoint) {
        throw new PrivacyCommandError(
            "git-story daemon must be restarted before privacy filtering",
        );
    }
    const payload = Buffer.from(JSON.stringify({ text }), "utf8");
    return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (
            error?: PrivacyCommandError,
            result?: { status: number; body: unknown },
        ) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (error !== undefined) reject(error);
            else resolve(result!);
        };
        const request = http.request(
            {
                socketPath: state.privacyEndpoint,
                path: PRIVACY_REDACT_ROUTE,
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    "content-length": payload.length,
                },
            },
            (response) => {
                const chunks: Buffer[] = [];
                let size = 0;
                response.on("data", (chunk: Buffer) => {
                    size += chunk.length;
                    if (size > MAX_RESPONSE_BYTES) {
                        response.destroy();
                        finish(
                            new PrivacyCommandError("Privacy filtering failed"),
                        );
                        return;
                    }
                    chunks.push(chunk);
                });
                const failResponse = () =>
                    finish(new PrivacyCommandError("Privacy filtering failed"));
                response.once("aborted", failResponse);
                response.once("error", failResponse);
                response.once("end", () => {
                    let body: unknown;
                    try {
                        body = JSON.parse(
                            new TextDecoder("utf-8", { fatal: true }).decode(
                                Buffer.concat(chunks, size),
                            ),
                        );
                    } catch {
                        body = undefined;
                    }
                    finish(undefined, {
                        status: response.statusCode ?? 0,
                        body,
                    });
                });
            },
        );
        const timer = setTimeout(() => {
            request.destroy();
            finish(new PrivacyCommandError("Privacy filtering timed out"));
        }, REQUEST_TIMEOUT_MS);
        timer.unref();
        request.once("error", () =>
            finish(
                new PrivacyCommandError(
                    "git-story daemon is not running; run git story daemon start",
                ),
            ),
        );
        request.end(payload);
    });
}

function redactFailure(status: number): string {
    switch (status) {
        case 413:
            return "Input exceeds the privacy filter limit";
        case 429:
            return "Privacy filter is busy";
        case 503:
            return "Privacy filter is unavailable; run git story privacy status";
        case 504:
            return "Privacy filtering timed out";
        default:
            return "Privacy filtering failed";
    }
}

async function redact(): Promise<void> {
    const { status, body } = await requestRedaction(await readBoundedStdin());
    if (status < 200 || status >= 300) {
        throw new PrivacyCommandError(redactFailure(status));
    }
    if (
        body === null ||
        typeof body !== "object" ||
        Array.isArray(body) ||
        typeof (body as { text?: unknown }).text !== "string"
    ) {
        throw new PrivacyCommandError("Privacy filtering failed");
    }
    process.stdout.write((body as { text: string }).text);
}

async function runAction(action: () => Promise<void>): Promise<void> {
    try {
        await action();
    } catch (error) {
        const message =
            error instanceof PrivacyCommandError ||
            error instanceof PrivacySetupError
                ? error.message
                : "Privacy command failed";
        process.stderr.write(`${message}\n`);
        process.exitCode = 1;
    }
}

// `privacy`: explicit local setup and daemon-backed redaction.
export const privacyCommand = new Command("privacy").description(
    "Set up and use the local privacy filter",
);

privacyCommand
    .command("setup")
    .description("Install the pinned local privacy filter")
    .option("--python <path-or-command>", "Python 3.11.x executable")
    .option("--tirith <path-or-command>", "Tirith 0.4.2 executable")
    .action(
        async (options: { python?: string; tirith?: string }) =>
            await runAction(async () => {
                const result = await setupPrivacy(options);
                const prefix = result.alreadyReady
                    ? "Privacy filter is already ready"
                    : "Privacy filter ready";
                process.stdout.write(
                    `${prefix} (GLiNER2 2.0.0, model 1cb4166, Tirith 0.4.2)\n${result.manifest.modelPath}\n`,
                );
            }),
    );

privacyCommand
    .command("status")
    .description("Validate the local privacy filter")
    .action(
        async () =>
            await runAction(async () => {
                const result = await validatePrivacyReadyManifest();
                if (!result.ready) {
                    process.stdout.write(
                        `Not ready: ${result.reason}\nRun git story privacy setup\n`,
                    );
                    process.exitCode = 1;
                    return;
                }
                process.stdout.write(
                    "Ready: GLiNER2 2.0.0, model 1cb4166, Tirith 0.4.2\n",
                );
            }),
    );

privacyCommand
    .command("redact")
    .description("Redact text read from stdin through the daemon")
    .action(async () => await runAction(redact));
