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
  width: number = 30
): string {
  const percent = Math.min(100, Math.round((elapsed / total) * 100));
  const filled = Math.round((percent / 100) * width);
  const empty = width - filled;

  return `[${'█'.repeat(filled)}${'░'.repeat(empty)}] ${percent}%`;
}

/**
 * Progress stats interface
 */
export interface ProgressStats {
  requests: number;
  errors: number;
  vusers: number;
  rps: number;
}

/**
 * Format progress stats line
 */
export function formatProgressStats(stats: ProgressStats): string {
  const errorRate = stats.requests > 0
    ? ((stats.errors / stats.requests) * 100).toFixed(1)
    : '0.0';

  return `Requests: ${formatNumber(stats.requests)} (${stats.rps}/s)  |  Errors: ${formatNumber(stats.errors)} (${errorRate}%)  |  VUs: ${stats.vusers}`;
}
