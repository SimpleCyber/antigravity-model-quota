/**
 * Antigravity Status Bar Monitor — Process Detector (Windows)
 *
 * Detects the running Antigravity language_server process,
 * extracts connection parameters (port + CSRF token), and
 * verifies the connection via HTTPS ping.
 *
 * Supports both Antigravity 2.0 (agy.exe) and legacy language_server processes.
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import * as https from 'https';

const execAsync = promisify(exec);

/** Connection parameters extracted from the Antigravity process */
export interface AntigravityConnection {
    port: number;
    csrfToken: string;
}

/** Process candidate found during scanning */
interface ProcessCandidate {
    pid: number;
    extensionPort: number;
    csrfToken: string;
    commandLine?: string;
}

// ── Constants ─────────────────────────────────────────

const TARGET_PROCESS_FILTER = "name=''agy.exe'' OR name=''language_server_windows_x64.exe'' OR name=''language_server.exe''";
const API_ENDPOINT = '/exa.language_server_pb.LanguageServerService/GetUnleashData';
const PROCESS_CMD_TIMEOUT_MS = 15_000;
const HTTPS_TIMEOUT_MS = 5_000;

// ── Public API ────────────────────────────────────────

/**
 * Scan for a running Antigravity language server process (Windows only).
 *
 * @param log  Optional logging callback for diagnostic messages.
 * @returns    Connection info or `null` if the process is not found.
 */
export async function detectAntigravityProcess(
    log?: (msg: string) => void,
): Promise<AntigravityConnection | null> {
    const info = log ?? (() => {});

    // Phase 1: Search by process name
    const result = await scanByProcessName(info);
    if (result) {
        return result;
    }

    // Phase 2: Keyword fallback (search for csrf_token in all processes)
    info('[ProcessDetector] Process name search failed, trying keyword search...');
    const fallback = await scanByKeyword(info);
    if (fallback) {
        return fallback;
    }

    info('[ProcessDetector] No Antigravity process found.');
    return null;
}

// ── Internals ─────────────────────────────────────────

/**
 * Check if a command line belongs to an Antigravity process.
 * Must match:
 *  1. --csrf_token
 *  2. --app_data_dir antigravity (with = or whitespace) OR --hub-port / --extension_server_port
 */
function isAntigravityProcess(commandLine: string): boolean {
    const hasCsrf = /--csrf_token[=\s]+/i.test(commandLine);
    const hasAppDataDir = /--app_data_dir[=\s]+["']?antigravity\b/i.test(commandLine);
    const hasPortOrHub = /--(?:extension_server_port|hub[-_]port|hub)\b/i.test(commandLine);
    return hasCsrf && (hasAppDataDir || hasPortOrHub);
}

/**
 * Parse PowerShell JSON output into process candidates.
 */
function parseCandidates(stdout: string, log: (m: string) => void): ProcessCandidate[] {
    try {
        // Strip any non-JSON preamble (e.g. from chcp)
        const jsonStart = stdout.indexOf('[');
        const jsonObjStart = stdout.indexOf('{');
        let clean = stdout;
        if (jsonStart >= 0 || jsonObjStart >= 0) {
            const start =
                jsonStart >= 0 && jsonObjStart >= 0
                    ? Math.min(jsonStart, jsonObjStart)
                    : Math.max(jsonStart, jsonObjStart);
            clean = stdout.substring(start);
        }

        let data = JSON.parse(clean.trim());
        if (!Array.isArray(data)) {
            data = [data];
        }

        const candidates: ProcessCandidate[] = [];
        for (const item of data) {
            const cmdLine: string = item.CommandLine || '';
            if (!cmdLine || !isAntigravityProcess(cmdLine)) {
                continue;
            }

            const pid = item.ProcessId;
            if (!pid) {
                continue;
            }

            const portMatch = cmdLine.match(/--(?:extension_server_port|hub[-_]port)[=\s]+(\d+)/i);
            const tokenMatch = cmdLine.match(/--csrf_token[=\s]+([a-f0-9-]+)/i);
            if (!tokenMatch?.[1]) {
                log(`[ProcessDetector] Cannot extract CSRF token from PID ${pid}`);
                continue;
            }

            candidates.push({
                pid,
                extensionPort: portMatch?.[1] ? parseInt(portMatch[1], 10) : 0,
                csrfToken: tokenMatch[1],
                commandLine: cmdLine,
            });
        }

        return candidates;
    } catch {
        return [];
    }
}

/**
 * Scan by process name using PowerShell + Get-CimInstance.
 */
async function scanByProcessName(log: (m: string) => void): Promise<AntigravityConnection | null> {
    const maxAttempts = 3;

    for (let i = 0; i < maxAttempts; i++) {
        try {
            const utf8 = '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ';
            const cmd = `chcp 65001 >nul && powershell -NoProfile -Command "${utf8}Get-CimInstance Win32_Process -Filter '${TARGET_PROCESS_FILTER}' | Select-Object ProcessId,CommandLine | ConvertTo-Json"`;

            const { stdout } = await execAsync(cmd, { timeout: PROCESS_CMD_TIMEOUT_MS });
            if (!stdout?.trim()) {
                continue;
            }

            const candidates = parseCandidates(stdout, log);
            log(`[ProcessDetector] Found ${candidates.length} Antigravity process(es)`);

            for (const c of candidates) {
                const conn = await verifyAndConnect(c, log);
                if (conn) {
                    return conn;
                }
            }
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            log(`[ProcessDetector] Attempt ${i + 1} failed: ${msg}`);
        }
    }
    return null;
}

/**
 * Keyword-based fallback: find any process with csrf_token in its command line.
 */
async function scanByKeyword(log: (m: string) => void): Promise<AntigravityConnection | null> {
    try {
        const utf8 = '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ';
        const cmd = `chcp 65001 >nul && powershell -NoProfile -Command "${utf8}Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'csrf_token' } | Select-Object ProcessId,Name,CommandLine | ConvertTo-Json"`;

        const { stdout } = await execAsync(cmd, { timeout: PROCESS_CMD_TIMEOUT_MS });
        if (!stdout?.trim()) {
            return null;
        }

        const candidates = parseCandidates(stdout, log);
        for (const c of candidates) {
            const conn = await verifyAndConnect(c, log);
            if (conn) {
                return conn;
            }
        }
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        log(`[ProcessDetector] Keyword search failed: ${msg}`);
    }
    return null;
}

/**
 * Given a candidate, find its listening ports and verify one works.
 * Tries direct port hints first (e.g. hubPort + 2 for agy, or extensionPort for legacy)
 * before querying all listening ports from the OS.
 */
async function verifyAndConnect(
    candidate: ProcessCandidate,
    log: (m: string) => void,
): Promise<AntigravityConnection | null> {
    // 1. Fast path: probe hinted port offsets directly without querying OS network tables
    if (candidate.extensionPort > 0) {
        // agy.exe uses hub-port (HTTP) and hub-port + 2 (HTTPS language server API)
        // legacy language_server uses extension_server_port directly
        const hintedPorts = [candidate.extensionPort + 3, candidate.extensionPort + 2, candidate.extensionPort + 1, candidate.extensionPort, candidate.extensionPort - 2];
        for (const port of hintedPorts) {
            if (port > 0 && port <= 65535) {
                const ok = await pingPort(port, candidate.csrfToken);
                if (ok) {
                    log(`[ProcessDetector] ✅ Fast-verified connection on port ${port}`);
                    return { port, csrfToken: candidate.csrfToken };
                }
            }
        }
    }

    // 2. Fallback: retrieve all listening ports for the PID
    const ports = await getListeningPorts(candidate.pid, log);
    if (ports.length === 0) {
        return null;
    }

    for (const port of ports) {
        const ok = await pingPort(port, candidate.csrfToken);
        if (ok) {
            log(`[ProcessDetector] ✅ Verified connection on port ${port}`);
            return { port, csrfToken: candidate.csrfToken };
        }
    }
    return null;
}

/**
 * Get listening TCP ports for a given PID.
 */
async function getListeningPorts(pid: number, log: (m: string) => void): Promise<number[]> {
    try {
        const utf8 = '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ';
        const cmd = `chcp 65001 >nul && powershell -NoProfile -NonInteractive -Command "${utf8}$ports = Get-NetTCPConnection -State Listen -OwningProcess ${pid} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty LocalPort; if ($ports) { $ports | Sort-Object -Unique }"`;

        const { stdout } = await execAsync(cmd, { timeout: PROCESS_CMD_TIMEOUT_MS });

        const ports = new Set<number>();
        const matches = stdout.match(/\b\d{1,5}\b/g) || [];
        for (const v of matches) {
            const p = parseInt(v, 10);
            if (p > 0 && p <= 65535) {
                ports.add(p);
            }
        }
        return Array.from(ports).sort((a, b) => a - b);
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        log(`[ProcessDetector] Port detection failed: ${msg}`);
        return [];
    }
}

/**
 * Verify a port by sending an HTTPS POST to the GetUnleashData endpoint.
 */
function pingPort(port: number, csrfToken: string): Promise<boolean> {
    return new Promise((resolve) => {
        const options: https.RequestOptions = {
            hostname: '127.0.0.1',
            port,
            path: API_ENDPOINT,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Codeium-Csrf-Token': csrfToken,
                'Connect-Protocol-Version': '1',
            },
            rejectUnauthorized: false,
            timeout: HTTPS_TIMEOUT_MS,
            agent: false,
        };

        const req = https.request(options, (res) => resolve(res.statusCode === 200));
        req.on('error', () => resolve(false));
        req.on('timeout', () => {
            req.destroy();
            resolve(false);
        });
        req.write(JSON.stringify({ wrapper_data: {} }));
        req.end();
    });
}
