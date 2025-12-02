/**
 * Report Types
 * Data structures for test results and reporting
 */

export interface ReportData {
  metadata: ReportMetadata;
  summary: TestSummary;
  latency: LatencyMetrics;
  stepMetrics: Map<string, StepMetrics>;
  phases: PhaseResult[];
  errors: ErrorSummary[];
  thresholdResults: ThresholdResult[];
  profiles: ProfileMetrics[];
}

export interface ReportMetadata {
  testName: string;
  journeyId: string;
  journeyName: string;
  environment: string;
  startTime: Date;
  endTime: Date;
  duration: number;
  version: string;
}

export interface TestSummary {
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  errorRate: number;
  throughput: number;
  virtualUsers: VirtualUserStats;
}

export interface VirtualUserStats {
  total: number;
  completed: number;
  failed: number;
}

export interface LatencyMetrics {
  min: number;
  max: number;
  mean: number;
  median: number;
  p90: number;
  p95: number;
  p99: number;
  stdDev: number;
}

export interface StepMetrics {
  stepId: string;
  stepName: string;
  requestCount: number;
  successCount: number;
  errorCount: number;
  latency: LatencyMetrics;
  statusCodes: Map<number, number>;
  errorMessages: Map<string, number>;
}

export interface PhaseResult {
  name: string;
  duration: number;
  arrivalRate: number;
  actualRate: number;
  completedUsers: number;
  failedUsers: number;
}

export interface ErrorSummary {
  stepId: string;
  errorType: ErrorType;
  message: string;
  count: number;
  firstOccurrence: Date;
  lastOccurrence: Date;
}

export type ErrorType =
  | 'timeout'
  | 'connection'
  | 'status_code'
  | 'extraction'
  | 'validation'
  | 'unknown';

export interface ThresholdResult {
  metric: string;
  threshold: number;
  actual: number;
  passed: boolean;
  unit: string;
}

export interface ProfileMetrics {
  profileName: string;
  weight: number;
  actualPercentage: number;
  userCount: number;
  completedJourneys: number;
  failedJourneys: number;
  avgJourneyTime: number;
}

/**
 * Chart data for HTML reports
 */
export interface ChartData {
  latencyDistribution: {
    labels: string[];
    data: number[];
  };
  stepComparison: {
    labels: string[];
    datasets: ChartDataset[];
  };
  throughputOverTime: {
    labels: string[];
    data: number[];
  };
  errorsByStep: {
    labels: string[];
    data: number[];
  };
}

export interface ChartDataset {
  label: string;
  data: number[];
  backgroundColor?: string;
  borderColor?: string;
}
