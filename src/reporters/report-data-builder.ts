/**
 * Report Data Builder
 * Converts Artillery output to ReportData structure
 */

import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import type {
  ReportData,
  ReportMetadata,
  TestSummary,
  LatencyMetrics,
  StepMetrics,
  PhaseResult,
  ErrorSummary,
  ThresholdResult,
  ProfileMetrics,
  ThresholdsConfig,
  Journey,
} from '../types/index.js';

export interface BuilderOptions {
  journey: Journey;
  environment: string;
  thresholds?: ThresholdsConfig;
  enhancedReportPath?: string;
  /** Enable debug logging for endpoint-to-step mapping */
  debug?: boolean;
}

export class ReportDataBuilder {
  private options: BuilderOptions;

  constructor(options: BuilderOptions) {
    this.options = options;
  }

  /**
   * Build ReportData from Artillery JSON output
   */
  async build(artilleryOutputPath: string): Promise<ReportData> {
    if (!existsSync(artilleryOutputPath)) {
      throw new Error(`Artillery output file not found: ${artilleryOutputPath}. The test may have failed to complete.`);
    }

    const artilleryData = await this.loadArtilleryOutput(artilleryOutputPath);

    // Load enhanced report if available
    let enhancedData: EnhancedReportData | null = null;
    if (this.options.enhancedReportPath && existsSync(this.options.enhancedReportPath)) {
      enhancedData = await this.loadEnhancedReport(this.options.enhancedReportPath);
    }

    const aggregate = artilleryData.aggregate || {};

    return {
      metadata: this.buildMetadata(artilleryData),
      summary: this.buildSummary(aggregate),
      latency: this.buildLatency(aggregate),
      stepMetrics: this.buildStepMetrics(enhancedData, aggregate),
      phases: this.buildPhases(artilleryData),
      errors: this.buildErrors(aggregate, enhancedData),
      thresholdResults: this.buildThresholdResults(aggregate),
      profiles: this.buildProfileMetrics(enhancedData, aggregate),
    };
  }

  /**
   * Load Artillery JSON output
   */
  private async loadArtilleryOutput(path: string): Promise<ArtilleryOutput> {
    const content = await readFile(path, 'utf-8');
    return JSON.parse(content);
  }

  /**
   * Load enhanced report from plugin
   */
  private async loadEnhancedReport(path: string): Promise<EnhancedReportData> {
    const content = await readFile(path, 'utf-8');
    return JSON.parse(content);
  }

  /**
   * Build metadata section
   */
  private buildMetadata(data: ArtilleryOutput): ReportMetadata {
    return {
      testName: `${this.options.journey.name} Load Test`,
      journeyId: this.options.journey.id,
      journeyName: this.options.journey.name,
      environment: this.options.environment,
      startTime: new Date(data.aggregate?.firstCounterAt || Date.now()),
      endTime: new Date(data.aggregate?.lastCounterAt || Date.now()),
      duration: data.aggregate?.lastCounterAt && data.aggregate?.firstCounterAt
        ? data.aggregate.lastCounterAt - data.aggregate.firstCounterAt
        : 0,
      version: '1.0.0',
    };
  }

  /**
   * Build summary section
   * Supports both Artillery v2 (counters/rates) and v1 (flat) formats
   */
  private buildSummary(aggregate: ArtilleryAggregate): TestSummary {
    // v2 format: counters object
    const counters = aggregate.counters || {};
    const rates = aggregate.rates || {};

    // Get total requests (v2: counters['http.requests'], v1: requestsCompleted)
    const totalRequests = counters['http.requests'] || aggregate.requestsCompleted || 0;

    // Extract HTTP status codes from counters (v2 format: http.codes.XXX keys)
    const statusCodes: Record<number, number> = {};
    for (const [key, value] of Object.entries(counters)) {
      if (key.startsWith('http.codes.')) {
        const code = parseInt(key.replace('http.codes.', ''), 10);
        if (!isNaN(code)) {
          statusCodes[code] = value;
        }
      }
    }

    // Also check legacy codes format
    if (aggregate.codes) {
      for (const [code, count] of Object.entries(aggregate.codes)) {
        const codeNum = parseInt(code, 10);
        if (!isNaN(codeNum) && !statusCodes[codeNum]) {
          statusCodes[codeNum] = count;
        }
      }
    }

    // Calculate success (2xx) vs failure (4xx + 5xx) from status codes
    let successCount = 0;
    let clientErrors = 0;
    let serverErrors = 0;
    for (const [code, count] of Object.entries(statusCodes)) {
      const codeNum = parseInt(code, 10);
      if (codeNum >= 200 && codeNum < 300) {
        successCount += count;
      } else if (codeNum >= 400 && codeNum < 500) {
        clientErrors += count;
      } else if (codeNum >= 500) {
        serverErrors += count;
      }
    }

    // Count connection/network errors - use v2 format OR v1 format, not both
    // to avoid double-counting when Artillery provides both formats
    // IMPORTANT: Only count actual network errors, not extraction/validation errors
    // - Connection errors: ECONNREFUSED, ECONNRESET, ETIMEDOUT, socket hang up, etc.
    // - NOT errors like "Failed capture or match" which are extraction errors
    let connectionErrors = 0;
    let foundV2Errors = false;

    // Patterns that indicate actual connection/network errors
    const networkErrorPatterns = [
      'ECONNREFUSED',
      'ECONNRESET',
      'ETIMEDOUT',
      'ENOTFOUND',
      'EHOSTUNREACH',
      'ENETUNREACH',
      'socket hang up',
      'connect ECONNREFUSED',
      'ESOCKETTIMEDOUT',
      'EPROTO',
      'EPIPE',
    ];

    // First try v2 format: counters['errors.*'] keys
    for (const [key, value] of Object.entries(counters)) {
      if (key.startsWith('errors.')) {
        // Extract error message (everything after 'errors.')
        const errorMessage = key.replace('errors.', '');
        // Only count as connection error if it matches network error patterns
        const isNetworkError = networkErrorPatterns.some(pattern =>
          errorMessage.toUpperCase().includes(pattern.toUpperCase())
        );
        if (isNetworkError) {
          connectionErrors += value;
        }
        foundV2Errors = true;
      }
    }

    // Only use v1 format (aggregate.errors) if no v2 errors were found
    if (!foundV2Errors && aggregate.errors) {
      for (const [errorMessage, value] of Object.entries(aggregate.errors)) {
        // Only count as connection error if it matches network error patterns
        const isNetworkError = networkErrorPatterns.some(pattern =>
          errorMessage.toUpperCase().includes(pattern.toUpperCase())
        );
        if (isNetworkError) {
          connectionErrors += value;
        }
      }
    }

    // Total failed = HTTP 4xx + HTTP 5xx + connection errors
    const failedRequests = clientErrors + serverErrors + connectionErrors;

    // Get VU counts
    // Note: Artillery's vusers.failed includes VUs with ANY error (including extraction errors)
    // We want to count VU failures based on actual HTTP failures, not extraction errors
    const vusersCreated = counters['vusers.created'] || aggregate.scenariosCreated || 0;
    const artilleryVusersFailed = counters['vusers.failed'] || 0;
    const artilleryVusersCompleted = counters['vusers.completed'] || aggregate.scenariosCompleted || 0;

    // Calculate actual HTTP failure rate - if all HTTP requests succeeded, VUs shouldn't be "failed"
    const httpFailureRate = totalRequests > 0 ? failedRequests / totalRequests : 0;

    // If HTTP failure rate is 0 but Artillery says VUs failed, those are extraction errors not HTTP failures
    // In this case, report VUs as completed (from HTTP perspective) rather than failed
    let vusersCompleted: number;
    let vusersFailed: number;

    if (httpFailureRate === 0 && artilleryVusersFailed > 0 && artilleryVusersCompleted === 0) {
      // All HTTP requests succeeded, but Artillery marked VUs as failed due to extraction errors
      // Count these as completed from an HTTP perspective
      vusersCompleted = vusersCreated;
      vusersFailed = 0;
    } else {
      // Normal case: use Artillery's counts or calculate from HTTP failures
      vusersFailed = artilleryVusersFailed || Math.round(vusersCreated * httpFailureRate);
      vusersCompleted = artilleryVusersCompleted || (vusersCreated - vusersFailed);
    }

    // Get throughput (v2: rates['http.request_rate'], v1: rps.mean)
    const throughput = rates['http.request_rate'] || aggregate.rps?.mean || 0;

    return {
      totalRequests,
      successfulRequests: successCount,
      failedRequests,
      errorRate: totalRequests > 0 ? failedRequests / totalRequests : 0,
      throughput,
      virtualUsers: {
        total: vusersCreated,
        completed: vusersCompleted,
        failed: vusersFailed,
      },
      statusCodes,
    };
  }

  /**
   * Build latency section
   * Supports both Artillery v2 (histograms) and v1 (flat latency) formats
   *
   * For consistency with step-level metrics, we prefer step.*.response_time histograms
   * when available (especially for single-step journeys), as these include the full
   * step execution time including processor overhead.
   */
  private buildLatency(aggregate: ArtilleryAggregate): LatencyMetrics {
    const histograms = aggregate.histograms || {};

    // First, try to aggregate from step-level response_time histograms for consistency
    // with the Step-by-Step Performance section
    const stepHistograms: Array<{
      min?: number;
      max?: number;
      mean?: number;
      median?: number;
      p50?: number;
      p90?: number;
      p95?: number;
      p99?: number;
      count?: number;
    }> = [];

    for (const [key, hist] of Object.entries(histograms)) {
      if (key.match(/^step\.[^.]+\.response_time$/) && hist) {
        stepHistograms.push(hist);
      }
    }

    // If we have step histograms, compute aggregate latency from them
    if (stepHistograms.length > 0) {
      // For a single step, use its values directly
      if (stepHistograms.length === 1) {
        const h = stepHistograms[0];
        return {
          min: h.min || 0,
          max: h.max || 0,
          mean: Math.round(h.mean || 0),
          median: h.median || h.p50 || 0,
          p90: h.p90 || 0,
          p95: h.p95 || 0,
          p99: h.p99 || 0,
          stdDev: 0,
        };
      }

      // For multiple steps, compute weighted averages based on count
      // and take min/max across all steps
      let totalCount = 0;
      let weightedMean = 0;
      let minVal = Infinity;
      let maxVal = 0;
      // For percentiles, we take the max across steps (conservative approach)
      let maxP90 = 0;
      let maxP95 = 0;
      let maxP99 = 0;
      let maxMedian = 0;

      for (const h of stepHistograms) {
        const count = h.count || 1;
        totalCount += count;
        weightedMean += (h.mean || 0) * count;
        if (h.min !== undefined && h.min < minVal) minVal = h.min;
        if (h.max !== undefined && h.max > maxVal) maxVal = h.max;
        if ((h.median || h.p50 || 0) > maxMedian) maxMedian = h.median || h.p50 || 0;
        if ((h.p90 || 0) > maxP90) maxP90 = h.p90 || 0;
        if ((h.p95 || 0) > maxP95) maxP95 = h.p95 || 0;
        if ((h.p99 || 0) > maxP99) maxP99 = h.p99 || 0;
      }

      return {
        min: minVal === Infinity ? 0 : minVal,
        max: maxVal,
        mean: Math.round(totalCount > 0 ? weightedMean / totalCount : 0),
        median: maxMedian,
        p90: maxP90,
        p95: maxP95,
        p99: maxP99,
        stdDev: 0,
      };
    }

    // Fallback: v2 format histograms['http.response_time']
    const responseTimeHist = histograms['http.response_time'] || {};

    // v1 format: aggregate.latency
    const latency = aggregate.latency || {};

    // Merge v2 and v1, preferring v2
    return {
      min: responseTimeHist.min || latency.min || 0,
      max: responseTimeHist.max || latency.max || 0,
      mean: Math.round(responseTimeHist.mean || latency.mean || 0),
      median: responseTimeHist.median || responseTimeHist.p50 || latency.median || latency.p50 || 0,
      p90: responseTimeHist.p90 || latency.p90 || 0,
      p95: responseTimeHist.p95 || latency.p95 || 0,
      p99: responseTimeHist.p99 || latency.p99 || 0,
      stdDev: 0, // Artillery doesn't provide this directly
    };
  }

  /**
   * Normalize a URL path for matching
   * Handles: template variables ({{var}}), full URLs, leading slashes
   */
  private normalizeUrlPath(url: string): string {
    // Remove template variables like {{baseUrl}}, {{target}}
    let path = url.replace(/\{\{[^}]+\}\}/g, '');

    // If it's a full URL, extract the pathname
    if (path.startsWith('http://') || path.startsWith('https://')) {
      try {
        path = new URL(path).pathname;
      } catch {
        // If URL parsing fails, continue with the path as-is
      }
    }

    // Ensure leading slash
    if (path && !path.startsWith('/')) {
      path = '/' + path;
    }

    // Remove trailing slash (except for root)
    if (path.length > 1 && path.endsWith('/')) {
      path = path.slice(0, -1);
    }

    return path;
  }

  /**
   * Build step metrics from Artillery output or enhanced report
   * Extracts step-level metrics from Artillery's counters/histograms
   * Also maps metrics-by-endpoint plugin data to journey steps by matching URLs
   */
  private buildStepMetrics(
    enhancedData: EnhancedReportData | null,
    aggregate?: ArtilleryAggregate
  ): Map<string, StepMetrics> {
    const metrics = new Map<string, StepMetrics>();

    // Build a map of normalized endpoint URL -> step ID for metrics-by-endpoint mapping
    const endpointToStep = new Map<string, string>();
    const stepUrlMap: Record<string, string> = {}; // For debug output

    for (const step of this.options.journey.steps) {
      const normalizedPath = this.normalizeUrlPath(step.request.url);
      endpointToStep.set(normalizedPath, step.id);
      stepUrlMap[step.id] = `${step.request.url} -> ${normalizedPath}`;
    }

    if (this.options.debug) {
      console.log('\n[DEBUG] Step URL mapping:');
      for (const [stepId, mapping] of Object.entries(stepUrlMap)) {
        console.log(`  ${stepId}: ${mapping}`);
      }
    }

    // Initialize metrics for all journey steps
    for (const step of this.options.journey.steps) {
      metrics.set(step.id, {
        stepId: step.id,
        stepName: step.name || step.id,
        requestCount: 0,
        successCount: 0,
        errorCount: 0,
        latency: { min: 0, max: 0, mean: 0, median: 0, p90: 0, p95: 0, p99: 0, stdDev: 0 },
        statusCodes: new Map(),
        errorMessages: new Map(),
      });
    }

    // Extract step metrics from Artillery's counters/histograms
    if (aggregate) {
      const counters = aggregate.counters || {};
      const histograms = aggregate.histograms || {};

      // Track which steps have custom metrics (to avoid double-counting with metrics-by-endpoint)
      const stepsWithCustomMetrics = new Set<string>();

      // First try custom step.{stepId}.* metrics (if processor emits them)
      for (const [key, count] of Object.entries(counters)) {
        const statusMatch = key.match(/^step\.([^.]+)\.status\.(\d+)$/);
        if (statusMatch) {
          const [, stepId, statusCode] = statusMatch;
          const stepMetrics = metrics.get(stepId);
          if (stepMetrics) {
            stepsWithCustomMetrics.add(stepId);
            const code = parseInt(statusCode, 10);
            stepMetrics.statusCodes.set(code, count);
            stepMetrics.requestCount += count;
            if (code >= 200 && code < 300) {
              stepMetrics.successCount += count;
            } else {
              stepMetrics.errorCount += count;
            }
          }
        }
      }

      // Parse step.{stepId}.response_time histograms
      for (const [key, hist] of Object.entries(histograms)) {
        const histMatch = key.match(/^step\.([^.]+)\.response_time$/);
        if (histMatch && hist) {
          const [, stepId] = histMatch;
          const stepMetrics = metrics.get(stepId);
          if (stepMetrics) {
            stepMetrics.latency = {
              min: hist.min || 0,
              max: hist.max || 0,
              mean: Math.round(hist.mean || 0),
              median: hist.median || hist.p50 || 0,
              p90: hist.p90 || 0,
              p95: hist.p95 || 0,
              p99: hist.p99 || 0,
              stdDev: 0,
            };
          }
        }
      }

      // Fall back to metrics-by-endpoint plugin data ONLY for steps without custom metrics
      // This prevents double-counting when both data sources are available
      const endpointsFound: string[] = []; // For debug output
      const unmatchedEndpoints: string[] = []; // For debug output

      for (const [key, count] of Object.entries(counters)) {
        // Parse plugins.metrics-by-endpoint.{endpoint}.codes.{code} for HTTP status codes
        const endpointStatusMatch = key.match(/^plugins\.metrics-by-endpoint\.(.+)\.codes\.(\d+)$/);
        if (endpointStatusMatch) {
          const [, endpoint, statusCode] = endpointStatusMatch;
          const normalizedEndpoint = this.normalizeUrlPath(endpoint);

          // Track endpoints for debug output
          if (!endpointsFound.includes(normalizedEndpoint)) {
            endpointsFound.push(normalizedEndpoint);
          }

          // Try to match with normalized path
          let stepId = endpointToStep.get(normalizedEndpoint);

          // Also try without leading slash as fallback
          if (!stepId && normalizedEndpoint.startsWith('/')) {
            stepId = endpointToStep.get(normalizedEndpoint.slice(1));
          }

          if (stepId) {
            // Skip if this step already has custom metrics (prevents double-counting)
            if (stepsWithCustomMetrics.has(stepId)) {
              continue;
            }
            const stepMetrics = metrics.get(stepId);
            if (stepMetrics) {
              const code = parseInt(statusCode, 10);
              const existingCount = stepMetrics.statusCodes.get(code) || 0;
              stepMetrics.statusCodes.set(code, existingCount + count);
              stepMetrics.requestCount += count;
              if (code >= 200 && code < 300) {
                stepMetrics.successCount += count;
              } else {
                stepMetrics.errorCount += count;
              }
            }
          } else if (!unmatchedEndpoints.includes(normalizedEndpoint)) {
            unmatchedEndpoints.push(normalizedEndpoint);
          }
        }

        // Parse plugins.metrics-by-endpoint.{endpoint}.errors.{errorType} for connection errors
        const endpointErrorMatch = key.match(/^plugins\.metrics-by-endpoint\.(.+)\.errors\.(.+)$/);
        if (endpointErrorMatch) {
          const [, endpoint, errorType] = endpointErrorMatch;
          const normalizedEndpoint = this.normalizeUrlPath(endpoint);

          // Track endpoints for debug output
          if (!endpointsFound.includes(normalizedEndpoint)) {
            endpointsFound.push(normalizedEndpoint);
          }

          // Try to match with normalized path
          let stepId = endpointToStep.get(normalizedEndpoint);

          // Also try without leading slash as fallback
          if (!stepId && normalizedEndpoint.startsWith('/')) {
            stepId = endpointToStep.get(normalizedEndpoint.slice(1));
          }

          if (stepId) {
            // Skip if this step already has custom metrics (prevents double-counting)
            if (stepsWithCustomMetrics.has(stepId)) {
              continue;
            }
            const stepMetrics = metrics.get(stepId);
            if (stepMetrics) {
              stepMetrics.requestCount += count;
              stepMetrics.errorCount += count;
              // Track error message
              const existingErrorCount = stepMetrics.errorMessages.get(errorType) || 0;
              stepMetrics.errorMessages.set(errorType, existingErrorCount + count);
            }
          } else if (!unmatchedEndpoints.includes(normalizedEndpoint)) {
            unmatchedEndpoints.push(normalizedEndpoint);
          }
        }
      }

      if (this.options.debug) {
        console.log('\n[DEBUG] Artillery endpoints found:');
        for (const endpoint of endpointsFound) {
          const matched = endpointToStep.has(endpoint) ? '(matched)' : '(unmatched)';
          console.log(`  ${endpoint} ${matched}`);
        }
        if (unmatchedEndpoints.length > 0) {
          console.log('\n[DEBUG] Unmatched endpoints (no step mapping):');
          for (const endpoint of unmatchedEndpoints) {
            console.log(`  ${endpoint}`);
          }
          console.log('\n[DEBUG] Available step paths:');
          for (const [path, stepId] of endpointToStep) {
            console.log(`  ${path} -> ${stepId}`);
          }
        }
      }

      // Parse plugins.metrics-by-endpoint.response_time.{endpoint} histograms
      for (const [key, hist] of Object.entries(histograms)) {
        const endpointHistMatch = key.match(/^plugins\.metrics-by-endpoint\.response_time\.(.+)$/);
        if (endpointHistMatch && hist) {
          const [, endpoint] = endpointHistMatch;
          const normalizedEndpoint = this.normalizeUrlPath(endpoint);

          // Try to match with normalized path
          let stepId = endpointToStep.get(normalizedEndpoint);

          // Also try without leading slash as fallback
          if (!stepId && normalizedEndpoint.startsWith('/')) {
            stepId = endpointToStep.get(normalizedEndpoint.slice(1));
          }

          if (stepId) {
            const stepMetrics = metrics.get(stepId);
            // Only use if latency hasn't been set yet
            if (stepMetrics && stepMetrics.latency.mean === 0) {
              stepMetrics.latency = {
                min: hist.min || 0,
                max: hist.max || 0,
                mean: Math.round(hist.mean || 0),
                median: hist.median || hist.p50 || 0,
                p90: hist.p90 || 0,
                p95: hist.p95 || 0,
                p99: hist.p99 || 0,
                stdDev: 0,
              };
            }
          }
        }
      }
    }

    // Override with enhanced data if available (most accurate)
    if (enhancedData?.stepMetrics) {
      for (const [stepId, data] of Object.entries(enhancedData.stepMetrics)) {
        metrics.set(stepId, {
          stepId,
          stepName: data.stepId,
          requestCount: data.requestCount,
          successCount: data.successCount,
          errorCount: data.errorCount,
          latency: data.latency,
          statusCodes: new Map(Object.entries(data.statusCodes).map(([k, v]) => [parseInt(k), v])),
          errorMessages: new Map(),
        });
      }
    }

    return metrics;
  }

  /**
   * Build phase results
   */
  private buildPhases(data: ArtilleryOutput): PhaseResult[] {
    if (!data.intermediate) return [];

    // Group by phase
    const phases: PhaseResult[] = [];
    let phaseIndex = 0;

    for (const interval of data.intermediate) {
      // Each intermediate entry could be considered a phase checkpoint
      phases.push({
        name: `Phase ${++phaseIndex}`,
        duration: 10000, // Default 10s intervals
        arrivalRate: interval.scenariosCreated || 0,
        actualRate: (interval.scenariosCreated || 0) / 10,
        completedUsers: interval.scenariosCompleted || 0,
        failedUsers: (interval.scenariosCreated || 0) - (interval.scenariosCompleted || 0),
      });
    }

    return phases;
  }

  /**
   * Build error summary
   */
  private buildErrors(
    aggregate: ArtilleryAggregate,
    enhancedData: EnhancedReportData | null
  ): ErrorSummary[] {
    const errors: ErrorSummary[] = [];

    // From Artillery aggregate errors
    if (aggregate.errors) {
      for (const [message, count] of Object.entries(aggregate.errors)) {
        errors.push({
          stepId: 'unknown',
          errorType: this.classifyError(message),
          message,
          count: count as number,
          firstOccurrence: new Date(),
          lastOccurrence: new Date(),
        });
      }
    }

    return errors;
  }

  /**
   * Classify error type from message
   */
  private classifyError(message: string): ErrorSummary['errorType'] {
    const lower = message.toLowerCase();
    if (lower.includes('timeout')) return 'timeout';
    if (lower.includes('connect') || lower.includes('econnrefused')) return 'connection';
    if (lower.includes('status') || lower.includes('4') || lower.includes('5')) return 'status_code';
    if (lower.includes('extract')) return 'extraction';
    if (lower.includes('valid')) return 'validation';
    return 'unknown';
  }

  /**
   * Build threshold results
   * Supports both Artillery v2 (counters/histograms) and v1 (flat) formats
   */
  private buildThresholdResults(aggregate: ArtilleryAggregate): ThresholdResult[] {
    const results: ThresholdResult[] = [];
    const thresholds = this.options.thresholds;

    if (!thresholds) return results;

    // Get latency from v2 histograms or v1 latency object
    const histograms = aggregate.histograms || {};
    const responseTimeHist = histograms['http.response_time'] || {};
    const latency = aggregate.latency || {};
    const lat = {
      p50: responseTimeHist.p50 || responseTimeHist.median || latency.p50 || latency.median || 0,
      p95: responseTimeHist.p95 || latency.p95 || 0,
      p99: responseTimeHist.p99 || latency.p99 || 0,
    };

    if (thresholds.p50ResponseTime !== undefined) {
      results.push({
        metric: 'p50 Response Time',
        threshold: thresholds.p50ResponseTime,
        actual: lat.p50,
        passed: lat.p50 <= thresholds.p50ResponseTime,
        unit: 'ms',
      });
    }

    if (thresholds.p95ResponseTime !== undefined) {
      results.push({
        metric: 'p95 Response Time',
        threshold: thresholds.p95ResponseTime,
        actual: lat.p95,
        passed: lat.p95 <= thresholds.p95ResponseTime,
        unit: 'ms',
      });
    }

    if (thresholds.p99ResponseTime !== undefined) {
      results.push({
        metric: 'p99 Response Time',
        threshold: thresholds.p99ResponseTime,
        actual: lat.p99,
        passed: lat.p99 <= thresholds.p99ResponseTime,
        unit: 'ms',
      });
    }

    if (thresholds.maxErrorRate !== undefined) {
      // Use consistent error calculation with buildSummary():
      // Only count HTTP failures (4xx, 5xx) and network errors, NOT extraction errors
      const counters = aggregate.counters || {};
      const totalRequests = counters['http.requests'] || aggregate.requestsCompleted || 0;

      // Extract HTTP status codes from counters
      let clientErrors = 0;
      let serverErrors = 0;
      for (const [key, value] of Object.entries(counters)) {
        if (key.startsWith('http.codes.')) {
          const code = parseInt(key.replace('http.codes.', ''), 10);
          if (!isNaN(code)) {
            if (code >= 400 && code < 500) {
              clientErrors += value;
            } else if (code >= 500) {
              serverErrors += value;
            }
          }
        }
      }

      // Also check legacy codes format
      if (aggregate.codes) {
        for (const [code, count] of Object.entries(aggregate.codes)) {
          const codeNum = parseInt(code, 10);
          if (!isNaN(codeNum)) {
            if (codeNum >= 400 && codeNum < 500) {
              clientErrors += count;
            } else if (codeNum >= 500) {
              serverErrors += count;
            }
          }
        }
      }

      // Count network errors only (same logic as buildSummary)
      const networkErrorPatterns = [
        'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND',
        'EHOSTUNREACH', 'ENETUNREACH', 'socket hang up',
        'connect ECONNREFUSED', 'ESOCKETTIMEDOUT', 'EPROTO', 'EPIPE',
      ];

      let connectionErrors = 0;
      for (const [key, value] of Object.entries(counters)) {
        if (key.startsWith('errors.')) {
          const errorMessage = key.replace('errors.', '');
          const isNetworkError = networkErrorPatterns.some(pattern =>
            errorMessage.toUpperCase().includes(pattern.toUpperCase())
          );
          if (isNetworkError) {
            connectionErrors += value;
          }
        }
      }

      // Total HTTP failures = 4xx + 5xx + network errors (consistent with summary)
      const failedRequests = clientErrors + serverErrors + connectionErrors;
      const errorRate = totalRequests > 0 ? failedRequests / totalRequests : 0;

      results.push({
        metric: 'Error Rate',
        threshold: thresholds.maxErrorRate * 100,
        actual: Math.round(errorRate * 10000) / 100,
        passed: errorRate <= thresholds.maxErrorRate,
        unit: '%',
      });
    }

    return results;
  }

  /**
   * Build profile metrics from Artillery output or enhanced report
   * Extracts profile data from Artillery's journey.profile.{name} counters
   */
  private buildProfileMetrics(
    enhancedData: EnhancedReportData | null,
    aggregate?: ArtilleryAggregate
  ): ProfileMetrics[] {
    const profiles: Record<string, number> = {};

    // Extract profile counts from Artillery's counters
    if (aggregate?.counters) {
      for (const [key, count] of Object.entries(aggregate.counters)) {
        const profileMatch = key.match(/^journey\.profile\.(.+)$/);
        if (profileMatch) {
          const [, profileName] = profileMatch;
          profiles[profileName] = count;
        }
      }
    }

    // Override with enhanced data if available
    if (enhancedData?.profiles) {
      Object.assign(profiles, enhancedData.profiles);
    }

    if (Object.keys(profiles).length === 0) return [];

    const total = Object.values(profiles).reduce((a, b) => a + b, 0);

    // Get journey duration from histograms if available
    let avgJourneyTime = 0;
    if (aggregate?.histograms?.['journey.duration']) {
      avgJourneyTime = aggregate.histograms['journey.duration'].mean || 0;
    } else if (enhancedData?.journeyDurations?.mean) {
      avgJourneyTime = enhancedData.journeyDurations.mean;
    }

    return Object.entries(profiles).map(([name, count]) => ({
      profileName: name,
      weight: 0, // Would need profile config to know target weight
      actualPercentage: total > 0 ? count / total : 0,
      userCount: count,
      completedJourneys: count, // Simplified
      failedJourneys: 0,
      avgJourneyTime,
    }));
  }
}

// Types for Artillery output (v2 format)
interface ArtilleryOutput {
  aggregate?: ArtilleryAggregate;
  intermediate?: ArtilleryAggregate[];
}

interface ArtilleryAggregate {
  // New v2 format uses nested objects
  counters?: Record<string, number>;
  rates?: Record<string, number>;
  histograms?: Record<string, {
    min?: number;
    max?: number;
    mean?: number;
    median?: number;
    p50?: number;
    p90?: number;
    p95?: number;
    p99?: number;
  }>;
  summaries?: Record<string, unknown>;

  // Legacy v1 format (for backwards compatibility)
  scenariosCreated?: number;
  scenariosCompleted?: number;
  requestsCompleted?: number;
  latency?: {
    min?: number;
    max?: number;
    mean?: number;
    median?: number;
    p50?: number;
    p90?: number;
    p95?: number;
    p99?: number;
  };
  rps?: {
    mean?: number;
    max?: number;
  };
  codes?: Record<string, number>;
  errors?: Record<string, number>;

  firstCounterAt?: number;
  lastCounterAt?: number;
}

interface EnhancedReportData {
  stepMetrics?: Record<string, {
    stepId: string;
    requestCount: number;
    successCount: number;
    errorCount: number;
    latency: LatencyMetrics;
    statusCodes: Record<string, number>;
  }>;
  profiles?: Record<string, number>;
  journeyDurations?: {
    mean?: number;
  };
}

/**
 * Convenience function to build report data
 */
export async function buildReportData(
  artilleryOutputPath: string,
  options: BuilderOptions
): Promise<ReportData> {
  const builder = new ReportDataBuilder(options);
  return builder.build(artilleryOutputPath);
}
