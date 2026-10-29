/**
 * Antigravity Status Bar Monitor — Webview Dashboard
 * 
 * Renders the visual card dashboard matching the official Antigravity Quota UI.
 */

import * as vscode from 'vscode';
import { QuotaGroup } from '../data/types';

let currentPanel: vscode.WebviewPanel | undefined;

export function openQuotaWebviewPanel(
    context: vscode.ExtensionContext,
    getGroups: () => QuotaGroup[],
    onRefreshRequested: () => Promise<void>
): void {
    if (currentPanel) {
        currentPanel.reveal(vscode.ViewColumn.Active);
        currentPanel.webview.html = getDashboardHtml(getGroups());
        return;
    }

    currentPanel = vscode.window.createWebviewPanel(
        'antigravityQuotaDashboard',
        'Usage — Antigravity Quota',
        vscode.ViewColumn.Active,
        {
            enableScripts: true,
            retainContextWhenHidden: true,
        }
    );

    currentPanel.webview.html = getDashboardHtml(getGroups());

    currentPanel.webview.onDidReceiveMessage(async (message) => {
        if (message.command === 'refresh') {
            await onRefreshRequested();
            if (currentPanel) {
                currentPanel.webview.html = getDashboardHtml(getGroups());
            }
        }
    });

    currentPanel.onDidDispose(() => {
        currentPanel = undefined;
    });
}

export function updateQuotaWebviewIfOpen(getGroups: () => QuotaGroup[]): void {
    if (currentPanel) {
        currentPanel.webview.html = getDashboardHtml(getGroups());
    }
}

function getDashboardHtml(groups: QuotaGroup[]): string {
    const renderCard = (group: QuotaGroup) => {
        const weekly = group.buckets.find(b => b.window === 'weekly');
        const fiveH = group.buckets.find(b => b.window === '5h');

        const renderBucket = (bucket?: typeof weekly) => {
            if (!bucket) return '';
            const pct = Math.round(bucket.remainingPercentage);
            const ringColor = pct <= 40 ? '#ef5350' : pct <= 60 ? '#ffca28' : '#4caf50';
            const trackColor = pct <= 40 ? '#3b1c1c' : pct <= 60 ? '#3b321c' : '#1e3320';

            return `
                <div class="quota-row">
                    <div class="row-left">
                        <div class="row-title">${bucket.displayName}</div>
                        ${bucket.description ? `<div class="row-desc">${bucket.description}</div>` : ''}
                    </div>
                    <div class="row-right">
                        <div class="row-pct">${pct}%</div>
                        <div class="ring-container">
                            <svg class="progress-ring" width="34" height="34" viewBox="0 0 36 36">
                                <path class="ring-bg" stroke="${trackColor}" stroke-width="3.5" fill="none"
                                    d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831" />
                                <path class="ring-fg" stroke="${ringColor}" stroke-width="3.5"
                                    stroke-dasharray="${pct}, 100" stroke-linecap="round" fill="none"
                                    d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831" />
                            </svg>
                        </div>
                    </div>
                </div>
            `;
        };

        return `
            <div class="group-section">
                <div class="group-title">${group.displayName} <span class="info-icon">ⓘ</span></div>
                <div class="quota-card">
                    ${renderBucket(weekly)}
                    ${weekly && fiveH ? '<div class="row-divider"></div>' : ''}
                    ${renderBucket(fiveH)}
                </div>
            </div>
        `;
    };

    const cardsHtml = groups.map(renderCard).join('');

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Usage — Antigravity Quota</title>
    <style>
        * {
            box-sizing: border-box;
            margin: 0;
            padding: 0;
        }
        body {
            background-color: #141414;
            color: #e0e0e0;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
            padding: 24px;
            display: flex;
            justify-content: center;
        }
        .container {
            width: 100%;
            max-width: 680px;
        }
        .header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 24px;
        }
        .header h1 {
            font-size: 18px;
            font-weight: 600;
            color: #ffffff;
        }
        .refresh-btn {
            background: #252526;
            color: #cccccc;
            border: 1px solid #3c3c3c;
            border-radius: 6px;
            padding: 6px 12px;
            font-size: 13px;
            cursor: pointer;
            display: flex;
            align-items: center;
            gap: 6px;
            transition: all 0.2s ease;
        }
        .refresh-btn:hover {
            background: #2f2f30;
            color: #ffffff;
            border-color: #555555;
        }
        .group-section {
            margin-bottom: 24px;
        }
        .group-title {
            font-size: 15px;
            font-weight: 600;
            color: #dedede;
            margin-bottom: 10px;
            display: flex;
            align-items: center;
            gap: 6px;
        }
        .info-icon {
            font-size: 13px;
            color: #888888;
            cursor: default;
        }
        .quota-card {
            background: #1c1c1c;
            border: 1px solid #2e2e2e;
            border-radius: 12px;
            padding: 16px 20px;
        }
        .quota-row {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 6px 0;
        }
        .row-left {
            flex: 1;
            padding-right: 20px;
        }
        .row-title {
            font-size: 15px;
            font-weight: 500;
            color: #e6e6e6;
            margin-bottom: 4px;
        }
        .row-desc {
            font-size: 12.5px;
            color: #8c8c8c;
            line-height: 1.4;
        }
        .row-right {
            display: flex;
            align-items: center;
            gap: 12px;
        }
        .row-pct {
            font-size: 16px;
            font-weight: 600;
            color: #ffffff;
            min-width: 44px;
            text-align: right;
        }
        .ring-container {
            width: 34px;
            height: 34px;
        }
        .progress-ring {
            transform: rotate(-90deg);
        }
        .row-divider {
            height: 1px;
            background: #2b2b2b;
            margin: 14px 0;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>Usage</h1>
            <button class="refresh-btn" onclick="refresh()" title="Refresh Quota">
                🔄️
            </button>
        </div>
        ${cardsHtml}
    </div>
    <script>
        const vscode = acquireVsCodeApi();
        function refresh() {
            vscode.postMessage({ command: 'refresh' });
        }
    </script>
</body>
</html>`;
}
