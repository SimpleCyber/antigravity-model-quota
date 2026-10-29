import * as vscode from 'vscode';
import { ModelQuota, StatusBarConfig, QuotaGroup } from '../data/types';
import {
    getStatusEmoji,
    formatTimeAgo,
    formatResetsIn
} from '../utils/formatting';
import {
    FLEJET_URL,
    GITHUB_URL,
    FLEJET_ICON_DATA,
    GITHUB_ICON_DATA
} from './brandIcons';

/**
 * Builds the clean hover tooltip matching the reference image.
 * Displays the exact Usage breakdown for Gemini Models and Claude/GPT models.
 */
export function buildTooltip(
    models: ModelQuota[],
    config: StatusBarConfig,
    lastUpdateTime?: Date,
    quotaGroups?: QuotaGroup[]
): vscode.MarkdownString {
    const tooltip = new vscode.MarkdownString();
    tooltip.isTrusted = true;
    tooltip.supportHtml = true;

    tooltip.appendMarkdown('### Usage <span style="float:right;">[🔄️](command:antigravity.refreshQuota "Refresh Quota")</span>\n\n');

    if (quotaGroups && quotaGroups.length > 0) {
        for (let i = 0; i < quotaGroups.length; i++) {
            const group = quotaGroups[i];
            tooltip.appendMarkdown(`**${group.displayName}**\n\n`);

            const weekly = group.buckets.find(b => b.window === 'weekly');
            const fiveH = group.buckets.find(b => b.window === '5h');

            if (weekly) {
                const icon = getStatusEmoji(weekly.remainingPercentage, config);
                const pct = Math.round(weekly.remainingPercentage);
                const delta = weekly.resetTime.getTime() - Date.now();
                const resetText = delta > 0 ? formatResetsIn(delta) : 'now';
                const resetLine = pct < 100
                    ? `\n&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;<span style="color:#888;">_Resets in ${resetText}_</span>\n\n`
                    : '\n\n';

                tooltip.appendMarkdown(`Weekly limit &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; **${pct}% left** &nbsp;${icon}${resetLine}`);
            }

            if (fiveH) {
                const icon = getStatusEmoji(fiveH.remainingPercentage, config);
                const pct = Math.round(fiveH.remainingPercentage);
                const delta = fiveH.resetTime.getTime() - Date.now();
                const resetText = delta > 0 ? formatResetsIn(delta) : 'now';
                const resetLine = pct < 100
                    ? `\n&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;<span style="color:#888;">_Resets in ${resetText}_</span>\n\n`
                    : '\n\n';

                tooltip.appendMarkdown(`5h limit &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; **${pct}% left** &nbsp;${icon}${resetLine}`);
            }

            if (i < quotaGroups.length - 1) {
                tooltip.appendMarkdown('\n');
            }
        }
    } else {
        // Fallback calculated from models
        const geminiModels = models.filter(m => m.family === 'gemini');
        const claudeModels = models.filter(m => m.family === 'claude' || m.family === 'gpt');

        const geminiPct = geminiModels.length > 0 ? Math.round(Math.min(...geminiModels.map(m => m.remainingPercentage))) : 100;
        const claudePct = claudeModels.length > 0 ? Math.round(Math.min(...claudeModels.map(m => m.remainingPercentage))) : 100;

        tooltip.appendMarkdown(`**Gemini Models**\n\n`);
        tooltip.appendMarkdown(`5h limit &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; **${geminiPct}% left** &nbsp;${getStatusEmoji(geminiPct, config)}\n\n`);

        tooltip.appendMarkdown(`**Claude and GPT models**\n\n`);
        tooltip.appendMarkdown(`5h limit &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; **${claudePct}% left** &nbsp;${getStatusEmoji(claudePct, config)}\n\n`);
    }

    // Brand and repository links at the bottom of the hover
    tooltip.appendMarkdown('---\n\n');
    const flejetLogo = `<img src="${FLEJET_ICON_DATA}" width="16" height="16" style="vertical-align:middle; border-radius:3px;" />`;
    const githubLogo = `<img src="${GITHUB_ICON_DATA}" width="16" height="16" style="vertical-align:middle;" />`;
    tooltip.appendMarkdown(`${flejetLogo} [flejet.in](${FLEJET_URL}) &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; ${githubLogo} [Contribute here](${GITHUB_URL})`);

    if (lastUpdateTime) {
        tooltip.appendMarkdown(`\n\n---\n_$(history) Last updated: ${formatTimeAgo(lastUpdateTime)}_`);
    }

    return tooltip;
}
