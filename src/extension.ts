/**
 * Antigravity Status Bar Monitor — Extension Entry Point
 * 
 * Activates on VS Code startup, creates the status bar monitor,
 * and sets up periodic quota data refreshes using real data from the Antigravity language server.
 */

import * as vscode from 'vscode';
import { StatusBarConfig, QuotaDataProvider } from './data/types';
import { RealQuotaProvider } from './data/realQuotaProvider';
import { StatusBarManager } from './statusBar/statusBarManager';
import { showDetailsQuickPick } from './commands/detailsCommand';
import { openQuotaWebviewPanel, updateQuotaWebviewIfOpen } from './commands/webviewDashboard';

// ── State ────────────────────────────────────────────
let statusBarManager: StatusBarManager;
let dataProvider: QuotaDataProvider;
let refreshTimer: ReturnType<typeof setInterval> | undefined;
let outputChannel: vscode.OutputChannel;
let extensionContext: vscode.ExtensionContext;

// ── Activity Tracking ─────────────────────────────────
let lastChangeTime = 0;
let changeBurstCount = 0;
let isGenerating = false;
let idleRefreshTimeout: NodeJS.Timeout | undefined;

/**
 * Extension activation.
 */
export async function activate(context: vscode.ExtensionContext): Promise<void> {
    extensionContext = context;
    outputChannel = vscode.window.createOutputChannel('Antigravity Status Bar');
    outputChannel.appendLine('🚀 Antigravity Status Bar Monitor activating...');

    // Load configuration
    const config = loadConfig(context);

    // Initialize data provider with logging
    dataProvider = new RealQuotaProvider((msg) => outputChannel.appendLine(msg));

    // Initialize status bar
    statusBarManager = new StatusBarManager(context, config);

    // ── Register Commands ────────────────────────────

    // Show Details (Usage QuickPick dashboard on click)
    context.subscriptions.push(
        vscode.commands.registerCommand('antigravity.showDetails', async () => {
            const models = statusBarManager.getLastModels();
            const currentConfig = statusBarManager.getConfig();

            if (!dataProvider.isConnected) {
                vscode.window.showWarningMessage('Connecting to Antigravity process...');
                await refreshQuota();
            }

            if (models.length === 0 && dataProvider.isConnected) {
                vscode.window.showInformationMessage('Refreshing model data...');
                await refreshQuota();
                return;
            }

            await showDetailsQuickPick(
                () => statusBarManager.getLastModels(),
                () => statusBarManager.getLastGroups(),
                currentConfig,
                async () => {
                    await refreshQuota();
                    statusBarManager.showTemporaryMessage('$(check) Quota Data Refreshed');
                },
                () => {
                    openQuotaWebviewPanel(
                        context,
                        () => statusBarManager.getLastGroups(),
                        async () => {
                            await refreshQuota();
                        }
                    );
                }
            );
        }),
    );

    // Open Webview Card Dashboard
    context.subscriptions.push(
        vscode.commands.registerCommand('antigravity.openDashboard', () => {
            openQuotaWebviewPanel(
                context,
                () => statusBarManager.getLastGroups(),
                async () => {
                    await refreshQuota();
                }
            );
        })
    );

    // Refresh command
    context.subscriptions.push(
        vscode.commands.registerCommand('antigravity.refreshQuota', async () => {
            statusBarManager.setLoading();
            await refreshQuota();
            statusBarManager.showTemporaryMessage('$(check) Quota Refreshed');
            outputChannel.appendLine('🔄 Manual refresh triggered');
        }),
    );

    // Open Flejet link
    context.subscriptions.push(
        vscode.commands.registerCommand('antigravity.openFlejet', () => {
            vscode.env.openExternal(vscode.Uri.parse('https://flejet.in'));
        })
    );

    // Open GitHub repository link
    context.subscriptions.push(
        vscode.commands.registerCommand('antigravity.openGitHub', () => {
            vscode.env.openExternal(vscode.Uri.parse('https://github.com/SimpleCyber/antigravity-model-quota'));
        })
    );

    // ── Listen for document changes (Intelligent Polling) ────
    context.subscriptions.push(
        vscode.workspace.onDidChangeTextDocument(handleDocumentChange)
    );

    // ── Listen for config changes ────────────────────
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration('agStatusBar')) {
                const newConfig = loadConfig(context);
                statusBarManager.updateConfig(newConfig);
                restartRefreshTimer(newConfig.refreshInterval);
                outputChannel.appendLine('⚙️ Configuration updated');
            }
        }),
    );

    // ── Initial data fetch ───────────────────────────
    statusBarManager.setLoading();
    await refreshQuota();

    // ── Start periodic refresh ───────────────────────
    startRefreshTimer(config.refreshInterval);

    outputChannel.appendLine(`✅ Antigravity Status Bar Monitor active (refresh every ${config.refreshInterval}s)`);
}

/**
 * Extension deactivation.
 */
export function deactivate(): void {
    if (refreshTimer) {
        clearInterval(refreshTimer);
        refreshTimer = undefined;
    }
    if (idleRefreshTimeout) {
        clearTimeout(idleRefreshTimeout);
        idleRefreshTimeout = undefined;
    }
    dataProvider?.disconnect();
    outputChannel?.appendLine('Antigravity Status Bar Monitor deactivated');
    outputChannel?.dispose();
}

// ── Internal helpers ─────────────────────────────────

/**
 * Detect AI generation activity by observing rapid or large document changes.
 * Debounces a quota refresh after the activity stops.
 */
function handleDocumentChange(e: vscode.TextDocumentChangeEvent): void {
    if (e.contentChanges.length === 0) return;
    if (!e.document || (e.document.uri.scheme !== 'file' && e.document.uri.scheme !== 'untitled')) return;
    
    const now = Date.now();
    const timeSinceLastChange = now - lastChangeTime;
    
    if (timeSinceLastChange < 500) {
        changeBurstCount++;
    } else {
        changeBurstCount = 1;
    }
    lastChangeTime = now;

    // AI agents often apply large changes or rapid bursts of changes
    const isLargeChange = e.contentChanges.some(c => c.text.length > 50 || c.rangeLength > 50);
    
    if (changeBurstCount > 5 || isLargeChange) {
        isGenerating = true;
    }

    if (isGenerating) {
        if (idleRefreshTimeout) {
            clearTimeout(idleRefreshTimeout);
        }
        
        idleRefreshTimeout = setTimeout(async () => {
            isGenerating = false;
            changeBurstCount = 0;
            outputChannel.appendLine('🤖 AI Activity stopped. Auto-refreshing quota...');
            statusBarManager.setLoading();
            await refreshQuota();
            statusBarManager.showTemporaryMessage('$(check) Auto Refreshed');
        }, 2000);
    }
}

/**
 * Fetch quota data and update the status bar.
 */
async function refreshQuota(): Promise<void> {
    try {
        const isConnected = await dataProvider.connect();
        
        if (!isConnected) {
            statusBarManager.setNotConnected();
            outputChannel.appendLine('⚠️ Antigravity process not found. Waiting for it to start...');
            return;
        }

        const [models, credits, quotaGroups] = await Promise.all([
            dataProvider.fetchQuota(),
            dataProvider.getCredits(),
            dataProvider.fetchQuotaSummary ? dataProvider.fetchQuotaSummary() : Promise.resolve([]),
        ]);
        
        if (models.length > 0 || (quotaGroups && quotaGroups.length > 0)) {
            statusBarManager.update(models, credits, quotaGroups);
            updateQuotaWebviewIfOpen(() => statusBarManager.getLastGroups());
        } else {
            statusBarManager.setError('No models returned from server');
        }
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        statusBarManager.setError(message);
        outputChannel.appendLine(`❌ Refresh failed: ${message}`);
    }
}

/**
 * Load extension configuration from VS Code settings + persisted state.
 */
function loadConfig(context: vscode.ExtensionContext): StatusBarConfig {
    const vsConfig = vscode.workspace.getConfiguration('agStatusBar');
    const pinnedModelIds = context.globalState.get<string[]>('pinnedModelIds') ?? [];
    const popupViewMode = context.globalState.get<'flat' | 'grouped' | 'limits'>('popupViewMode') ?? 'grouped';

    return {
        refreshInterval: vsConfig.get<number>('refreshInterval', 15),
        displayFormat: vsConfig.get<'standard' | 'compact' | 'minimal'>('displayFormat', 'standard'),
        warningThreshold: vsConfig.get<number>('warningThreshold', 60),
        criticalThreshold: vsConfig.get<number>('criticalThreshold', 40),
        pinnedModelIds,
        isPremiumUser: vsConfig.get<boolean>('isPremiumUser', true),
        popupViewMode,
    };
}

/**
 * Start the periodic refresh timer.
 */
function startRefreshTimer(intervalSeconds: number): void {
    refreshTimer = setInterval(() => {
        refreshQuota();
    }, intervalSeconds * 1000);
}

/**
 * Restart the refresh timer with a new interval.
 */
function restartRefreshTimer(intervalSeconds: number): void {
    if (refreshTimer) {
        clearInterval(refreshTimer);
    }
    startRefreshTimer(intervalSeconds);
}
