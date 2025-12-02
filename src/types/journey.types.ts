/**
 * Journey Definition Types
 * Defines the structure for API journey orchestration
 */

export interface Journey {
  id: string;
  name: string;
  description?: string;
  version?: string;
  baseUrl?: string;
  defaults?: JourneyDefaults;
  variables?: Record<string, unknown>;
  steps: Step[];
}

export interface JourneyDefaults {
  headers?: Record<string, string>;
  timeout?: number;
  thinkTime?: ThinkTime;
}

export type ThinkTime = number | { min: number; max: number };

export interface Step {
  id: string;
  name?: string;
  request: Request;
  extract?: Extraction[];
  thinkTime?: ThinkTime;
  branches?: Branch[];
  onSuccess?: string;
  onFailure?: string;
}

export interface Request {
  method: HttpMethod;
  url: string;
  headers?: Record<string, string>;
  json?: Record<string, unknown>;
  body?: string;
  queryParams?: Record<string, string>;
  timeout?: number;
  expect?: Expectations;
}

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';

export interface Extraction {
  type?: ExtractionType;
  path: string;
  as: string;
  default?: unknown;
  transform?: string;
}

export type ExtractionType = 'jsonpath' | 'header' | 'regex' | 'status';

export interface Branch {
  condition: Condition;
  goto: string;
}

export interface Condition {
  field?: string;
  status?: number;
  header?: string;
  eq?: unknown;
  ne?: unknown;
  gt?: number;
  gte?: number;
  lt?: number;
  lte?: number;
  contains?: string;
  matches?: string;
  exists?: boolean;
  in?: unknown[];
}

export interface Expectations {
  statusCode?: number | number[];
  contentType?: string;
  hasFields?: string[];
  maxResponseTime?: number;
}

/**
 * Runtime types for journey execution
 */
export interface StepExecutionContext {
  stepId: string;
  variables: Record<string, unknown>;
  response?: StepResponse;
  startTime: number;
  endTime?: number;
}

export interface StepResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: unknown;
  responseTime: number;
}

export interface JourneyExecutionState {
  journeyId: string;
  currentStepId: string;
  variables: Record<string, unknown>;
  executedSteps: StepExecutionContext[];
  branchPath: string[];
  startTime: number;
  status: 'running' | 'completed' | 'failed';
  error?: string;
}
