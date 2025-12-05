/**
 * Request Detail Logger
 * Captures and streams request/response details to CSV for debugging
 * Supports sampling strategies to handle large-scale tests efficiently
 */

import { createWriteStream, type WriteStream } from 'fs';
import { mkdir } from 'fs/promises';
import { dirname, join } from 'path';

/**
 * Sampling mode for request logging
 */
export type SamplingMode = 'first-n-plus-errors' | 'errors-only' | 'all';

/**
 * Configuration for request detail logging
 */
export interface RequestDetailLoggerOptions {
  /** Output directory for the CSV file */
  outputDir: string;
  /** Sampling mode (default: 'first-n-plus-errors') */
  samplingMode?: SamplingMode;
  /** Number of first requests to capture (for first-n-plus-errors mode) */
  sampleSize?: number;
  /** Maximum body size to capture (bytes, default: 1024) */
  maxBodySize?: number;
  /** Warn if expected request count is very large */
  expectedRequestCount?: number;
}

/**
 * Details of a single HTTP request/response
 */
export interface RequestDetail {
  /** ISO timestamp */
  timestamp: string;
  /** Step ID from journey */
  stepId: string;
  /** Step name */
  stepName: string;
  /** Full request URL */
  requestUrl: string;
  /** HTTP method (GET, POST, etc.) */
  httpMethod: string;
  /** Request headers as JSON string */
  requestHeaders: string;
  /** Request body (truncated if needed) */
  requestBody: string;
  /** Response HTTP status code */
  responseStatus: number;
  /** Response headers as JSON string */
  responseHeaders: string;
  /** Response body (truncated if needed) */
  responseBody: string;
  /** Response time in milliseconds */
  responseTimeMs: number;
  /** Cookies as JSON string */
  cookies: string;
}

/**
 * CSV column headers
 */
const CSV_HEADERS = [
  'timestamp',
  'step_id',
  'step_name',
  'request_url',
  'http_method',
  'request_headers',
  'request_body',
  'response_status',
  'response_headers',
  'response_body',
  'response_time_ms',
  'cookies',
];

/**
 * Escape a string for CSV (RFC 4180 compliant)
 */
function escapeCSV(value: string | number | undefined | null): string {
  if (value === undefined || value === null) {
    return '';
  }
  const str = String(value);
  // If the value contains comma, quote, or newline, wrap in quotes
  if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
    // Double any quotes and wrap in quotes
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/**
 * Truncate a string to max length with indicator
 */
function truncate(str: string, maxLength: number): string {
  if (str.length <= maxLength) {
    return str;
  }
  return str.substring(0, maxLength - 12) + '...[TRUNCATED]';
}

/**
 * Request Detail Logger
 * Streams request/response details to CSV file with configurable sampling
 */
export class RequestDetailLogger {
  private outputPath: string;
  private stream: WriteStream | null = null;
  private options: Required<RequestDetailLoggerOptions>;
  private requestCount = 0;
  private errorCount = 0;
  private sampledCount = 0;
  private initialized = false;
  private warningIssued = false;

  constructor(options: RequestDetailLoggerOptions) {
    this.options = {
      outputDir: options.outputDir,
      samplingMode: options.samplingMode ?? 'first-n-plus-errors',
      sampleSize: options.sampleSize ?? 100,
      maxBodySize: options.maxBodySize ?? 1024,
      expectedRequestCount: options.expectedRequestCount ?? 0,
    };

    const timestamp = Date.now();
    this.outputPath = join(this.options.outputDir, `request-details-${timestamp}.csv`);
  }

  /**
   * Initialize the logger (creates directory and file with headers)
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    // Ensure output directory exists
    await mkdir(dirname(this.outputPath), { recursive: true });

    // Create write stream
    this.stream = createWriteStream(this.outputPath, { encoding: 'utf8' });

    // Write CSV headers
    this.stream.write(CSV_HEADERS.join(',') + '\n');

    this.initialized = true;

    // Issue warning for large expected request counts with 'all' mode
    if (
      this.options.samplingMode === 'all' &&
      this.options.expectedRequestCount > 10000 &&
      !this.warningIssued
    ) {
      console.warn(
        `\n⚠️  WARNING: Logging all requests for ~${this.options.expectedRequestCount.toLocaleString()} expected requests.`
      );
      console.warn('   This may create a very large CSV file and impact performance.');
      console.warn('   Consider using --debug without --sample-all for large tests.\n');
      this.warningIssued = true;
    }
  }

  /**
   * Determine if this request should be logged based on sampling strategy
   */
  private shouldLog(detail: RequestDetail): boolean {
    switch (this.options.samplingMode) {
      case 'all':
        return true;

      case 'errors-only':
        return detail.responseStatus < 200 || detail.responseStatus >= 300;

      case 'first-n-plus-errors':
      default:
        // Log first N requests
        if (this.requestCount <= this.options.sampleSize) {
          return true;
        }
        // Always log errors
        if (detail.responseStatus < 200 || detail.responseStatus >= 300) {
          return true;
        }
        return false;
    }
  }

  /**
   * Log a request/response detail
   */
  logRequest(detail: RequestDetail): void {
    this.requestCount++;

    // Check if response is an error
    const isError = detail.responseStatus < 200 || detail.responseStatus >= 300;
    if (isError) {
      this.errorCount++;
    }

    // Apply sampling
    if (!this.shouldLog(detail)) {
      return;
    }

    if (!this.stream) {
      console.warn('RequestDetailLogger: Stream not initialized, call initialize() first');
      return;
    }

    this.sampledCount++;

    // Truncate bodies
    const truncatedRequestBody = truncate(detail.requestBody, this.options.maxBodySize);
    const truncatedResponseBody = truncate(detail.responseBody, this.options.maxBodySize);

    // Build CSV row
    const row = [
      escapeCSV(detail.timestamp),
      escapeCSV(detail.stepId),
      escapeCSV(detail.stepName),
      escapeCSV(detail.requestUrl),
      escapeCSV(detail.httpMethod),
      escapeCSV(detail.requestHeaders),
      escapeCSV(truncatedRequestBody),
      escapeCSV(detail.responseStatus),
      escapeCSV(detail.responseHeaders),
      escapeCSV(truncatedResponseBody),
      escapeCSV(detail.responseTimeMs),
      escapeCSV(detail.cookies),
    ];

    this.stream.write(row.join(',') + '\n');
  }

  /**
   * Get the output file path
   */
  getOutputPath(): string {
    return this.outputPath;
  }

  /**
   * Get logging statistics
   */
  getStats(): {
    totalRequests: number;
    sampledRequests: number;
    errorRequests: number;
    samplingMode: SamplingMode;
  } {
    return {
      totalRequests: this.requestCount,
      sampledRequests: this.sampledCount,
      errorRequests: this.errorCount,
      samplingMode: this.options.samplingMode,
    };
  }

  /**
   * Close the logger and finalize the file
   */
  async close(): Promise<void> {
    if (!this.stream) return;

    return new Promise((resolve) => {
      this.stream!.end(() => {
        this.stream = null;
        resolve();
      });
    });
  }

  /**
   * Generate a summary line for console output
   */
  getSummaryLine(): string {
    const stats = this.getStats();
    if (stats.totalRequests === 0) {
      return 'No requests logged';
    }

    const parts = [
      `📝 Logged ${stats.sampledRequests.toLocaleString()} of ${stats.totalRequests.toLocaleString()} requests`,
    ];

    if (stats.errorRequests > 0) {
      parts.push(`(${stats.errorRequests.toLocaleString()} errors)`);
    }

    parts.push(`→ ${this.outputPath}`);

    return parts.join(' ');
  }
}

/**
 * Create request detail from Artillery request/response context
 */
export function createRequestDetail(
  requestParams: {
    url?: string;
    method?: string;
    headers?: Record<string, string>;
    json?: unknown;
    body?: string;
    __stepId?: string;
    __stepName?: string;
  },
  response: {
    statusCode?: number;
    headers?: Record<string, string>;
    body?: string | object;
    timings?: { phases?: { total?: number } };
  },
  context: {
    vars?: Record<string, unknown>;
  }
): RequestDetail {
  // Extract cookies from response headers
  const cookies: string[] = [];
  if (response.headers) {
    const setCookie = response.headers['set-cookie'];
    if (setCookie) {
      if (Array.isArray(setCookie)) {
        cookies.push(...setCookie);
      } else {
        cookies.push(setCookie);
      }
    }
  }

  // Determine request body
  let requestBody = '';
  if (requestParams.json) {
    try {
      requestBody = JSON.stringify(requestParams.json);
    } catch {
      requestBody = '[Unable to serialize request body]';
    }
  } else if (requestParams.body) {
    requestBody = requestParams.body;
  }

  // Determine response body
  let responseBody = '';
  if (response.body) {
    if (typeof response.body === 'string') {
      responseBody = response.body;
    } else {
      try {
        responseBody = JSON.stringify(response.body);
      } catch {
        responseBody = '[Unable to serialize response body]';
      }
    }
  }

  return {
    timestamp: new Date().toISOString(),
    stepId: requestParams.__stepId || 'unknown',
    stepName: requestParams.__stepName || 'unknown',
    requestUrl: requestParams.url || '',
    httpMethod: requestParams.method?.toUpperCase() || 'GET',
    requestHeaders: JSON.stringify(requestParams.headers || {}),
    requestBody,
    responseStatus: response.statusCode || 0,
    responseHeaders: JSON.stringify(response.headers || {}),
    responseBody,
    responseTimeMs: response.timings?.phases?.total || 0,
    cookies: JSON.stringify(cookies),
  };
}
