// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const STATE_DIRECTORY = path.join(os.homedir(), ".typeagent", "git-story");
const STATE_FILE = "daemon.json";
const PRIVACY_ENDPOINT_PREFIX = "privacy-";
const PRIVACY_ENDPOINT_SUFFIX = ".sock";
const MAX_UNIX_SOCKET_PATH_BYTES = 103;
const UNIX_IPC_ROOT = "/tmp";
const IPC_DIRECTORY_PREFIX = "typeagent-git-story-";
const IPC_DIRECTORY_SUFFIX_LENGTH = 6;

export interface DaemonState {
    readonly pid: number;
    readonly port: number;
    readonly privacyEndpoint?: string;
}

export function daemonStateDirectory(): string {
    return STATE_DIRECTORY;
}

// The random endpoint cannot be claimed before the daemon publishes it.
export function createPrivacyEndpoint(): string {
    if (process.platform === "win32") {
        throw new Error("Private IPC is unavailable on Windows");
    }
    const token = crypto.randomBytes(16).toString("hex");
    const ipcDirectory = fs.mkdtempSync(
        path.join(UNIX_IPC_ROOT, IPC_DIRECTORY_PREFIX),
    );
    fs.chmodSync(ipcDirectory, 0o700);
    const endpoint = path.join(
        ipcDirectory,
        `${PRIVACY_ENDPOINT_PREFIX}${token}${PRIVACY_ENDPOINT_SUFFIX}`,
    );
    if (Buffer.byteLength(endpoint) > MAX_UNIX_SOCKET_PATH_BYTES) {
        fs.rmSync(ipcDirectory, { recursive: true, force: true });
        throw new Error("The temporary path is too long for private IPC");
    }
    return endpoint;
}

export function prepareDaemonStateDirectory(): void {
    fs.mkdirSync(daemonStateDirectory(), { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") {
        fs.chmodSync(daemonStateDirectory(), 0o700);
    }
}

export function readDaemonStateFile(): DaemonState | undefined {
    let value: unknown;
    try {
        value = JSON.parse(
            fs.readFileSync(
                path.join(daemonStateDirectory(), STATE_FILE),
                "utf8",
            ),
        );
    } catch {
        return undefined;
    }
    if (!isRecord(value)) return undefined;
    const { pid, port, privacyEndpoint } = value;
    if (
        !Number.isInteger(pid) ||
        !Number.isInteger(port) ||
        (privacyEndpoint !== undefined &&
            (typeof privacyEndpoint !== "string" ||
                !isExpectedPrivacyEndpoint(privacyEndpoint)))
    ) {
        return undefined;
    }
    return value as unknown as DaemonState;
}

export function writeDaemonStateFile(state: DaemonState): void {
    prepareDaemonStateDirectory();
    const file = path.join(daemonStateDirectory(), STATE_FILE);
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600 });
    if (process.platform !== "win32") fs.chmodSync(temporary, 0o600);
    fs.renameSync(temporary, file);
}

// Removes the state only while the same process still owns it.
export function removeDaemonStateIfOwned(pid: number): void {
    if (readDaemonStateFile()?.pid !== pid) return;
    fs.rmSync(path.join(daemonStateDirectory(), STATE_FILE), { force: true });
}

// Removes one endpoint created by this user. The caller holds the TCP port lock,
// so a prior daemon cannot still own the endpoint.
export function removePrivacyEndpoint(endpoint: string | undefined): void {
    if (
        process.platform === "win32" ||
        endpoint === undefined ||
        !isExpectedPrivacyEndpoint(endpoint)
    ) {
        return;
    }
    fs.rmSync(path.dirname(endpoint), { recursive: true, force: true });
}

function isExpectedPrivacyEndpoint(endpoint: string): boolean {
    if (process.platform === "win32") return false;
    const directory = path.basename(path.dirname(endpoint));
    return (
        path.dirname(path.dirname(endpoint)) === path.resolve(UNIX_IPC_ROOT) &&
        directory.length ===
            IPC_DIRECTORY_PREFIX.length + IPC_DIRECTORY_SUFFIX_LENGTH &&
        directory.startsWith(IPC_DIRECTORY_PREFIX) &&
        /^privacy-[a-f0-9]{32}[.]sock$/.test(path.basename(endpoint))
    );
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
