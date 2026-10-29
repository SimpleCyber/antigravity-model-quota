/**
 * Antigravity Status Bar Monitor — Status Bar Manager
 * 
 * Creates and manages the status bar item displaying the simplified Gemini and Claude quotas.
 * Provides the rich hover tooltip matching the official Usage breakdown.
 */

import * as vscode from 'vscode';
import { ModelQuota, StatusBarConfig, QuotaGroup } from '../data/types';
import { getStatusIcon } from '../utils/formatting';
import { buildTooltip } from './tooltipBuilder';

export class StatusBarManager {
    private statusBarItem: vscode.StatusBarItem;
    private lastModels: ModelQuota[] = [];
    private lastCredits: number = 0;
    private lastGroups: QuotaGroup[] = [];
    private config: StatusBarConfig;
    private temporaryMessageTimer: ReturnType<typeof setTimeout> | undefined;
    private lastUpdateTime: Date | undefined;

    constructor(context: vscode.ExtensionContext, config: StatusBarConfig) {
        this.config = config;

        // Create the main status bar item
        this.statusBarItem = vscode.window.createStatusBarItem(
            vscode.StatusBarAlignment.Left,
            100,
        );
        this.statusBarItem.command = 'antigravity.showDetails';
        this.statusBarItem.text = '$(rocket) Loading...';
        this.statusBarItem.name = 'Antigravity Model Monitor';
        this.statusBarItem.show();

        context.subscriptions.push(this.statusBarItem);
    }

    /**
     * Update the status bar with new quota data.
     */
    public update(models: ModelQuota[], credits: number, quotaGroups?: QuotaGroup[]): void {
        const filteredModels = models.filter(m => !m.isPremium || this.config.isPremiumUser);

        this.lastModels = filteredModels;
        this.lastCredits = credits;
        if (quotaGroups) {
            this.lastGroups = quotaGroups;
        }

        for (const model of filteredModels) {
            model.isPinned = this.config.pinnedModelIds.includes(model.id);
        }

        this.lastUpdateTime = new Date();

        // Update simplified status bar text (Gemini and Claude models only)
        this.updateStatusBarText(filteredModels);

        // Update hover tooltip matching the reference image layout
        this.statusBarItem.tooltip = buildTooltip(filteredModels, this.config, this.lastUpdateTime, this.lastGroups);
    }

    /**
     * Update the config and refresh display.
     */
    public updateConfig(config: StatusBarConfig): void {
        this.config = config;
        if (this.lastModels.length > 0 || this.lastGroups.length > 0) {
            this.update(this.lastModels, this.lastCredits, this.lastGroups);
        }
    }

    /**
     * Get the list of pinned model IDs.
     */
    public getPinnedModelIds(): string[] {
        return [...this.config.pinnedModelIds];
    }

    /**
     * Set pinned model IDs and refresh.
     */
    public setPinnedModels(ids: string[]): void {
        this.config.pinnedModelIds = ids;
        if (this.lastModels.length > 0 || this.lastGroups.length > 0) {
            this.update(this.lastModels, this.lastCredits, this.lastGroups);
        }
    }

    /**
     * Set the popup view mode.
     */
    public setPopupViewMode(mode: 'flat' | 'grouped' | 'limits'): void {
        this.config.popupViewMode = mode;
    }

    /**
     * Get the last known models.
     */
    public getLastModels(): ModelQuota[] {
        return this.lastModels;
    }

    /**
     * Get the last known quota pool groups.
     */
    public getLastGroups(): QuotaGroup[] {
        return this.lastGroups;
    }

    /**
     * Get the current config.
     */
    public getConfig(): StatusBarConfig {
        return this.config;
    }

    /**
     * Show a loading state.
     */
    public setLoading(): void {
        this.statusBarItem.text = '$(sync~spin) Syncing...';
        this.statusBarItem.backgroundColor = undefined;
    }

    /**
     * Show a temporary confirmation message, then restore the live quota text.
     */
    public showTemporaryMessage(message: string, durationMs: number = 3000): void {
        if (this.temporaryMessageTimer) {
            clearTimeout(this.temporaryMessageTimer);
        }

        this.statusBarItem.text = message;
        this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.prominentBackground');

        this.temporaryMessageTimer = setTimeout(() => {
            this.updateStatusBarText(this.lastModels);
            this.statusBarItem.backgroundColor = undefined;
            this.temporaryMessageTimer = undefined;
        }, durationMs);
    }

    /**
     * Show a not-connected state.
     */
    public setNotConnected(): void {
        this.statusBarItem.text = '$(debug-disconnect) Not Connected';
        this.statusBarItem.tooltip = 'Antigravity language server is not running or not found. Make sure Windsurf/Antigravity is active.';
        this.statusBarItem.backgroundColor = undefined;
    }

    /**
     * Show an error state.
     */
    public setError(message: string): void {
        this.statusBarItem.text = '$(error) Quota Error';
        this.statusBarItem.tooltip = message;
        this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
    }

    /**
     * Build the status bar text: only displays Gemini and Claude model percentages.
     */
    private updateStatusBarText(models: ModelQuota[]): void {
        let geminiPct = 100;
        let claudePct = 100;

        // Derive active percentage from the 5-hour limit pools
        for (const g of this.lastGroups) {
            const fiveH = g.buckets.find(b => b.window === '5h') || g.buckets[0];
            if (fiveH) {
                if (g.displayName.toLowerCase().includes('gemini')) {
                    geminiPct = Math.round(fiveH.remainingPercentage);
                } else {
                    claudePct = Math.round(fiveH.remainingPercentage);
                }
            }
        }

        // Fallback to min of models if pool groups aren't available
        if (this.lastGroups.length === 0 && models.length > 0) {
            const geminiModels = models.filter(m => m.family === 'gemini');
            const claudeModels = models.filter(m => m.family === 'claude' || m.family === 'gpt');
            if (geminiModels.length > 0) {
                geminiPct = Math.round(Math.min(...geminiModels.map(m => m.remainingPercentage)));
            }
            if (claudeModels.length > 0) {
                claudePct = Math.round(Math.min(...claudeModels.map(m => m.remainingPercentage)));
            }
        }

        const geminiIcon = getStatusIcon(geminiPct, this.config);
        const claudeIcon = getStatusIcon(claudePct, this.config);
        const brandingSuffix = '   🐰';

        switch (this.config.displayFormat) {
            case 'minimal':
                this.statusBarItem.text = `${geminiIcon} ${claudeIcon}${brandingSuffix}`;
                break;
            case 'compact':
                this.statusBarItem.text = `${geminiIcon}${geminiPct}% | ${claudeIcon}${claudePct}%${brandingSuffix}`;
                break;
            case 'standard':
            default:
                this.statusBarItem.text = `${geminiIcon} Gemini: ${geminiPct}%  ${claudeIcon} Claude: ${claudePct}%${brandingSuffix}`;
                break;
        }

        this.statusBarItem.backgroundColor = undefined;
    }
}
