// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
    childEnvironment,
    createGlinerClient,
    GlinerClientError,
    type GlinerClient,
    type GlinerSpan,
} from "./glinerClient.js";

const GLINER_VERSION = "2.0.0";
const GLINER_REVISION = "3c913c7369301133d3b7699252074c4303ada50e";
const TRANSFORMERS_VERSION = "4.45.2";
const MODEL_REVISION = "1cb4166094dc58fa8d836429f060d6c95f62b495";
const TIRITH_VERSION = "0.4.2";
const TIRITH_TIMEOUT_MS = 5_000;
const STOP_TIMEOUT_MS = 5_000;
const REQUEST_TIMEOUT_MS = 240_000;
const MAX_QUEUED_REQUESTS = 16;
const REDACTION = "[REDACTED:PII]";
const MAX_TIRITH_OUTPUT_BYTES = 1024 * 1024;

export type PrivacyFilterErrorCode =
    | "input_too_large"
    | "queue_full"
    | "unavailable"
    | "timeout";

const errorMessages: Record<PrivacyFilterErrorCode, string> = {
    input_too_large: "Privacy filter input is too large",
    queue_full: "Privacy filter queue is full",
    unavailable: "Privacy filter is unavailable",
    timeout: "Privacy filter timed out",
};

export class PrivacyFilterError extends Error {
    constructor(readonly code: PrivacyFilterErrorCode) {
        super(errorMessages[code]);
        this.name = "PrivacyFilterError";
    }
}

export interface PrivacyFilter {
    redact(text: string, signal?: AbortSignal): Promise<string>;
    close(): Promise<void>;
}

export interface PrivacyFilterManifest {
    readonly schemaVersion: 2;
    readonly pythonPath: string;
    readonly workerPath: string;
    readonly modelPath: string;
    readonly tirithPath: string;
    readonly tirithSha256: string;
    readonly gliner2Version: string;
    readonly gliner2Revision: string;
    readonly transformersVersion: string;
    readonly modelRevision: string;
    readonly tirithVersion: string;
}

interface TirithRedaction {
    readonly label: string;
    readonly count: number;
}

interface TirithResult {
    readonly redacted_content: string;
    readonly redactions: readonly TirithRedaction[];
}

interface RedactRequest {
    readonly text: string;
    readonly signal: AbortSignal | undefined;
    readonly resolve: (text: string) => void;
    readonly reject: (error: PrivacyFilterError) => void;
    readonly controller: AbortController;
    readonly onAbort: () => void;
    timer: NodeJS.Timeout | undefined;
    settled: boolean;
}

class LocalPrivacyFilter implements PrivacyFilter {
    private readonly gliner: GlinerClient;
    private readonly tirithChildren = new Set<ChildProcessWithoutNullStreams>();
    private readonly queue: RedactRequest[] = [];
    private active = false;
    private closePromise: Promise<void> | undefined;
    private closed = false;

    constructor(private readonly manifest: PrivacyFilterManifest) {
        validateManifest(manifest);
        this.gliner = createGlinerClient(manifest);
    }

    redact(text: string, signal?: AbortSignal): Promise<string> {
        if (text.length === 0) return Promise.resolve("");
        if (this.closed || signal?.aborted) {
            return Promise.reject(new PrivacyFilterError("unavailable"));
        }
        if (this.active && this.queue.length >= MAX_QUEUED_REQUESTS) {
            return Promise.reject(new PrivacyFilterError("queue_full"));
        }

        return new Promise((resolve, reject) => {
            const controller = new AbortController();
            const request: RedactRequest = {
                text,
                signal,
                resolve,
                reject,
                controller,
                onAbort: () => this.abort(request, "unavailable"),
                timer: undefined,
                settled: false,
            };
            request.timer = setTimeout(
                () => this.abort(request, "timeout"),
                REQUEST_TIMEOUT_MS,
            );
            request.timer.unref();
            signal?.addEventListener("abort", request.onAbort, { once: true });
            this.queue.push(request);
            this.startNext();
        });
    }

    close(): Promise<void> {
        if (this.closePromise !== undefined) return this.closePromise;
        this.closed = true;
        for (const request of this.queue.splice(0)) {
            this.settle(request, new PrivacyFilterError("unavailable"));
        }
        const stops = [...this.tirithChildren].map((child) => {
            child.stdin.destroy();
            return stopChild(child);
        });
        this.closePromise = Promise.all([this.gliner.close(), ...stops]).then(
            () => undefined,
        );
        return this.closePromise;
    }

    private abort(
        request: RedactRequest,
        code: "timeout" | "unavailable",
    ): void {
        if (request.settled) return;
        const index = this.queue.indexOf(request);
        if (index !== -1) {
            this.queue.splice(index, 1);
            this.settle(request, new PrivacyFilterError(code));
            return;
        }
        if (!this.active) return;
        this.settle(request, new PrivacyFilterError(code));
        request.controller.abort();
    }

    private settle(
        request: RedactRequest,
        result: string | PrivacyFilterError,
    ): void {
        if (request.settled) return;
        request.settled = true;
        if (request.timer !== undefined) clearTimeout(request.timer);
        request.signal?.removeEventListener("abort", request.onAbort);
        if (result instanceof PrivacyFilterError) request.reject(result);
        else request.resolve(result);
    }

    private startNext(): void {
        if (this.active || this.closed) return;
        const request = this.queue.shift();
        if (request === undefined) return;
        this.active = true;
        void this.runRequest(request);
    }

    private async runRequest(request: RedactRequest): Promise<void> {
        try {
            const spans = await this.gliner.findSpans(
                request.text,
                request.controller.signal,
            );
            this.settle(
                request,
                await this.runTirith(
                    applyRedactions(request.text, spans),
                    request.controller.signal,
                ),
            );
        } catch (error) {
            if (request.controller.signal.aborted) {
                this.settle(request, new PrivacyFilterError("unavailable"));
            } else if (error instanceof PrivacyFilterError) {
                this.settle(request, error);
            } else if (error instanceof GlinerClientError) {
                this.settle(request, new PrivacyFilterError(error.code));
            } else this.settle(request, new PrivacyFilterError("unavailable"));
        } finally {
            this.active = false;
            this.startNext();
        }
    }

    private async verifyTirith(): Promise<void> {
        let actual: string;
        try {
            actual = await sha256File(this.manifest.tirithPath);
        } catch {
            throw new PrivacyFilterError("unavailable");
        }
        if (actual !== this.manifest.tirithSha256) {
            throw new PrivacyFilterError("unavailable");
        }
    }

    private async runTirith(
        text: string,
        signal: AbortSignal,
    ): Promise<string> {
        await this.verifyTirith();
        if (signal.aborted) throw new PrivacyFilterError("timeout");
        return new Promise((resolve, reject) => {
            if (this.closed) {
                reject(new PrivacyFilterError("unavailable"));
                return;
            }
            const child = spawn(
                this.manifest.tirithPath,
                ["redact", "--audience", "public-paste", "--json"],
                {
                    stdio: ["pipe", "pipe", "pipe"],
                    env: childEnvironment({
                        TIRITH_LOG: "0",
                        TIRITH_OFFLINE: "1",
                    }),
                },
            );
            this.tirithChildren.add(child);
            const stdout: Buffer[] = [];
            let stdoutBytes = 0;
            let failure: PrivacyFilterError | undefined;
            const fail = (code: "timeout" | "unavailable") => {
                failure ??= new PrivacyFilterError(code);
                child.kill("SIGKILL");
            };
            const timer = setTimeout(() => fail("timeout"), TIRITH_TIMEOUT_MS);
            const onAbort = () => fail("timeout");
            signal.addEventListener("abort", onAbort, { once: true });

            child.stderr.resume();
            child.stdout.on("data", (chunk: Buffer) => {
                stdoutBytes += chunk.length;
                if (stdoutBytes > MAX_TIRITH_OUTPUT_BYTES) {
                    fail("unavailable");
                    return;
                }
                stdout.push(chunk);
            });
            child.once("error", () => fail("unavailable"));
            child.stdin.once("error", () => fail("unavailable"));
            child.once("close", (code) => {
                clearTimeout(timer);
                signal.removeEventListener("abort", onAbort);
                this.tirithChildren.delete(child);
                if (failure !== undefined) {
                    reject(failure);
                    return;
                }
                if (code !== 0) {
                    reject(new PrivacyFilterError("unavailable"));
                    return;
                }
                try {
                    const result = validateTirithResult(
                        JSON.parse(Buffer.concat(stdout).toString("utf8")),
                    );
                    resolve(result.redacted_content);
                } catch {
                    reject(new PrivacyFilterError("unavailable"));
                }
            });
            child.stdin.end(text);
        });
    }
}

export function createPrivacyFilter(
    manifest: PrivacyFilterManifest,
): PrivacyFilter {
    return new LocalPrivacyFilter(manifest);
}

function validateManifest(manifest: PrivacyFilterManifest): void {
    if (
        manifest.schemaVersion !== 2 ||
        manifest.gliner2Version !== GLINER_VERSION ||
        manifest.gliner2Revision !== GLINER_REVISION ||
        manifest.transformersVersion !== TRANSFORMERS_VERSION ||
        manifest.modelRevision !== MODEL_REVISION ||
        manifest.tirithVersion !== TIRITH_VERSION ||
        !/^[a-f0-9]{64}$/.test(manifest.tirithSha256) ||
        !isAbsolutePath(manifest.pythonPath) ||
        !isAbsolutePath(manifest.workerPath) ||
        !isAbsolutePath(manifest.modelPath) ||
        !isAbsolutePath(manifest.tirithPath)
    ) {
        throw new PrivacyFilterError("unavailable");
    }
}

function isAbsolutePath(value: unknown): value is string {
    return typeof value === "string" && path.isAbsolute(value);
}

function applyRedactions(text: string, spans: readonly GlinerSpan[]): string {
    const sorted = [...spans].sort(
        (left, right) => left.start - right.start || right.end - left.end,
    );
    const merged: { start: number; end: number }[] = [];
    for (const span of sorted) {
        const last = merged.at(-1);
        if (last !== undefined && span.start <= last.end) {
            last.end = Math.max(last.end, span.end);
        } else {
            merged.push({ start: span.start, end: span.end });
        }
    }

    let redacted = text;
    for (let index = merged.length - 1; index >= 0; index--) {
        const span = merged[index];
        redacted =
            redacted.slice(0, span.start) +
            REDACTION +
            redacted.slice(span.end);
    }
    return redacted;
}

async function sha256File(file: string): Promise<string> {
    const hash = crypto.createHash("sha256");
    const input = fs.createReadStream(file);
    for await (const chunk of input) hash.update(chunk);
    return hash.digest("hex");
}

function stopChild(child: ChildProcessWithoutNullStreams): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) {
        return Promise.resolve();
    }
    return new Promise((resolve) => {
        let done = false;
        const finish = () => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            resolve();
        };
        const timer = setTimeout(finish, STOP_TIMEOUT_MS);
        child.once("close", finish);
        if (!child.kill("SIGKILL")) finish();
    });
}

function validateTirithResult(value: unknown): TirithResult {
    if (!isRecord(value) || typeof value.redacted_content !== "string") {
        throw new Error();
    }
    if (
        !Array.isArray(value.redactions) ||
        !value.redactions.every(
            (redaction) =>
                isRecord(redaction) &&
                typeof redaction.label === "string" &&
                redaction.label.length > 0 &&
                Number.isInteger(redaction.count) &&
                (redaction.count as number) >= 0,
        )
    ) {
        throw new Error();
    }
    return value as unknown as TirithResult;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
