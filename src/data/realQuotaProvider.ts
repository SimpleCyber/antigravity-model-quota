/**
 * Antigravity Status Bar Monitor — Real Quota Data Provider
 *
 * Connects to the local Antigravity language server process via HTTPS
 * and fetches actual model quota data through GetUserStatus and RetrieveUserQuotaSummary APIs.
 *
 * Falls back to a "not connected" state when the process is unavailable.
 */

import * as https from 'https';
import { ModelQuota, ModelFamily, QuotaDataProvider, ModelCapabilities, QuotaGroup } from './types';
import { formatTimeUntilReset, formatResetTime } from '../utils/formatting';
import { detectAntigravityProcess, AntigravityConnection } from './processDetector';

// ── API types (subset of Cockpit's shared/types.ts) ──

interface QuotaInfo {
    remainingFraction?: number;
    resetTime?: string;
}

interface ModelOrAlias {
    model: string;
}

interface ClientModelConfig {
    label: string;
    modelOrAlias?: ModelOrAlias;
    quotaInfo?: QuotaInfo;
    supportsImages?: boolean;
    isRecommended?: boolean;
    tagTitle?: string;
    supportedMimeTypes?: Record<string, boolean>;
}

interface ModelSortGroup {
    modelLabels: string[];
}

interface ClientModelSort {
    name: string;
    groups: ModelSortGroup[];
}

interface PlanInfo {
    monthlyPromptCredits?: number;
    monthlyFlowCredits?: number;
    [key: string]: unknown;
}

interface PlanStatus {
    planInfo?: PlanInfo;
    availablePromptCredits?: number;
    availableFlowCredits?: number;
}

interface UserStatus {
    name?: string;
    email?: string;
    planStatus?: PlanStatus;
    cascadeModelConfigData?: {
        clientModelConfigs: ClientModelConfig[];
        clientModelSorts?: ClientModelSort[];
    };
}

interface ServerUserStatusResponse {
    userStatus: UserStatus;
    message?: string;
}

interface ServerQuotaSummaryBucket {
    bucketId: string;
    displayName: string;
    description?: string;
    window: string;
    remainingFraction: number;
    resetTime: string;
}

interface ServerQuotaSummaryGroup {
    displayName: string;
    description?: string;
    buckets: ServerQuotaSummaryBucket[];
}

interface ServerQuotaSummaryResponse {
    response?: {
        groups?: ServerQuotaSummaryGroup[];
        description?: string;
    };
}

// ── Provider ──────────────────────────────────────────

const GET_USER_STATUS = '/exa.language_server_pb.LanguageServerService/GetUserStatus';
const RETRIEVE_USER_QUOTA_SUMMARY = '/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary';
const HTTPS_TIMEOUT_MS = 10_000;

/**
 * Resolves the model family based on the model label and id.
 */
function resolveFamily(label: string, modelId: string): { family: ModelFamily; familyLabel: string } {
    const lower = (label + ' ' + modelId).toLowerCase();
    if (lower.includes('claude') || lower.includes('sonnet') || lower.includes('opus')) {
        return { family: 'claude', familyLabel: 'Claude' };
    }
    if (lower.includes('gemini') || lower.includes('argon')) {
        return { family: 'gemini', familyLabel: 'Gemini' };
    }
    if (lower.includes('gpt') || lower.includes('openai') || lower.includes('o3') || lower.includes('o4')) {
        return { family: 'gpt', familyLabel: 'GPT / OpenAI' };
    }
    return { family: 'other', familyLabel: 'Other' };
}

/**
 * Build a concise short label from the full model label for status bar display.
 */
function buildShortLabel(label: string): string {
    let short = label.trim();
    short = short.replace(/^Claude\s+/i, '');
    short = short.replace(/^Gemini\s+3\.8\s+/i, 'Gemini ');
    short = short.replace(/\(Thinking\)/i, '(Think)');
    short = short.replace(/\(Medium\)/i, '(Med)');
    return short.trim();
}

/**
 * Infer capabilities from model metadata.
 */
function inferCapabilities(config: ClientModelConfig): ModelCapabilities {
    const mimeTypes = config.supportedMimeTypes ?? {};
    const hasImage = config.supportsImages === true || Object.keys(mimeTypes).some(k => k.startsWith('image/'));
    const hasVideo = Object.keys(mimeTypes).some(k => k.startsWith('video/'));
    const label = config.label.toLowerCase();
    const hasThinking = label.includes('thinking');
    return {
        text: true,
        image: hasImage,
        video: hasVideo,
        thinking: hasThinking,
        code: true,
    };
}

/**
 * Real data provider that connects to the local Antigravity language server.
 */
export class RealQuotaProvider implements QuotaDataProvider {
    private connection: AntigravityConnection | null = null;
    private lastCredits: number = 0;
    private logFn: (msg: string) => void;

    constructor(log?: (msg: string) => void) {
        this.logFn = log ?? (() => {});
    }

    /**
     * Whether the provider is currently connected to the Antigravity process.
     */
    get isConnected(): boolean {
        return this.connection !== null;
    }

    /**
     * Attempt to (re)connect to the Antigravity language server process.
     */
    async connect(): Promise<boolean> {
        this.connection = await detectAntigravityProcess(this.logFn);
        return this.connection !== null;
    }

    /**
     * Disconnect (reset state).
     */
    disconnect(): void {
        this.connection = null;
    }

    /**
     * Fetch all model quotas from the running Antigravity process.
     */
    async fetchQuota(): Promise<ModelQuota[]> {
        if (!this.connection) {
            const connected = await this.connect();
            if (!connected) {
                return [];
            }
        }

        try {
            const response = await this.transmit<ServerUserStatusResponse>(
                this.connection!.port,
                this.connection!.csrfToken,
                GET_USER_STATUS,
                {
                    metadata: {
                        ideName: 'antigravity',
                        extensionName: 'antigravity',
                        locale: 'en',
                    },
                },
            );

            return this.parseResponse(response);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            this.logFn(`[RealQuotaProvider] Fetch failed: ${msg}`);
            this.connection = null;
            return [];
        }
    }

    /**
     * Fetch quota pool limits (Weekly & 5-Hour Limits) from RetrieveUserQuotaSummary.
     */
    async fetchQuotaSummary(): Promise<QuotaGroup[]> {
        if (!this.connection) {
            const connected = await this.connect();
            if (!connected) {
                return [];
            }
        }

        try {
            const response = await this.transmit<ServerQuotaSummaryResponse>(
                this.connection!.port,
                this.connection!.csrfToken,
                RETRIEVE_USER_QUOTA_SUMMARY,
                {
                    metadata: {
                        ideName: 'antigravity',
                        extensionName: 'antigravity',
                        locale: 'en',
                    },
                },
            );

            return this.parseQuotaSummary(response);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            this.logFn(`[RealQuotaProvider] Fetch quota summary failed: ${msg}`);
            return [];
        }
    }

    /**
     * Get available credits from the most recent response.
     */
    async getCredits(): Promise<number> {
        return this.lastCredits;
    }

    // ── Internal helpers ──────────────────────────────

    /**
     * Parse ServerQuotaSummaryResponse into QuotaGroup[].
     */
    private parseQuotaSummary(data: ServerQuotaSummaryResponse): QuotaGroup[] {
        const groups = data?.response?.groups ?? [];
        const now = Date.now();

        return groups.map((g) => ({
            displayName: g.displayName,
            description: g.description,
            buckets: (g.buckets ?? []).map((b) => {
                let resetTime = b.resetTime ? new Date(b.resetTime) : new Date(now + 5 * 3600 * 1000);
                if (Number.isNaN(resetTime.getTime())) {
                    resetTime = new Date(now + 5 * 3600 * 1000);
                }
                const delta = Math.max(0, resetTime.getTime() - now);
                const pct = b.remainingFraction !== undefined ? b.remainingFraction * 100 : 0;

                return {
                    bucketId: b.bucketId,
                    displayName: b.displayName,
                    description: b.description,
                    window: b.window,
                    remainingPercentage: Math.round(pct * 100) / 100,
                    resetTime,
                    timeUntilResetFormatted: formatTimeUntilReset(delta),
                    resetTimeDisplay: formatResetTime(resetTime),
                };
            }),
        }));
    }

    /**
     * Parse the ServerUserStatusResponse into ModelQuota[].
     */
    private parseResponse(data: ServerUserStatusResponse): ModelQuota[] {
        if (!data?.userStatus) {
            if (data?.message) {
                this.logFn(`[RealQuotaProvider] Server error: ${data.message}`);
            }
            return [];
        }

        const status = data.userStatus;

        // Extract credits
        const available = status.planStatus?.availablePromptCredits;
        if (available !== undefined && Number.isFinite(available)) {
            this.lastCredits = Math.max(0, Number(available));
        }

        // Parse model configs
        const configs = status.cascadeModelConfigData?.clientModelConfigs ?? [];
        const modelSorts = status.cascadeModelConfigData?.clientModelSorts ?? [];

        // Build sort order from the server's recommended ordering
        const sortOrderMap = new Map<string, number>();
        if (modelSorts.length > 0) {
            let index = 0;
            for (const group of modelSorts[0].groups) {
                for (const label of group.modelLabels) {
                    sortOrderMap.set(label, index++);
                }
            }
        }

        const now = Date.now();

        const models: ModelQuota[] = configs
            .filter((m): m is ClientModelConfig & { quotaInfo: NonNullable<ClientModelConfig['quotaInfo']> } =>
                !!m.quotaInfo && m.quotaInfo.remainingFraction !== undefined,
            )
            .map((m) => {
                let resetTime = m.quotaInfo.resetTime ? new Date(m.quotaInfo.resetTime) : new Date(now + 24 * 60 * 60 * 1000);
                if (Number.isNaN(resetTime.getTime())) {
                    resetTime = new Date(now + 24 * 60 * 60 * 1000);
                }
                const delta = Math.max(0, resetTime.getTime() - now);

                const fraction = m.quotaInfo.remainingFraction;
                const pct = fraction !== undefined ? fraction * 100 : 0;

                const modelId = m.modelOrAlias?.model || m.label;
                const label = m.label || modelId;
                const { family, familyLabel } = resolveFamily(label, modelId);

                return {
                    id: modelId,
                    label,
                    shortLabel: buildShortLabel(label),
                    family,
                    familyLabel,
                    remainingPercentage: Math.round(pct * 100) / 100,
                    isExhausted: fraction === 0,
                    resetTime,
                    timeUntilReset: delta,
                    timeUntilResetFormatted: formatTimeUntilReset(delta),
                    resetTimeDisplay: formatResetTime(resetTime),
                    capabilities: inferCapabilities(m),
                    isPinned: false, // managed by StatusBarManager
                    tag: m.tagTitle,
                    isPremium: false,
                    supportsImages: m.supportsImages,
                    isRecommended: m.isRecommended,
                };
            });

        // Sort using server-provided order, then alphabetical fallback
        models.sort((a, b) => {
            const iA = sortOrderMap.get(a.label);
            const iB = sortOrderMap.get(b.label);
            if (iA !== undefined && iB !== undefined) { return iA - iB; }
            if (iA !== undefined) { return -1; }
            if (iB !== undefined) { return 1; }
            return a.label.localeCompare(b.label);
        });

        this.logFn(`[RealQuotaProvider] Parsed ${models.length} models`);
        return models;
    }

    /**
     * Send an HTTPS POST to the language server.
     */
    private transmit<T>(port: number, csrfToken: string, endpoint: string, payload: object): Promise<T> {
        return new Promise((resolve, reject) => {
            const body = JSON.stringify(payload);

            const opts: https.RequestOptions = {
                hostname: '127.0.0.1',
                port,
                path: endpoint,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(body),
                    'Connect-Protocol-Version': '1',
                    'X-Codeium-Csrf-Token': csrfToken,
                },
                rejectUnauthorized: false,
                timeout: HTTPS_TIMEOUT_MS,
                agent: false,
            };

            const req = https.request(opts, (res) => {
                let responseBody = '';
                res.on('data', (chunk) => (responseBody += chunk));
                res.on('end', () => {
                    if (!responseBody?.trim()) {
                        reject(new Error('Empty response from server'));
                        return;
                    }
                    try {
                        resolve(JSON.parse(responseBody) as T);
                    } catch {
                        reject(new Error('Failed to parse server response'));
                    }
                });
            });

            req.on('error', (e) => reject(new Error(`Connection failed: ${e.message}`)));
            req.on('timeout', () => {
                req.destroy();
                reject(new Error('Request timed out'));
            });

            req.write(body);
            req.end();
        });
    }
}
