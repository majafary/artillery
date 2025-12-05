/**
 * Format Utilities
 * Duration parsing and formatting for progress display
 */

/**
 * Parse duration string to milliseconds
 * Supports: "30s", "1m", "2m30s", "1h", "1h30m"
 */
export function parseDuration(duration: string | number): number {
  if (typeof duration === 'number') {
    return duration;
  }

  let totalMs = 0;
  const hourMatch = duration.match(/(\d+)h/);
  const minMatch = duration.match(/(\d+)m(?!s)/);
  const secMatch = duration.match(/(\d+)s/);

  if (hourMatch) {
    totalMs += parseInt(hourMatch[1], 10) * 60 * 60 * 1000;
  }
  if (minMatch) {
    totalMs += parseInt(minMatch[1], 10) * 60 * 1000;
  }
  if (secMatch) {
    totalMs += parseInt(secMatch[1], 10) * 1000;
  }

  return totalMs;
}

/**
 * Format milliseconds to human-readable duration
 * Output: "1m 30s", "2h 15m", "45s"
 */
export function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  const remainingMinutes = minutes % 60;
  const remainingSeconds = seconds % 60;

  const parts: string[] = [];

  if (hours > 0) {
    parts.push(`${hours}h`);
  }
  if (remainingMinutes > 0 || hours > 0) {
    parts.push(`${remainingMinutes}m`);
  }
  if (remainingSeconds > 0 || parts.length === 0) {
    parts.push(`${remainingSeconds}s`);
  }

  return parts.join(' ');
}

/**
 * Format number with thousands separators
 */
export function formatNumber(num: number): string {
  return num.toLocaleString();
}

/**
 * Render a progress bar
 */
export function renderProgressBar(
  elapsed: number,
  total: number,
  width: number = 30,
  isFinishing: boolean = false
): string {
  const percent = Math.min(100, Math.round((elapsed / total) * 100));
  const filled = Math.round((percent / 100) * width);
  const empty = width - filled;

  let statusSuffix = '';
  if (isFinishing && percent === 100) {
    statusSuffix = ' - Finishing up...';
  }

  return `[${'█'.repeat(filled)}${'░'.repeat(empty)}] ${percent}%${statusSuffix}`;
}

/**
 * Progress stats interface
 */
export interface ProgressStats {
  requests: number;
  errors: number;
  errorTypes: Record<string, number>;
  statusCodes: Record<number, number>;
  vusers: number;
  rps: number;
  profiles: Record<string, number>;
}

// Network error patterns - only these should be counted as actual errors
// (Extraction errors like SyntaxError should NOT count as errors)
const NETWORK_ERROR_PATTERNS = [
  'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND',
  'EHOSTUNREACH', 'ENETUNREACH', 'socket hang up',
  'connect ECONNREFUSED', 'ESOCKETTIMEDOUT', 'EPROTO', 'EPIPE',
];

/**
 * Check if an error type is a network error (vs extraction/parsing error)
 */
function isNetworkError(errorType: string): boolean {
  return NETWORK_ERROR_PATTERNS.some(pattern =>
    errorType.toLowerCase().includes(pattern.toLowerCase())
  );
}

/**
 * Format progress stats line
 * Returns an object with main stats, optional error breakdown, and HTTP status codes
 */
export function formatProgressStats(stats: ProgressStats): {
  main: string;
  errorBreakdown?: string;
  statusLine?: string;
  profileLine?: string;
} {
  // Calculate HTTP errors from 4xx + 5xx status codes
  let httpErrors = 0;
  for (const [code, count] of Object.entries(stats.statusCodes)) {
    const codeNum = parseInt(code, 10);
    if (codeNum >= 400) {
      httpErrors += count;
    }
  }

  // Calculate network errors only (filter out extraction errors like SyntaxError)
  // This ensures live console matches final report error calculation
  let networkErrors = 0;
  for (const [errorType, count] of Object.entries(stats.errorTypes)) {
    if (isNetworkError(errorType)) {
      networkErrors += count;
    }
  }

  // Total errors = HTTP 4xx/5xx + network errors (not extraction/parsing errors)
  const totalErrors = httpErrors + networkErrors;

  const errorRate = stats.requests > 0
    ? ((totalErrors / stats.requests) * 100).toFixed(1)
    : '0.0';

  const main = `Requests: ${formatNumber(stats.requests)} (${stats.rps}/s)  |  Errors: ${formatNumber(totalErrors)} (${errorRate}%)  |  VUs: ${stats.vusers}`;

  // Build error type breakdown - only show network errors (not extraction errors)
  const networkErrorEntries = Object.entries(stats.errorTypes)
    .filter(([type]) => isNetworkError(type));
  let errorBreakdown: string | undefined;

  if (networkErrorEntries.length > 0) {
    const breakdown = networkErrorEntries
      .sort((a, b) => b[1] - a[1])  // Sort by count descending
      .slice(0, 3)  // Show top 3 error types
      .map(([type, count]) => `${type}: ${formatNumber(count)}`)
      .join('  |  ');
    errorBreakdown = breakdown;
  }

  // Build HTTP status code breakdown
  const codeEntries = Object.entries(stats.statusCodes);
  let statusLine: string | undefined;

  if (codeEntries.length > 0) {
    const breakdown = codeEntries
      .sort((a, b) => parseInt(a[0]) - parseInt(b[0]))  // Sort by code ascending
      .map(([code, count]) => {
        const codeNum = parseInt(code, 10);
        // Color-code: 2xx green, 4xx yellow, 5xx red
        if (codeNum >= 200 && codeNum < 300) {
          return `${code}: ${formatNumber(count)}`;
        } else if (codeNum >= 400 && codeNum < 500) {
          return `${code}: ${formatNumber(count)}`;
        } else if (codeNum >= 500) {
          return `${code}: ${formatNumber(count)}`;
        }
        return `${code}: ${formatNumber(count)}`;
      })
      .join('  |  ');
    statusLine = breakdown;
  }

  // Build profile breakdown if profiles exist
  const profileEntries = Object.entries(stats.profiles);
  let profileLine: string | undefined;

  if (profileEntries.length > 0) {
    const totalProfileUsers = profileEntries.reduce((sum, [, count]) => sum + count, 0);
    const breakdown = profileEntries
      .sort((a, b) => b[1] - a[1])  // Sort by count descending
      .map(([name, count]) => {
        const percentage = totalProfileUsers > 0
          ? ((count / totalProfileUsers) * 100).toFixed(0)
          : '0';
        return `${name}: ${formatNumber(count)} (${percentage}%)`;
      })
      .join('  |  ');
    profileLine = breakdown;
  }

  return { main, errorBreakdown, statusLine, profileLine };
}
