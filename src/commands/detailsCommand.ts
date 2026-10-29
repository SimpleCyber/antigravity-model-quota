/**
 * Antigravity Status Bar Monitor — Dashboard Window
 * 
 * Displays the clean Usage dashboard matching the official reference image.
 * Read-only view (no checkboxes, no choosing anything).
 */

import * as vscode from 'vscode';
import { ModelQuota, StatusBarConfig, QuotaGroup } from '../data/types';
import { getStatusIcon } from '../utils/formatting';

// Custom UI Buttons
const REFRESH_BUTTON: vscode.QuickInputButton = {
    iconPath: new vscode.ThemeIcon('sync'),
    tooltip: 'Refresh Quota Data'
};

const WEBVIEW_BUTTON: vscode.QuickInputButton = {
    iconPath: new vscode.ThemeIcon('layout-dashboard'),
    tooltip: 'Open Visual Card Dashboard'
};

/**
 * Show the clean Usage window dashboard matching the reference image.
 * No checkboxes, no individual models, exactly matching the screenshot.
 */
export async function showDetailsQuickPick(
    getModels: () => ModelQuota[],
    getGroups: () => QuotaGroup[],
    config: StatusBarConfig,
    onRefreshRequested: () => Promise<void>,
    onOpenWebview?: () => void
): Promise<void> {
    return new Promise<void>((resolve) => {
        const qp = vscode.window.createQuickPick();
        qp.title = 'Usage — Antigravity Quota';
        qp.placeholder = 'Usage overview. Press Escape to close.';
        qp.canSelectMany = false; // Disables checkboxes / choosing completely
        qp.matchOnDescription = true;
        qp.matchOnDetail = true;
        qp.buttons = onOpenWebview ? [REFRESH_BUTTON, WEBVIEW_BUTTON] : [REFRESH_BUTTON];

        const updateItems = () => {
            const groups = getGroups();
            const items: vscode.QuickPickItem[] = [];

            if (groups && groups.length > 0) {
                for (const group of groups) {
                    items.push({
                        label: `${group.displayName} ⓘ`,
                        kind: vscode.QuickPickItemKind.Separator,
                    });

                    const weekly = group.buckets.find(b => b.window === 'weekly');
                    const fiveH = group.buckets.find(b => b.window === '5h');

                    if (weekly) {
                        const icon = getStatusIcon(weekly.remainingPercentage, config);
                        const pct = Math.round(weekly.remainingPercentage);
                        const detail = weekly.description ? `    ${weekly.description}` : '';

                        items.push({
                            label: weekly.displayName,
                            description: `${pct}%  ${icon}`,
                            detail,
                        });
                    }

                    if (fiveH) {
                        const icon = getStatusIcon(fiveH.remainingPercentage, config);
                        const pct = Math.round(fiveH.remainingPercentage);
                        const detail = fiveH.description ? `    ${fiveH.description}` : '';

                        items.push({
                            label: fiveH.displayName,
                            description: `${pct}%  ${icon}`,
                            detail,
                        });
                    }
                }
            } else {
                items.push({
                    label: 'No quota data available',
                    description: 'Click $(sync) to refresh',
                });
            }

            qp.items = items;
        };

        updateItems();

        // Handle button clicks
        qp.onDidTriggerButton(async (btn) => {
            if (btn === REFRESH_BUTTON) {
                qp.busy = true;
                await onRefreshRequested();
                updateItems();
                qp.busy = false;
                vscode.window.showInformationMessage('Refreshed Antigravity quota data.');
            } else if (btn === WEBVIEW_BUTTON && onOpenWebview) {
                qp.hide();
                onOpenWebview();
            }
        });

        // Close on Enter or click
        qp.onDidAccept(() => {
            qp.hide();
        });

        // Close and clean up
        qp.onDidHide(() => {
            qp.dispose();
            resolve();
        });

        qp.show();
    });
}
