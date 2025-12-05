/**
 * Console Summary Reporter
 * Generates a compact ASCII table summary of API call statuses for console output
 */

import type { ReportData, StepMetrics } from '../types/index.js';

// ANSI color codes for terminal output
const colors = {
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  bold: '\x1b[1m',
  reset: '\x1b[0m',
  dim: '\x1b[2m',
};

/**
 * Format a number in human-readable format (1.2M, 500K, etc.)
 */
function formatNumber(num: number): string {
  if (num >= 1_000_000) {
    return `${(num / 1_000_000).toFixed(1)}M`;
  }
  if (num >= 1_000) {
    return `${(num / 1_000).toFixed(1)}K`;
  }
  return num.toString();
}

/**
 * Get color for status code
 */
function getStatusColor(code: number): string {
  if (code >= 200 && code < 300) return colors.green;
  if (code >= 300 && code < 400) return colors.cyan;
  if (code >= 400 && code < 500) return colors.yellow;
  return colors.red;
}

/**
 * Get status emoji
 */
function getStatusEmoji(code: number): string {
  if (code >= 200 && code < 300) return '✅';
  if (code >= 300 && code < 400) return '↪️';
  if (code >= 400 && code < 500) return '⚠️';
  return '❌';
}

/**
 * Format status codes for display
 */
function formatStatusCodes(statusCodes: Map<number, number> | Record<number, number>): string {
  const entries =
    statusCodes instanceof Map
      ? Array.from(statusCodes.entries())
      : Object.entries(statusCodes).map(([k, v]) => [parseInt(k), v] as [number, number]);

  if (entries.length === 0) return '-';

  // Sort by count descending, then by status code
  entries.sort((a, b) => b[1] - a[1] || a[0] - b[0]);

  // Take top 3 status codes to fit in column
  const top = entries.slice(0, 3);

  return top
    .map(([code, count]) => {
      const emoji = getStatusEmoji(code);
      const color = getStatusColor(code);
      return `${emoji}${color}${code}${colors.reset}:${formatNumber(count)}`;
    })
    .join(' ');
}

/**
 * Pad string to width, handling ANSI codes
 */
function padString(str: string, width: number, align: 'left' | 'right' | 'center' = 'left'): string {
  // Remove ANSI codes to get actual visible length
  const visibleLength = str.replace(/\x1b\[[0-9;]*m/g, '').length;
  const padding = Math.max(0, width - visibleLength);

  if (align === 'right') {
    return ' '.repeat(padding) + str;
  }
  if (align === 'center') {
    const left = Math.floor(padding / 2);
    const right = padding - left;
    return ' '.repeat(left) + str + ' '.repeat(right);
  }
  return str + ' '.repeat(padding);
}

/**
 * Build a row separator
 */
function buildSeparator(widths: number[], type: 'top' | 'middle' | 'bottom'): string {
  const chars = {
    top: { left: '┌', middle: '┬', right: '┐', line: '─' },
    middle: { left: '├', middle: '┼', right: '┤', line: '─' },
    bottom: { left: '└', middle: '┴', right: '┘', line: '─' },
  };
  const c = chars[type];
  return (
    c.left +
    widths.map((w) => c.line.repeat(w + 2)).join(c.middle) +
    c.right
  );
}

/**
 * Build a data row
 */
function buildRow(cells: string[], widths: number[]): string {
  return (
    '│ ' +
    cells.map((cell, i) => padString(cell, widths[i])).join(' │ ') +
    ' │'
  );
}

interface StepSummary {
  stepName: string;
  requestCount: number;
  statusCodes: Map<number, number>;
}

/**
 * Generate console summary from report data
 */
export function generateConsoleSummary(data: ReportData): string {
  const lines: string[] = [];

  // Title
  lines.push('');
  lines.push(
    `${colors.bold}${colors.cyan}┌────────────────────────────────────────────────────────────────┐${colors.reset}`
  );
  lines.push(
    `${colors.bold}${colors.cyan}│  API Status Summary                                            │${colors.reset}`
  );

  // Collect step summaries
  const steps: StepSummary[] = [];
  for (const [stepId, metrics] of data.stepMetrics) {
    steps.push({
      stepName: metrics.stepName || stepId,
      requestCount: metrics.requestCount,
      statusCodes: metrics.statusCodes,
    });
  }

  if (steps.length === 0) {
    lines.push(
      `${colors.bold}${colors.cyan}│  No step data available                                        │${colors.reset}`
    );
    lines.push(
      `${colors.bold}${colors.cyan}└────────────────────────────────────────────────────────────────┘${colors.reset}`
    );
    return lines.join('\n');
  }

  // Calculate column widths
  const col1Width = Math.max(
    8,
    ...steps.map((s) => s.stepName.length),
    'Endpoint'.length
  );
  const col2Width = Math.max(8, 'Requests'.length);
  const col3Width = 30; // Status codes column

  const widths = [col1Width, col2Width, col3Width];

  // Header separator (connected to title box)
  lines.push(
    `${colors.bold}${colors.cyan}├${'─'.repeat(col1Width + 2)}┬${'─'.repeat(col2Width + 2)}┬${'─'.repeat(col3Width + 2)}┤${colors.reset}`
  );

  // Header row
  lines.push(
    `${colors.bold}│ ${padString('Endpoint', col1Width)} │ ${padString('Requests', col2Width)} │ ${padString('Status Codes', col3Width)} │${colors.reset}`
  );

  // Header/data separator
  lines.push(buildSeparator(widths, 'middle'));

  // Data rows
  for (const step of steps) {
    const statusStr = formatStatusCodes(step.statusCodes);
    lines.push(
      buildRow(
        [step.stepName, formatNumber(step.requestCount), statusStr],
        widths
      )
    );
  }

  // Bottom separator and totals
  lines.push(buildSeparator(widths, 'middle'));

  // Calculate totals
  const totalRequests = data.summary.totalRequests;
  const successCount = data.summary.successfulRequests;
  const failedCount = data.summary.failedRequests;
  const successRate = totalRequests > 0 ? (successCount / totalRequests) * 100 : 0;
  const errorRate = totalRequests > 0 ? (failedCount / totalRequests) * 100 : 0;

  // Success rate color
  const rateColor =
    successRate >= 99 ? colors.green : successRate >= 95 ? colors.yellow : colors.red;

  const totalStatusStr = formatStatusCodes(data.summary.statusCodes);
  const summaryStr = `${colors.bold}Total: ${formatNumber(totalRequests)} requests${colors.reset} │ ${rateColor}${colors.bold}${successRate.toFixed(1)}% success${colors.reset} │ ${errorRate > 0 ? `${colors.red}${errorRate.toFixed(1)}% errors${colors.reset}` : `${colors.green}0% errors${colors.reset}`}`;

  // Summary row (spanning columns)
  const totalWidth = widths.reduce((a, b) => a + b, 0) + (widths.length - 1) * 3;
  lines.push(`│ ${padString(summaryStr, totalWidth)} │`);

  // Status codes breakdown
  lines.push(`│ ${padString(`Status: ${totalStatusStr}`, totalWidth)} │`);

  // Bottom border
  lines.push(`└${'─'.repeat(totalWidth + 2)}┘`);
  lines.push('');

  return lines.join('\n');
}

/**
 * Generate a minimal summary for quiet mode
 */
export function generateMinimalSummary(data: ReportData): string {
  const total = data.summary.totalRequests;
  const success = data.summary.successfulRequests;
  const failed = data.summary.failedRequests;
  const successRate = total > 0 ? (success / total) * 100 : 0;

  const rateColor =
    successRate >= 99 ? colors.green : successRate >= 95 ? colors.yellow : colors.red;

  const statusIcon = successRate >= 99 ? '✅' : successRate >= 95 ? '⚠️' : '❌';

  return `${statusIcon} ${formatNumber(total)} requests | ${rateColor}${successRate.toFixed(1)}% success${colors.reset} | ${failed > 0 ? `${colors.red}${formatNumber(failed)} failed${colors.reset}` : `${colors.green}all passed${colors.reset}`}`;
}

/**
 * Print summary directly to console
 */
export function printConsoleSummary(data: ReportData): void {
  console.log(generateConsoleSummary(data));
}
