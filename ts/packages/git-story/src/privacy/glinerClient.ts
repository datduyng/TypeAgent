// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

const PROTOCOL_VERSION = 1;
const MAX_FRAME_BYTES = 1024 * 1024;
const START_TIMEOUT_MS = 180_000;
const INFERENCE_TIMEOUT_MS = 60_000;
const MAX_QUEUED_REQUESTS = 16;
const STOP_TIMEOUT_MS = 5_000;
const GLINER_VERSION = "2.0.0";
const TRANSFORMERS_VERSION = "4.45.2";
const MODEL_REVISION = "1cb4166094dc58fa8d836429f060d6c95f62b495";
const THRESHOLD = 0.5;
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

export const GLINER_LABELS = [
    "person",
    "full_name",
    "first_name",
    "middle_name",
    "last_name",
    "date_of_birth",
    "email",
    "phone_number",
    "address",
    "street_address",
    "city",
    "state_or_region",
    "postal_code",
    "country",
    "government_id",
    "national_id_number",
    "passport_number",
    "drivers_license_number",
    "license_number",
    "tax_id",
    "tax_number",
    "bank_account",
    "account_number",
    "routing_number",
    "iban",
    "payment_card",
    "card_number",
    "card_expiry",
    "card_cvv",
    "username",
    "ip_address",
    "account_id",
    "sensitive_account_id",
    "password",
    "secret",
    "api_key",
    "access_token",
    "recovery_code",
    "sensitive_date",
    "document_date",
    "expiration_date",
    "transaction_date",
] as const;

const labelSet: ReadonlySet<string> = new Set(GLINER_LABELS);

export type GlinerClientErrorCode =
    | "input_too_large"
    | "queue_full"
    | "unavailable"
    | "timeout";

export class GlinerClientError extends Error {
    constructor(readonly code: GlinerClientErrorCode) {
        super(code);
        this.name = "GlinerClientError";
    }
}

export interface GlinerSpan {
    readonly label: string;
    readonly start: number;
    readonly end: number;
    readonly confidence: number;
}

export interface GlinerClientConfig {
    readonly pythonPath: string;
    readonly workerPath: string;
    readonly modelPath: string;
}

export interface GlinerClient {
    findSpans(
        text: string,
        signal?: AbortSignal,
    ): Promise<readonly GlinerSpan[]>;
    close(): Promise<void>;
}

interface Request {
    readonly id: number;
    readonly text: string;
    readonly signal: AbortSignal | undefined;
    readonly resolve: (spans: readonly GlinerSpan[]) => void;
    readonly reject: (error: GlinerClientError) => void;
    readonly onAbort: () => void;
    timer: NodeJS.Timeout | undefined;
    settled: boolean;
}

interface WorkerState {
    readonly child: ChildProcessWithoutNullStreams;
    buffer: Buffer;
    frameLength: number | undefined;
    ready: boolean;
    readonly readyPromise: Promise<void>;
    readonly resolveReady: () => void;
    readonly rejectReady: (error: GlinerClientError) => void;
    startTimer: NodeJS.Timeout | undefined;
}

class LocalGlinerClient implements GlinerClient {
    private worker: WorkerState | undefined;
    private active: Request | undefined;
    private readonly queue: Request[] = [];
    private nextId = 1;
    private closePromise: Promise<void> | undefined;
    private closed = false;

    constructor(private readonly config: GlinerClientConfig) {}

    findSpans(
        text: string,
        signal?: AbortSignal,
    ): Promise<readonly GlinerSpan[]> {
        if (this.closed || signal?.aborted) {
            return Promise.reject(new GlinerClientError("unavailable"));
        }
        if (
            this.active !== undefined &&
            this.queue.length >= MAX_QUEUED_REQUESTS
        ) {
            return Promise.reject(new GlinerClientError("queue_full"));
        }

        return new Promise((resolve, reject) => {
            const request: Request = {
                id: this.allocateId(),
                text,
                signal,
                resolve,
                reject,
                onAbort: () => this.abort(request),
                timer: undefined,
                settled: false,
            };
            signal?.addEventListener("abort", request.onAbort, { once: true });
            if (this.active === undefined) {
                this.active = request;
                void this.runActive(request);
            } else {
                this.queue.push(request);
            }
        });
    }

    close(): Promise<void> {
        if (this.closePromise !== undefined) return this.closePromise;
        this.closed = true;
        const worker = this.worker;
        this.worker = undefined;
        this.failAll("unavailable");
        if (worker !== undefined && !worker.ready) {
            if (worker.startTimer !== undefined)
                clearTimeout(worker.startTimer);
            worker.rejectReady(new GlinerClientError("unavailable"));
        }
        this.closePromise =
            worker === undefined ? Promise.resolve() : this.stopWorker(worker);
        return this.closePromise;
    }

    private allocateId(): number {
        const id = this.nextId;
        this.nextId = id === Number.MAX_SAFE_INTEGER ? 1 : this.nextId + 1;
        return id;
    }

    private abort(request: Request): void {
        if (request.settled) return;
        const index = this.queue.indexOf(request);
        if (index !== -1) {
            this.queue.splice(index, 1);
            this.rejectRequest(request, "unavailable");
            return;
        }
        const worker = this.worker;
        if (this.active === request && worker !== undefined) {
            this.failWorker(worker, "unavailable");
        } else if (this.active === request) {
            this.failAll("unavailable");
        }
    }

    private rejectRequest(request: Request, code: GlinerClientErrorCode): void {
        if (request.settled) return;
        request.settled = true;
        if (request.timer !== undefined) clearTimeout(request.timer);
        request.signal?.removeEventListener("abort", request.onAbort);
        request.reject(new GlinerClientError(code));
    }

    private resolveRequest(
        request: Request,
        spans: readonly GlinerSpan[],
    ): void {
        if (request.settled) return;
        request.settled = true;
        if (request.timer !== undefined) clearTimeout(request.timer);
        request.signal?.removeEventListener("abort", request.onAbort);
        request.resolve(spans);
    }

    private async runActive(request: Request): Promise<void> {
        let frame: Buffer;
        try {
            frame = encodeFrame({
                protocol: PROTOCOL_VERSION,
                type: "redact",
                id: request.id,
                text: request.text,
                labels: GLINER_LABELS,
                threshold: THRESHOLD,
            });
        } catch {
            this.finishRequest(
                request,
                new GlinerClientError("input_too_large"),
            );
            return;
        }

        try {
            const worker = await this.ensureWorker();
            if (this.active !== request || this.closed) return;
            if (request.signal?.aborted) {
                this.failWorker(worker, "unavailable");
                return;
            }
            request.timer = setTimeout(
                () => this.failWorker(worker, "timeout"),
                INFERENCE_TIMEOUT_MS,
            );
            worker.child.stdin.write(frame, (error) => {
                if (error !== null && error !== undefined) {
                    this.failWorker(worker, "unavailable");
                }
            });
        } catch {
            if (this.active === request) this.failAll("unavailable");
        }
    }

    private ensureWorker(): Promise<WorkerState> {
        if (this.worker !== undefined) {
            return this.worker.readyPromise.then(
                () => this.worker as WorkerState,
            );
        }

        const child = spawn(
            this.config.pythonPath,
            [this.config.workerPath, "--model", this.config.modelPath],
            {
                stdio: ["pipe", "pipe", "pipe"],
                env: childEnvironment({
                    PYTHONUNBUFFERED: "1",
                    PYTHONDONTWRITEBYTECODE: "1",
                    PYTHONNOUSERSITE: "1",
                    HF_HUB_OFFLINE: "1",
                    HF_HUB_DISABLE_TELEMETRY: "1",
                    TRANSFORMERS_OFFLINE: "1",
                    HF_DATASETS_OFFLINE: "1",
                    TOKENIZERS_PARALLELISM: "false",
                }),
            },
        );
        child.stderr.resume();

        let resolveReady!: () => void;
        let rejectReady!: (error: GlinerClientError) => void;
        const readyPromise = new Promise<void>((resolve, reject) => {
            resolveReady = resolve;
            rejectReady = reject;
        });
        const worker: WorkerState = {
            child,
            buffer: Buffer.alloc(0),
            frameLength: undefined,
            ready: false,
            readyPromise,
            resolveReady,
            rejectReady,
            startTimer: undefined,
        };
        this.worker = worker;
        worker.startTimer = setTimeout(
            () => this.failWorker(worker, "timeout"),
            START_TIMEOUT_MS,
        );

        child.stdout.on("data", (chunk: Buffer) => this.onData(worker, chunk));
        child.once("error", () => this.failWorker(worker, "unavailable"));
        child.once("exit", () => this.failWorker(worker, "unavailable"));
        child.stdin.on("error", () => this.failWorker(worker, "unavailable"));

        return readyPromise.then(() => worker);
    }

    private onData(worker: WorkerState, chunk: Buffer): void {
        if (this.worker !== worker) return;
        try {
            worker.buffer = Buffer.concat([worker.buffer, chunk]);
            while (true) {
                if (worker.frameLength === undefined) {
                    if (worker.buffer.length < 4) return;
                    const length = worker.buffer.readUInt32BE(0);
                    if (length === 0 || length > MAX_FRAME_BYTES)
                        throw new Error();
                    worker.frameLength = length;
                    worker.buffer = worker.buffer.subarray(4);
                }
                if (worker.buffer.length < worker.frameLength) return;
                const payload = worker.buffer.subarray(0, worker.frameLength);
                worker.buffer = worker.buffer.subarray(worker.frameLength);
                worker.frameLength = undefined;
                this.onMessage(worker, JSON.parse(utf8Decoder.decode(payload)));
                if (this.worker !== worker) return;
            }
        } catch {
            this.failWorker(worker, "unavailable");
        }
    }

    private onMessage(worker: WorkerState, message: unknown): void {
        if (!worker.ready) {
            if (!isReadyMessage(message)) throw new Error();
            worker.ready = true;
            if (worker.startTimer !== undefined)
                clearTimeout(worker.startTimer);
            worker.startTimer = undefined;
            worker.resolveReady();
            return;
        }

        const request = this.active;
        if (request === undefined || !isRecord(message)) throw new Error();
        if (
            message.protocol !== PROTOCOL_VERSION ||
            message.id !== request.id
        ) {
            throw new Error();
        }
        if (message.type === "error") {
            if (message.code === "input_too_large") {
                this.finishRequest(
                    request,
                    new GlinerClientError("input_too_large"),
                );
                return;
            }
            throw new Error();
        }
        if (message.type !== "result" || !Array.isArray(message.spans)) {
            throw new Error();
        }
        const spans = message.spans.map((span) =>
            validateSpan(span, request.text),
        );
        this.finishRequest(request, undefined, spans);
    }

    private finishRequest(
        request: Request,
        error?: GlinerClientError,
        spans?: readonly GlinerSpan[],
    ): void {
        if (this.active !== request) return;
        if (request.timer !== undefined) clearTimeout(request.timer);
        this.active = undefined;
        if (error !== undefined) this.rejectRequest(request, error.code);
        else this.resolveRequest(request, spans ?? []);

        const next = this.queue.shift();
        if (next !== undefined && !this.closed) {
            this.active = next;
            void this.runActive(next);
        }
    }

    private failWorker(
        worker: WorkerState,
        code: Exclude<GlinerClientErrorCode, "input_too_large" | "queue_full">,
    ): void {
        if (this.worker !== worker) return;
        this.worker = undefined;
        if (worker.startTimer !== undefined) clearTimeout(worker.startTimer);
        worker.rejectReady(new GlinerClientError(code));
        this.failAll(code);
        void this.stopWorker(worker);
    }

    private failAll(code: GlinerClientErrorCode): void {
        if (this.active !== undefined) {
            this.rejectRequest(this.active, code);
            this.active = undefined;
        }
        for (const request of this.queue.splice(0)) {
            this.rejectRequest(request, code);
        }
    }

    private stopWorker(worker: WorkerState): Promise<void> {
        if (
            worker.child.exitCode !== null ||
            worker.child.signalCode !== null
        ) {
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
            worker.child.once("exit", finish);
            if (!worker.child.kill("SIGKILL")) finish();
        });
    }
}

const inheritedEnvironment = [
    "PATH",
    "SystemRoot",
    "WINDIR",
    "PATHEXT",
    "TEMP",
    "TMP",
    "TMPDIR",
    "HOME",
    "USERPROFILE",
    "XDG_CONFIG_HOME",
] as const;

export function childEnvironment(
    fixed: Readonly<Record<string, string>>,
): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {};
    for (const name of inheritedEnvironment) {
        const value = process.env[name];
        if (value !== undefined) env[name] = value;
    }
    return { ...env, ...fixed };
}

export function createGlinerClient(config: GlinerClientConfig): GlinerClient {
    return new LocalGlinerClient(config);
}

function encodeFrame(message: unknown): Buffer {
    const payload = Buffer.from(JSON.stringify(message), "utf8");
    if (payload.length === 0 || payload.length > MAX_FRAME_BYTES) {
        throw new Error();
    }
    const frame = Buffer.allocUnsafe(payload.length + 4);
    frame.writeUInt32BE(payload.length, 0);
    payload.copy(frame, 4);
    return frame;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isReadyMessage(message: unknown): boolean {
    return (
        isRecord(message) &&
        message.protocol === PROTOCOL_VERSION &&
        message.type === "ready" &&
        message.glinerVersion === GLINER_VERSION &&
        message.transformersVersion === TRANSFORMERS_VERSION &&
        message.modelRevision === MODEL_REVISION &&
        message.threshold === THRESHOLD &&
        Array.isArray(message.labels) &&
        message.labels.length === GLINER_LABELS.length &&
        message.labels.every((label, index) => label === GLINER_LABELS[index])
    );
}

function validateSpan(value: unknown, text: string): GlinerSpan {
    if (!isRecord(value)) throw new Error();
    const { label, start, end, confidence } = value;
    if (
        typeof label !== "string" ||
        !labelSet.has(label) ||
        !Number.isInteger(start) ||
        !Number.isInteger(end) ||
        typeof confidence !== "number" ||
        !Number.isFinite(confidence) ||
        confidence < THRESHOLD ||
        confidence > 1
    ) {
        throw new Error();
    }
    const typedStart = start as number;
    const typedEnd = end as number;
    if (
        typedStart < 0 ||
        typedStart >= typedEnd ||
        typedEnd > text.length ||
        splitsSurrogatePair(text, typedStart) ||
        splitsSurrogatePair(text, typedEnd)
    ) {
        throw new Error();
    }
    return { label, start: typedStart, end: typedEnd, confidence };
}

function splitsSurrogatePair(text: string, offset: number): boolean {
    if (offset <= 0 || offset >= text.length) return false;
    const before = text.charCodeAt(offset - 1);
    const after = text.charCodeAt(offset);
    return (
        before >= 0xd800 &&
        before <= 0xdbff &&
        after >= 0xdc00 &&
        after <= 0xdfff
    );
}
