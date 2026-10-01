// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { childEnvironment, GLINER_LABELS } from "./glinerClient.js";
const PRIVACY_ROOT = path.join(
    os.homedir(),
    ".typeagent",
    "git-story",
    "privacy",
);
const GENERATIONS_DIR = "generations";
const READY_FILE = "ready.json";
const LAST_FAILURE_FILE = "lastFailure.json";
const SETUP_LOCK_FILE = "setup.lock";
const LOCKF_PATH = "/usr/bin/lockf";
const LOCK_READY_MARKER = "locked\n";
const LOCK_HELPER = `process.stdout.write(${JSON.stringify(LOCK_READY_MARKER)}); process.stdin.resume();`;
const INSTALLING_FILE = ".installing";
const READY_SCHEMA_VERSION = 2;
const LAST_FAILURE_SCHEMA_VERSION = 1;
const PYTHON_VERSION = [3, 11] as const;
const TIRITH_VERSION = "0.4.2";
const GLINER2_VERSION = "2.0.0";
const GLINER2_REVISION = "3c913c7369301133d3b7699252074c4303ada50e";
const GLINER_THRESHOLD = 0.5;
const TRANSFORMERS_VERSION = "4.45.2";
const MODEL_REPOSITORY = "fastino/gliner2-privacy-filter-PII-multi";
const MODEL_REVISION = "1cb4166094dc58fa8d836429f060d6c95f62b495";
const PINNED_PACKAGES = [
    { name: "gliner2", version: GLINER2_VERSION },
    { name: "transformers", version: TRANSFORMERS_VERSION },
    { name: "torch", version: "2.14.0" },
    { name: "tokenizers", version: "0.20.4" },
    { name: "peft", version: "0.21.0" },
    { name: "safetensors", version: "0.8.0" },
    { name: "huggingface-hub", version: "0.36.2" },
    { name: "numpy", version: "2.4.6" },
    { name: "pydantic", version: "2.13.5" },
    { name: "pydantic_core", version: "2.46.5" },
    { name: "annotated-types", version: "0.8.0" },
    { name: "typing-inspection", version: "0.4.4" },
    { name: "typing_extensions", version: "4.16.0" },
    { name: "requests", version: "2.34.2" },
    { name: "urllib3", version: "2.8.0" },
    { name: "certifi", version: "2026.7.22" },
    { name: "charset-normalizer", version: "3.5.1" },
    { name: "idna", version: "3.20" },
    { name: "tqdm", version: "4.70.1" },
    { name: "filelock", version: "4.0.3" },
    { name: "regex", version: "2026.9.10" },
    { name: "PyYAML", version: "6.0.3" },
    { name: "packaging", version: "26.3" },
    { name: "psutil", version: "7.2.2" },
    { name: "accelerate", version: "1.15.0" },
    { name: "setuptools", version: "84.0.0" },
    { name: "sympy", version: "1.14.0" },
    { name: "networkx", version: "3.6.1" },
    { name: "Jinja2", version: "3.1.6" },
    { name: "MarkupSafe", version: "3.0.3" },
    { name: "fsspec", version: "2026.9.0" },
    { name: "hf-xet", version: "1.6.0" },
    { name: "mpmath", version: "1.3.0" },
] as const;
const PROCESS_TIMEOUT_MS = 30_000;
const PROCESS_STOP_TIMEOUT_MS = 5_000;
const SETUP_LOCK_TIMEOUT_SECONDS = 30;
const INSTALL_TIMEOUT_MS = 30 * 60_000;
const MODEL_DOWNLOAD_TIMEOUT_MS = 30 * 60_000;
const WORKER_PROBE_TIMEOUT_MS = 180_000;
const TIRITH_PROBE_TIMEOUT_MS = 5_000;
const PROCESS_OUTPUT_LIMIT = 1024 * 1024;
const WORKER_FRAME_LIMIT = 1024 * 1024;
const MODEL_DOWNLOAD_BASE = `https://huggingface.co/${MODEL_REPOSITORY}/resolve/${MODEL_REVISION}`;
const SUPPORTED_PLATFORM = "darwin:arm64";
const MINIMUM_MACOS_MAJOR_VERSION = 23;
interface ModelFileManifest {
    path: string;
    size: number;
    sha256: string;
}
interface ModelManifest {
    repository: string;
    revision: string;
    files: ModelFileManifest[];
}
export interface PrivacyReadyManifest {
    schemaVersion: 2;
    generation: string;
    pythonPath: string;
    workerPath: string;
    modelPath: string;
    tirithPath: string;
    tirithSha256: string;
    pythonVersion: string;
    tirithVersion: "0.4.2";
    gliner2Version: "2.0.0";
    gliner2Revision: "3c913c7369301133d3b7699252074c4303ada50e";
    transformersVersion: "4.45.2";
    modelRepository: "fastino/gliner2-privacy-filter-PII-multi";
    modelRevision: "1cb4166094dc58fa8d836429f060d6c95f62b495";
    installedAt: string;
}
export interface PrivacySetupOptions {
    python?: string;
    tirith?: string;
}
export type PrivacyReadyValidation =
    | { ready: true; manifest: PrivacyReadyManifest }
    | { ready: false; reason: string };
export type PrivacySetupResult = {
    alreadyReady: boolean;
    manifest: PrivacyReadyManifest;
};
type ProcessResult = { code: number | null; stdout: Buffer; stderr: Buffer };
export class PrivacySetupError extends Error {}
function privacyRoot(): string {
    return PRIVACY_ROOT;
}
function readyPath(): string {
    return path.join(privacyRoot(), READY_FILE);
}
function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
function isInside(parent: string, child: string): boolean {
    const relative = path.relative(parent, child);
    return (
        relative !== "" &&
        !relative.startsWith(`..${path.sep}`) &&
        relative !== ".." &&
        !path.isAbsolute(relative)
    );
}
function venvPython(venv: string): string {
    return process.platform === "win32"
        ? path.join(venv, "Scripts", "python.exe")
        : path.join(venv, "bin", "python");
}

type SetupLock = {
    release(): Promise<void>;
};

// `lockf` owns the advisory lock until its child exits. The OS releases it
// after crashes, so setup never has to identify or remove a stale owner.
async function acquireSetupLock(): Promise<SetupLock> {
    const lockPath = path.join(privacyRoot(), SETUP_LOCK_FILE);
    return await new Promise((resolve, reject) => {
        const child = spawn(
            LOCKF_PATH,
            [
                "-k",
                "-t",
                SETUP_LOCK_TIMEOUT_SECONDS.toString(),
                lockPath,
                process.execPath,
                "-e",
                LOCK_HELPER,
            ],
            {
                env: childEnvironment({}),
                stdio: ["pipe", "pipe", "ignore"],
            },
        );
        let output = "";
        let settled = false;
        const exited = new Promise<void>((exitResolve) => {
            child.once("exit", () => exitResolve());
        });
        child.stdin.on("error", () => undefined);
        const fail = () => {
            if (settled) return;
            settled = true;
            child.kill("SIGKILL");
            reject(
                new PrivacySetupError(
                    "Another privacy setup is still running.",
                ),
            );
        };
        child.once("error", fail);
        child.once("exit", fail);
        child.stdout.on("data", (chunk: Buffer) => {
            if (settled) return;
            output += chunk.toString("utf8");
            if (
                output.length > LOCK_READY_MARKER.length ||
                output === LOCK_READY_MARKER
            ) {
                if (output !== LOCK_READY_MARKER || !child.stdin) {
                    fail();
                    return;
                }
                settled = true;
                child.removeListener("error", fail);
                child.removeListener("exit", fail);
                resolve({
                    release: async () => {
                        child.stdin.end();
                        await exited;
                    },
                });
            }
        });
    });
}

function cleanIncompleteGenerations(): void {
    const generationsPath = path.join(privacyRoot(), GENERATIONS_DIR);
    const activeGeneration = readPrivacyReadyManifest()?.generation;
    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(generationsPath, { withFileTypes: true });
    } catch {
        return;
    }
    for (const entry of entries) {
        if (!entry.isDirectory() || entry.name === activeGeneration) continue;
        const generationPath = path.join(generationsPath, entry.name);
        if (fs.existsSync(path.join(generationPath, INSTALLING_FILE))) {
            fs.rmSync(generationPath, { recursive: true, force: true });
        }
    }
}

function cleanOldGenerations(activeGeneration: string): void {
    const generationsPath = path.join(privacyRoot(), GENERATIONS_DIR);
    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(generationsPath, { withFileTypes: true });
    } catch {
        return;
    }
    for (const entry of entries) {
        if (!entry.isDirectory() || entry.name === activeGeneration) continue;
        fs.rmSync(path.join(generationsPath, entry.name), {
            recursive: true,
            force: true,
        });
    }
}

function parseReadyManifest(value: unknown): PrivacyReadyManifest | undefined {
    if (!isRecord(value) || value.schemaVersion !== READY_SCHEMA_VERSION) {
        return undefined;
    }
    const generation = value.generation;
    if (
        typeof generation !== "string" ||
        !/^[A-Za-z0-9._-]+$/.test(generation)
    ) {
        return undefined;
    }
    const generationPath = path.resolve(
        privacyRoot(),
        GENERATIONS_DIR,
        generation,
    );
    const expectedPython = venvPython(path.join(generationPath, "venv"));
    const expectedWorker = path.join(generationPath, "glinerWorker.py");
    const expectedModel = path.join(generationPath, "model");
    if (
        value.pythonPath !== expectedPython ||
        value.workerPath !== expectedWorker ||
        value.modelPath !== expectedModel ||
        typeof value.tirithPath !== "string" ||
        !path.isAbsolute(value.tirithPath) ||
        typeof value.tirithSha256 !== "string" ||
        !/^[a-f0-9]{64}$/.test(value.tirithSha256) ||
        typeof value.pythonVersion !== "string" ||
        value.tirithVersion !== TIRITH_VERSION ||
        value.gliner2Version !== GLINER2_VERSION ||
        value.gliner2Revision !== GLINER2_REVISION ||
        value.transformersVersion !== TRANSFORMERS_VERSION ||
        value.modelRepository !== MODEL_REPOSITORY ||
        value.modelRevision !== MODEL_REVISION ||
        typeof value.installedAt !== "string" ||
        !isInside(path.join(privacyRoot(), GENERATIONS_DIR), generationPath)
    ) {
        return undefined;
    }
    return value as unknown as PrivacyReadyManifest;
}
// Runtime uses this synchronous pointer read. It never starts a process or
// reaches the network; setup and status perform the expensive validation.
export function readPrivacyReadyManifest(): PrivacyReadyManifest | undefined {
    try {
        const value: unknown = JSON.parse(fs.readFileSync(readyPath(), "utf8"));
        return parseReadyManifest(value);
    } catch {
        return undefined;
    }
}
function assetPath(name: string): string {
    const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
    const candidates = [
        path.join(moduleDirectory, name),
        path.resolve(moduleDirectory, "../../src/privacy", name),
    ];
    const found = candidates.find((candidate) => fs.existsSync(candidate));
    if (!found) {
        throw new PrivacySetupError(
            "Privacy setup assets are missing. Reinstall git-story.",
        );
    }
    return found;
}
function loadModelManifest(): ModelManifest {
    let value: unknown;
    try {
        value = JSON.parse(
            fs.readFileSync(assetPath("modelManifest.json"), "utf8"),
        );
    } catch (error) {
        if (error instanceof PrivacySetupError) throw error;
        throw new PrivacySetupError("The privacy model manifest is invalid.");
    }
    if (
        !isRecord(value) ||
        value.repository !== MODEL_REPOSITORY ||
        value.revision !== MODEL_REVISION ||
        !Array.isArray(value.files) ||
        value.files.length !== 5
    ) {
        throw new PrivacySetupError("The privacy model manifest is invalid.");
    }
    const files: ModelFileManifest[] = [];
    for (const entry of value.files) {
        if (
            !isRecord(entry) ||
            typeof entry.path !== "string" ||
            path.isAbsolute(entry.path) ||
            entry.path.split(/[\\/]/).includes("..") ||
            !Number.isSafeInteger(entry.size) ||
            (entry.size as number) < 0 ||
            typeof entry.sha256 !== "string" ||
            !/^[a-f0-9]{64}$/.test(entry.sha256)
        ) {
            throw new PrivacySetupError(
                "The privacy model manifest is invalid.",
            );
        }
        files.push({
            path: entry.path,
            size: entry.size as number,
            sha256: entry.sha256,
        });
    }
    if (new Set(files.map((file) => file.path)).size !== files.length) {
        throw new PrivacySetupError("The privacy model manifest is invalid.");
    }
    return {
        repository: value.repository,
        revision: value.revision,
        files,
    };
}
function normalizedPackageName(name: string): string {
    return name.toLowerCase().replace(/[-_.]+/g, "-");
}

function requirementAsset(): string {
    const file = assetPath("requirements.txt");
    try {
        const requirements = fs.readFileSync(file, "utf8");
        const pinnedRequirements = new Set(
            requirements
                .split(/\r?\n/)
                .map((line) => /^([A-Za-z0-9._-]+)==([^\s\\]+)/.exec(line))
                .filter((match): match is RegExpExecArray => match !== null)
                .map(
                    (match) =>
                        `${normalizedPackageName(match[1])}==${match[2]}`,
                ),
        );
        if (
            requirements.includes("--hash=md5:") ||
            PINNED_PACKAGES.some(
                ({ name, version }) =>
                    !pinnedRequirements.has(
                        `${normalizedPackageName(name)}==${version}`,
                    ),
            ) ||
            !requirements.includes("--hash=sha256:")
        ) {
            throw new Error("invalid requirements");
        }
    } catch (error) {
        if (error instanceof PrivacySetupError) throw error;
        throw new PrivacySetupError("Privacy setup requirements are invalid.");
    }
    return file;
}
async function hashFile(
    file: string,
): Promise<{ size: number; sha256: string }> {
    return await new Promise((resolve, reject) => {
        const hash = crypto.createHash("sha256");
        let size = 0;
        const input = fs.createReadStream(file);
        input.on("data", (value: Buffer | string) => {
            const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
            size += chunk.length;
            hash.update(chunk);
        });
        input.once("error", reject);
        input.once("end", () => resolve({ size, sha256: hash.digest("hex") }));
    });
}
async function verifyModelFiles(
    modelPath: string,
    manifest: ModelManifest,
): Promise<string | undefined> {
    for (const entry of manifest.files) {
        const file = path.join(modelPath, entry.path);
        let actual: { size: number; sha256: string };
        try {
            actual = await hashFile(file);
        } catch {
            return entry.path;
        }
        if (actual.size !== entry.size || actual.sha256 !== entry.sha256) {
            return entry.path;
        }
    }
    return undefined;
}
function executableCandidates(command: string): string[] {
    if (path.isAbsolute(command)) return [command];
    if (path.basename(command) !== command) return [];
    const directories = (process.env.PATH ?? "").split(path.delimiter);
    const extensions =
        process.platform === "win32"
            ? (process.env.PATHEXT ?? ".EXE;.COM").split(";")
            : [""];
    const hasExtension = path.extname(command) !== "";
    return directories.flatMap((directory) =>
        (hasExtension ? [""] : extensions).map((extension) =>
            path.join(directory, `${command}${extension}`),
        ),
    );
}
function resolveExecutable(command: string, name: string): string {
    for (const candidate of executableCandidates(command)) {
        try {
            const stat = fs.statSync(candidate);
            if (!stat.isFile()) continue;
            if (process.platform !== "win32") {
                fs.accessSync(candidate, fs.constants.X_OK);
            }
            return fs.realpathSync(candidate);
        } catch {
            // Continue through PATH without exposing machine-specific failures.
        }
    }
    throw new PrivacySetupError(
        `${name} was not found. Rerun with --${name.toLowerCase()} <path>.`,
    );
}
async function runProcess(
    executable: string,
    args: string[],
    options: {
        input?: Buffer | string;
        timeout?: number;
        capture?: boolean;
        env?: NodeJS.ProcessEnv;
    } = {},
): Promise<ProcessResult> {
    return await new Promise((resolve, reject) => {
        const capture = options.capture ?? true;
        const child = spawn(executable, args, {
            env: options.env ?? childEnvironment({}),
            stdio: [
                options.input === undefined ? "ignore" : "pipe",
                "pipe",
                "pipe",
            ],
            windowsHide: true,
        });
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        let stdoutBytes = 0;
        let stderrBytes = 0;
        let failure: Error | undefined;
        let settled = false;
        let stopTimer: NodeJS.Timeout | undefined;
        let timer: NodeJS.Timeout | undefined;
        const settle = (error?: Error, result?: ProcessResult) => {
            if (settled) return;
            settled = true;
            if (timer !== undefined) clearTimeout(timer);
            if (stopTimer !== undefined) clearTimeout(stopTimer);
            if (error !== undefined) reject(error);
            else resolve(result!);
        };
        const fail = (error: Error) => {
            if (failure !== undefined) return;
            failure = error;
            child.kill("SIGKILL");
            stopTimer = setTimeout(() => {
                child.kill("SIGKILL");
                settle(error);
            }, PROCESS_STOP_TIMEOUT_MS);
            stopTimer.unref();
        };
        const collect = (
            target: Buffer[],
            chunk: Buffer,
            isStdout: boolean,
        ) => {
            if (!capture || failure !== undefined) return;
            if (isStdout) stdoutBytes += chunk.length;
            else stderrBytes += chunk.length;
            if (
                stdoutBytes > PROCESS_OUTPUT_LIMIT ||
                stderrBytes > PROCESS_OUTPUT_LIMIT
            ) {
                fail(new Error("process output limit"));
                return;
            }
            target.push(chunk);
        };
        child.stdout!.on("data", (value: Buffer | string) =>
            collect(
                stdout,
                Buffer.isBuffer(value) ? value : Buffer.from(value),
                true,
            ),
        );
        child.stderr!.on("data", (value: Buffer | string) =>
            collect(
                stderr,
                Buffer.isBuffer(value) ? value : Buffer.from(value),
                false,
            ),
        );
        child.once("error", (error) => settle(error));
        child.stdin?.once("error", fail);
        timer = setTimeout(
            () => fail(new Error("process timeout")),
            options.timeout ?? PROCESS_TIMEOUT_MS,
        );
        timer.unref();
        child.once("close", (code) => {
            if (failure !== undefined) {
                settle(failure);
                return;
            }
            settle(undefined, {
                code,
                stdout: Buffer.concat(stdout),
                stderr: Buffer.concat(stderr),
            });
        });
        if (options.input !== undefined) child.stdin?.end(options.input);
    });
}
function combinedOutput(result: ProcessResult): string {
    return `${result.stdout.toString("utf8")}\n${result.stderr.toString("utf8")}`.trim();
}
async function getPythonVersion(
    executable: string,
): Promise<string | undefined> {
    try {
        const result = await runProcess(executable, ["--version"]);
        if (result.code !== 0) return undefined;
        const match = /^Python\s+(\d+)\.(\d+)(?:\.(\d+))?/m.exec(
            combinedOutput(result),
        );
        if (!match) return undefined;
        const major = Number(match[1]);
        const minor = Number(match[2]);
        if (major !== PYTHON_VERSION[0] || minor !== PYTHON_VERSION[1]) {
            return `unsupported:${match[0].replace(/^Python\s+/, "")}`;
        }
        return match[0].replace(/^Python\s+/, "");
    } catch {
        return undefined;
    }
}
async function getTirithVersion(
    executable: string,
): Promise<string | undefined> {
    try {
        const result = await runProcess(executable, ["--version"]);
        if (result.code !== 0) return undefined;
        const match = /(?:^|\s)tirith\s+(\d+\.\d+\.\d+)(?:\s|$)/i.exec(
            combinedOutput(result),
        );
        return match?.[1];
    } catch {
        return undefined;
    }
}
async function hasPinnedPythonPackages(executable: string): Promise<boolean> {
    const script = [
        "import importlib.metadata,json,sys",
        "n=json.loads(sys.argv[1])",
        'print(json.dumps({"packages":{x:importlib.metadata.version(x) for x in n}}))',
    ].join(";");
    try {
        const result = await runProcess(executable, [
            "-c",
            script,
            JSON.stringify(PINNED_PACKAGES.map(({ name }) => name)),
        ]);
        if (result.code !== 0) return false;
        const value: unknown = JSON.parse(result.stdout.toString("utf8"));
        if (!isRecord(value) || !isRecord(value.packages)) {
            return false;
        }
        const packages = value.packages;
        return PINNED_PACKAGES.every(
            ({ name, version }) => packages[name] === version,
        );
    } catch {
        return false;
    }
}
function atomicWriteJson(file: string, value: unknown): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
    const descriptor = fs.openSync(temporary, "wx", 0o600);
    try {
        fs.writeFileSync(
            descriptor,
            `${JSON.stringify(value, undefined, 2)}\n`,
        );
        fs.fsyncSync(descriptor);
    } finally {
        fs.closeSync(descriptor);
    }
    try {
        fs.renameSync(temporary, file);
    } catch (error) {
        fs.rmSync(temporary, { force: true });
        throw error;
    }
}
function recordFailure(reason: string): void {
    try {
        atomicWriteJson(path.join(privacyRoot(), LAST_FAILURE_FILE), {
            schemaVersion: LAST_FAILURE_SCHEMA_VERSION,
            reason,
        });
    } catch {
        // The setup error remains actionable even if diagnostic state cannot be written.
    }
}
function readLastFailure(): string | undefined {
    try {
        const value: unknown = JSON.parse(
            fs.readFileSync(
                path.join(privacyRoot(), LAST_FAILURE_FILE),
                "utf8",
            ),
        );
        if (
            isRecord(value) &&
            value.schemaVersion === LAST_FAILURE_SCHEMA_VERSION &&
            typeof value.reason === "string"
        ) {
            return value.reason;
        }
    } catch {
        // A missing or corrupt diagnostic does not change readiness.
    }
    return undefined;
}
export async function validatePrivacyReadyManifest(): Promise<PrivacyReadyValidation> {
    const manifest = readPrivacyReadyManifest();
    if (!manifest) {
        return {
            ready: false,
            reason: readLastFailure() ?? "setup has not completed",
        };
    }
    for (const file of [
        manifest.pythonPath,
        manifest.workerPath,
        manifest.tirithPath,
    ]) {
        try {
            if (!fs.statSync(file).isFile()) throw new Error("not a file");
        } catch {
            return {
                ready: false,
                reason: "an installed executable is missing",
            };
        }
    }
    try {
        const installedWorker = fs.readFileSync(manifest.workerPath);
        const sourceWorker = fs.readFileSync(assetPath("glinerWorker.py"));
        if (!installedWorker.equals(sourceWorker)) {
            return { ready: false, reason: "the installed worker is invalid" };
        }
    } catch {
        return { ready: false, reason: "the installed worker is unavailable" };
    }
    const pythonVersion = await getPythonVersion(manifest.pythonPath);
    if (!pythonVersion || pythonVersion.startsWith("unsupported:")) {
        return { ready: false, reason: "the installed Python is unavailable" };
    }
    if (pythonVersion !== manifest.pythonVersion) {
        return { ready: false, reason: "the installed Python version changed" };
    }
    if (!(await hasPinnedPythonPackages(manifest.pythonPath))) {
        return {
            ready: false,
            reason: "the installed Python packages are invalid",
        };
    }
    const tirithVersion = await getTirithVersion(manifest.tirithPath);
    if (tirithVersion !== TIRITH_VERSION) {
        return { ready: false, reason: `Tirith ${TIRITH_VERSION} is required` };
    }
    try {
        const digest = await hashFile(manifest.tirithPath);
        if (digest.sha256 !== manifest.tirithSha256) {
            return { ready: false, reason: "the Tirith executable changed" };
        }
    } catch {
        return { ready: false, reason: "the Tirith executable is unavailable" };
    }
    let modelManifest: ModelManifest;
    try {
        modelManifest = loadModelManifest();
    } catch (error) {
        return {
            ready: false,
            reason:
                error instanceof PrivacySetupError
                    ? error.message
                    : "the model manifest is invalid",
        };
    }
    const invalidFile = await verifyModelFiles(
        manifest.modelPath,
        modelManifest,
    );
    if (invalidFile) {
        return {
            ready: false,
            reason: `model file verification failed: ${invalidFile}`,
        };
    }
    try {
        await probeWorker(
            manifest.pythonPath,
            manifest.workerPath,
            manifest.modelPath,
        );
        await probeTirith(manifest.tirithPath);
    } catch (error) {
        return {
            ready: false,
            reason:
                error instanceof PrivacySetupError
                    ? error.message
                    : "the installed privacy filter probe failed",
        };
    }
    return { ready: true, manifest };
}
async function downloadModelFile(
    destinationRoot: string,
    entry: ModelFileManifest,
): Promise<void> {
    const destination = path.join(destinationRoot, entry.path);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    const encodedPath = entry.path.split("/").map(encodeURIComponent).join("/");
    let response: Response;
    try {
        response = await fetch(`${MODEL_DOWNLOAD_BASE}/${encodedPath}`, {
            redirect: "follow",
            signal: AbortSignal.timeout(MODEL_DOWNLOAD_TIMEOUT_MS),
        });
    } catch {
        throw new PrivacySetupError(
            `Failed to download model file: ${entry.path}.`,
        );
    }
    if (!response.ok || !response.body) {
        await response.body?.cancel().catch(() => undefined);
        throw new PrivacySetupError(
            `Failed to download model file: ${entry.path}.`,
        );
    }
    const descriptor = fs.openSync(destination, "wx", 0o600);
    const reader = response.body.getReader();
    const hash = crypto.createHash("sha256");
    let size = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const chunk = Buffer.from(value);
            size += chunk.length;
            if (size > entry.size) {
                throw new Error("download too large");
            }
            hash.update(chunk);
            let offset = 0;
            while (offset < chunk.length) {
                offset += fs.writeSync(
                    descriptor,
                    chunk,
                    offset,
                    chunk.length - offset,
                );
            }
        }
        fs.fsyncSync(descriptor);
    } catch {
        try {
            await reader.cancel();
        } catch {
            // The sanitized download failure remains the user-facing error.
        }
        fs.closeSync(descriptor);
        fs.rmSync(destination, { force: true });
        throw new PrivacySetupError(
            `Failed to download model file: ${entry.path}.`,
        );
    }
    fs.closeSync(descriptor);
    if (size !== entry.size || hash.digest("hex") !== entry.sha256) {
        fs.rmSync(destination, { force: true });
        throw new PrivacySetupError(
            `Model file verification failed: ${entry.path}.`,
        );
    }
}
function encodeFrame(value: unknown): Buffer {
    const payload = Buffer.from(JSON.stringify(value), "utf8");
    if (payload.length > WORKER_FRAME_LIMIT) throw new Error("frame too large");
    const header = Buffer.allocUnsafe(4);
    header.writeUInt32BE(payload.length);
    return Buffer.concat([header, payload]);
}
function decodeFrames(data: Buffer): unknown[] {
    const frames: unknown[] = [];
    let offset = 0;
    while (offset < data.length) {
        if (data.length - offset < 4) throw new Error("incomplete frame");
        const length = data.readUInt32BE(offset);
        offset += 4;
        if (length > WORKER_FRAME_LIMIT || data.length - offset < length) {
            throw new Error("invalid frame");
        }
        frames.push(
            JSON.parse(data.subarray(offset, offset + length).toString("utf8")),
        );
        offset += length;
    }
    return frames;
}
async function probeWorker(
    pythonPath: string,
    workerPath: string,
    modelPath: string,
): Promise<void> {
    const probeText = "Contact Ada Example at ada.example@example.invalid.";
    const request = encodeFrame({
        protocol: 1,
        type: "redact",
        id: 1,
        text: probeText,
        labels: GLINER_LABELS,
        threshold: GLINER_THRESHOLD,
    });
    let result: ProcessResult;
    try {
        result = await runProcess(
            pythonPath,
            [workerPath, "--model", modelPath],
            {
                input: request,
                timeout: WORKER_PROBE_TIMEOUT_MS,
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
    } catch {
        throw new PrivacySetupError(
            "The pinned GLiNER2 model is incompatible with the pinned runtime.",
        );
    }
    if (result.code !== 0) {
        throw new PrivacySetupError(
            "The pinned GLiNER2 model is incompatible with the pinned runtime.",
        );
    }
    try {
        const frames = decodeFrames(result.stdout);
        const ready = frames[0];
        const response = frames[1];
        if (
            frames.length !== 2 ||
            !isRecord(ready) ||
            ready.protocol !== 1 ||
            ready.type !== "ready" ||
            ready.glinerVersion !== GLINER2_VERSION ||
            ready.transformersVersion !== TRANSFORMERS_VERSION ||
            ready.modelRevision !== MODEL_REVISION ||
            ready.threshold !== GLINER_THRESHOLD ||
            !isRecord(response) ||
            response.protocol !== 1 ||
            response.type !== "result" ||
            response.id !== 1 ||
            !Array.isArray(response.spans) ||
            !response.spans.some(
                (span) => isRecord(span) && span.label === "email",
            )
        ) {
            throw new Error("probe failed");
        }
    } catch {
        throw new PrivacySetupError(
            "The pinned GLiNER2 model is incompatible with the pinned runtime.",
        );
    }
}
async function probeTirith(tirithPath: string): Promise<void> {
    const secret = `ghp_${"A".repeat(36)}`;
    const input = `token=${secret}\n`;
    let result: ProcessResult;
    try {
        result = await runProcess(
            tirithPath,
            ["redact", "--audience", "public-paste", "--json"],
            {
                input,
                timeout: TIRITH_PROBE_TIMEOUT_MS,
                env: childEnvironment({
                    TIRITH_LOG: "0",
                    TIRITH_OFFLINE: "1",
                }),
            },
        );
    } catch {
        throw new PrivacySetupError("The Tirith redaction probe failed.");
    }
    if (result.code !== 0) {
        throw new PrivacySetupError("The Tirith redaction probe failed.");
    }
    try {
        const output: unknown = JSON.parse(result.stdout.toString("utf8"));
        if (
            !isRecord(output) ||
            typeof output.redacted_content !== "string" ||
            !Array.isArray(output.redactions) ||
            output.redacted_content.includes(secret) ||
            output.redacted_content === input
        ) {
            throw new Error("probe failed");
        }
    } catch {
        throw new PrivacySetupError("The Tirith redaction probe failed.");
    }
}
export async function setupPrivacy(
    options: PrivacySetupOptions,
): Promise<PrivacySetupResult> {
    const platform = `${process.platform}:${process.arch}`;
    const macosMajorVersion = Number.parseInt(os.release().split(".")[0], 10);
    if (
        platform !== SUPPORTED_PLATFORM ||
        !Number.isInteger(macosMajorVersion) ||
        macosMajorVersion < MINIMUM_MACOS_MAJOR_VERSION
    ) {
        throw new PrivacySetupError(
            "Privacy setup requires macOS 14 or later on Apple silicon.",
        );
    }
    fs.mkdirSync(privacyRoot(), { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") fs.chmodSync(privacyRoot(), 0o700);
    const setupLock = await acquireSetupLock();
    try {
        cleanIncompleteGenerations();
        return await setupPrivacyLocked(options);
    } finally {
        await setupLock.release();
    }
}

async function setupPrivacyLocked(
    options: PrivacySetupOptions,
): Promise<PrivacySetupResult> {
    const current = await validatePrivacyReadyManifest();
    if (current.ready) {
        return { alreadyReady: true, manifest: current.manifest };
    }
    fs.mkdirSync(privacyRoot(), { recursive: true, mode: 0o700 });
    fs.mkdirSync(path.join(privacyRoot(), GENERATIONS_DIR), {
        recursive: true,
        mode: 0o700,
    });
    if (process.platform !== "win32") {
        fs.chmodSync(privacyRoot(), 0o700);
        fs.chmodSync(path.join(privacyRoot(), GENERATIONS_DIR), 0o700);
    }
    const pythonCommand =
        options.python ?? (process.platform === "win32" ? "python" : "python3");
    const tirithCommand = options.tirith ?? "tirith";
    let pythonPath: string;
    let tirithPath: string;
    try {
        pythonPath = resolveExecutable(pythonCommand, "Python");
        tirithPath = resolveExecutable(tirithCommand, "Tirith");
    } catch (error) {
        const setupError =
            error instanceof PrivacySetupError
                ? error
                : new PrivacySetupError("Privacy setup failed.");
        recordFailure(setupError.message);
        throw setupError;
    }
    const pythonVersion = await getPythonVersion(pythonPath);
    if (!pythonVersion) {
        const error = new PrivacySetupError(
            "Unable to read the Python version.",
        );
        recordFailure(error.message);
        throw error;
    }
    if (pythonVersion.startsWith("unsupported:")) {
        const found = pythonVersion.slice("unsupported:".length);
        const error = new PrivacySetupError(
            `Python 3.11.x is required (found ${found}).`,
        );
        recordFailure(error.message);
        throw error;
    }
    const tirithVersion = await getTirithVersion(tirithPath);
    if (tirithVersion !== TIRITH_VERSION) {
        const found = tirithVersion ?? "unknown";
        const message = `Tirith ${TIRITH_VERSION} is required (found ${found}). Tirith is AGPL-3.0-only or commercially licensed; install or license it separately and rerun with --tirith <path>.`;
        recordFailure(message);
        throw new PrivacySetupError(message);
    }
    process.stderr.write(
        "Tirith is AGPL-3.0-only or commercially licensed. Review its license before continuing; git-story does not install Tirith.\n",
    );
    let modelManifest: ModelManifest;
    let requirementsPath: string;
    try {
        requirementsPath = requirementAsset();
        modelManifest = loadModelManifest();
    } catch (error) {
        const setupError =
            error instanceof PrivacySetupError
                ? error
                : new PrivacySetupError("Privacy setup assets are invalid.");
        recordFailure(setupError.message);
        throw setupError;
    }
    const nonce = crypto.randomBytes(8).toString("hex");
    const generation = `${Date.now()}-${process.pid}-${nonce}`;
    const generationPath = path.join(
        privacyRoot(),
        GENERATIONS_DIR,
        generation,
    );
    try {
        fs.mkdirSync(generationPath, { recursive: false, mode: 0o700 });
        fs.writeFileSync(path.join(generationPath, INSTALLING_FILE), "", {
            flag: "wx",
            mode: 0o600,
        });
        const generationVenv = path.join(generationPath, "venv");
        const createVenv = await runProcess(
            pythonPath,
            ["-m", "venv", generationVenv],
            { timeout: INSTALL_TIMEOUT_MS, capture: false },
        );
        if (createVenv.code !== 0) {
            throw new PrivacySetupError(
                "Failed to create the Python environment.",
            );
        }
        const generationPython = venvPython(generationVenv);
        const install = await runProcess(
            generationPython,
            [
                "-m",
                "pip",
                "install",
                "--disable-pip-version-check",
                "--no-input",
                "--require-hashes",
                "--only-binary=:all:",
                "-r",
                requirementsPath,
            ],
            {
                timeout: INSTALL_TIMEOUT_MS,
                capture: false,
                env: childEnvironment({ PIP_NO_INPUT: "1" }),
            },
        );
        if (install.code !== 0) {
            throw new PrivacySetupError(
                "Failed to install the pinned GLiNER2 runtime.",
            );
        }
        const generationModel = path.join(generationPath, "model");
        fs.mkdirSync(generationModel, { recursive: false, mode: 0o700 });
        for (const entry of modelManifest.files) {
            await downloadModelFile(generationModel, entry);
        }
        const invalidFile = await verifyModelFiles(
            generationModel,
            modelManifest,
        );
        if (invalidFile) {
            throw new PrivacySetupError(
                `Model file verification failed: ${invalidFile}.`,
            );
        }
        const generationWorker = path.join(generationPath, "glinerWorker.py");
        fs.copyFileSync(
            assetPath("glinerWorker.py"),
            generationWorker,
            fs.constants.COPYFILE_EXCL,
        );
        fs.chmodSync(generationWorker, 0o600);
        await probeWorker(generationPython, generationWorker, generationModel);
        await probeTirith(tirithPath);
        const tirithSha256 = (await hashFile(tirithPath)).sha256;
        const manifest: PrivacyReadyManifest = {
            schemaVersion: READY_SCHEMA_VERSION,
            generation,
            pythonPath: venvPython(path.join(generationPath, "venv")),
            workerPath: path.join(generationPath, "glinerWorker.py"),
            modelPath: path.join(generationPath, "model"),
            tirithPath,
            tirithSha256,
            pythonVersion,
            tirithVersion: TIRITH_VERSION,
            gliner2Version: GLINER2_VERSION,
            gliner2Revision: GLINER2_REVISION,
            transformersVersion: TRANSFORMERS_VERSION,
            modelRepository: MODEL_REPOSITORY,
            modelRevision: MODEL_REVISION,
            installedAt: new Date().toISOString(),
        };
        fs.rmSync(path.join(generationPath, INSTALLING_FILE));
        atomicWriteJson(readyPath(), manifest);
        try {
            cleanOldGenerations(generation);
            fs.rmSync(path.join(privacyRoot(), LAST_FAILURE_FILE), {
                force: true,
            });
        } catch {
            // Published setup stays usable when optional cleanup fails.
        }
        return { alreadyReady: false, manifest };
    } catch (error) {
        fs.rmSync(generationPath, { recursive: true, force: true });
        const setupError =
            error instanceof PrivacySetupError
                ? error
                : new PrivacySetupError("Privacy setup failed.");
        recordFailure(setupError.message);
        throw setupError;
    }
}
