/**
 * Artillery Processor
 * Hook functions for Artillery's beforeRequest/afterResponse lifecycle
 * This is where conditional branching and data extraction happen
 *
 * IMPORTANT: All state is stored per-VU in context.vars to avoid race conditions.
 * Artillery shares the processor module across all concurrent VUs, so module-level
 * variables would cause race conditions when multiple VUs run simultaneously.
 */

import type { EventEmitter } from 'events';
import type { Journey, Step, StepResponse, ThinkTime } from '../types/index.js';
import { FlowEngine } from '../core/flow-engine.js';
import { DataExtractor } from '../core/data-extractor.js';
import { ProfileDistributor } from '../core/profile-distributor.js';
import { interpolateObject } from '../utils/template.js';

// Template marker escape sequences (must match script-generator.ts)
const TEMPLATE_OPEN_MARKER = '__SHIELD_VAR_OPEN__';
const TEMPLATE_CLOSE_MARKER = '__SHIELD_VAR_CLOSE__';

/**
 * Recursively unescape template markers in an object
 * Replaces __SHIELD_VAR_OPEN__ with {{ and __SHIELD_VAR_CLOSE__ with }}
 */
function unescapeTemplateMarkers(obj: unknown): unknown {
  if (obj === null || obj === undefined) {
    return obj;
  }

  if (typeof obj === 'string') {
    return obj
      .replace(new RegExp(TEMPLATE_OPEN_MARKER, 'g'), '{{')
      .replace(new RegExp(TEMPLATE_CLOSE_MARKER, 'g'), '}}');
  }

  if (Array.isArray(obj)) {
    return obj.map((item) => unescapeTemplateMarkers(item));
  }

  if (typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = unescapeTemplateMarkers(value);
    }
    return result;
  }

  return obj;
}

// Artillery context type (simplified)
interface ArtilleryContext {
  vars: Record<string, unknown>;
  scenario: {
    name: string;
    weight: number;
  };
}

// Artillery request parameters
interface ArtilleryRequestParams {
  url: string;
  method: string;
  headers: Record<string, string>;
  json?: Record<string, unknown>;
  body?: string;
  // Custom metadata we add
  __stepId?: string;
  __stepName?: string;
}

// Artillery response
interface ArtilleryResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: unknown;
  timings: {
    phases: {
      total: number;
      wait: number;
      dns: number;
      tcp: number;
      firstByte: number;
      download: number;
    };
  };
}

/**
 * Per-VU state stored in context.vars
 * Each VU gets its own initialized state to avoid race conditions
 */
interface VUState {
  journey: Journey;
  flowEngine: FlowEngine;
  profileDistributor: ProfileDistributor | null;
}

// Shared DataExtractor (stateless, thread-safe)
let sharedDataExtractor: DataExtractor | null = null;
function getDataExtractor(): DataExtractor {
  if (!sharedDataExtractor) {
    sharedDataExtractor = new DataExtractor();
  }
  return sharedDataExtractor;
}

// Shared ProfileDistributor (stateful but thread-safe via atomic operations)
// This is initialized once from __profiles or __profileDistributor
let sharedProfileDistributor: ProfileDistributor | null = null;
let profileDistributorInitialized = false;

/**
 * Get or initialize the shared ProfileDistributor
 * Thread-safe: only initializes once, subsequent calls return cached instance
 */
function getProfileDistributor(context: ArtilleryContext): ProfileDistributor | null {
  if (profileDistributorInitialized) {
    return sharedProfileDistributor;
  }

  // Initialize from context
  if (context.vars.__profileDistributor) {
    sharedProfileDistributor = context.vars.__profileDistributor as ProfileDistributor;
  } else if (context.vars.__profiles) {
    const profileConfig = unescapeTemplateMarkers(context.vars.__profiles) as import('../types/index.js').ProfileConfig;
    sharedProfileDistributor = new ProfileDistributor(profileConfig);
    sharedProfileDistributor.loadDataSync();
  }

  profileDistributorInitialized = true;
  return sharedProfileDistributor;
}

/**
 * Get or create VU-specific state from context
 * This ensures each VU has its own journey and flowEngine instances
 * to avoid race conditions during concurrent execution.
 */
function getVUState(context: ArtilleryContext): VUState | null {
  // Check if already initialized for this VU
  if (context.vars.__shieldVUState) {
    return context.vars.__shieldVUState as VUState;
  }

  // Get journey data from Artillery config.variables
  const journeyData = context.vars.__journey;
  if (!journeyData) {
    return null;
  }

  // Create VU-specific state
  const journey = unescapeTemplateMarkers(journeyData) as Journey;
  const flowEngine = new FlowEngine(journey);
  const profileDistributor = getProfileDistributor(context);

  const vuState: VUState = {
    journey,
    flowEngine,
    profileDistributor,
  };

  // Store in context for this VU
  context.vars.__shieldVUState = vuState;
  return vuState;
}

/**
 * Initialize processor with journey and dependencies
 * Called by Artillery via config.processor
 * Note: context.vars may not contain config.variables at this point
 */
export function initialize(
  context: ArtilleryContext,
  events: EventEmitter,
  done: () => void
): void {
  // Initialize VU state if possible (might not have journey yet)
  getVUState(context);
  done();
}

/**
 * Set up user context for this virtual user
 * Called at the start of each scenario iteration
 */
export function setupUser(
  context: ArtilleryContext,
  events: EventEmitter,
  done: () => void
): void {
  // Ensure VU state is initialized
  const vuState = getVUState(context);

  // Get user data from profile distributor
  if (vuState?.profileDistributor) {
    const userContext = vuState.profileDistributor.getNextUser();

    // Merge user data into context
    context.vars.user = userContext.userData;
    context.vars.profile = userContext.profileName;

    // Add generated values
    for (const [key, value] of Object.entries(userContext.generatedValues)) {
      context.vars[key] = value;
    }

    // Add static profile variables
    for (const [key, value] of Object.entries(userContext.variables)) {
      context.vars[key] = value;
    }
  }

  // Initialize flow state
  context.vars.__executedSteps = [];
  context.vars.__currentPath = [];
  context.vars.__journeyStartTime = Date.now();

  done();
}

/**
 * Before request hook
 * Handles variable interpolation and request preparation
 */
export function beforeRequest(
  requestParams: ArtilleryRequestParams,
  context: ArtilleryContext,
  ee: EventEmitter,
  next: () => void
): void {
  // Get VU-specific state
  const vuState = getVUState(context);
  if (!vuState) {
    next();
    return;
  }

  const { journey, flowEngine } = vuState;

  const stepId = requestParams.__stepId;
  if (!stepId) {
    next();
    return;
  }

  const step = flowEngine.getStep(stepId);
  if (!step) {
    next();
    return;
  }

  // Build interpolation context
  const interpolationContext = buildInterpolationContext(context);

  // Interpolate URL
  requestParams.url = interpolateObject(requestParams.url, interpolationContext);

  // Merge and interpolate headers
  // IMPORTANT: Use headers from journey definition, not from Artillery's processed requestParams
  // Artillery may have already processed template variables before this hook runs
  const defaultHeaders = journey.defaults?.headers || {};
  const stepHeaders = step.request.headers || {};
  const existingHeaders = requestParams.headers || {};
  requestParams.headers = {
    ...interpolateObject(defaultHeaders, interpolationContext),
    ...interpolateObject(stepHeaders, interpolationContext),
    // Only keep non-template headers from Artillery (like user-agent)
    ...Object.fromEntries(
      Object.entries(existingHeaders).filter(
        ([key]) => !key.toLowerCase().startsWith('content-')
      )
    ),
  };

  // Interpolate JSON body
  // IMPORTANT: The script generator adds an empty `json: {}` placeholder for POST requests with JSON body.
  // This tells Artillery to prepare a JSON request. Here in beforeRequest, we replace the empty body
  // with properly interpolated values from the journey definition (stored in config.variables.__journey).
  // This ensures variables like {{user.email}} are interpolated with actual user data loaded in setupUser.
  // NOTE: We must set BOTH requestParams.json AND requestParams.body because Artillery serializes
  // the json to body BEFORE calling beforeRequest. Simply modifying json won't update the actual body.
  if (step.request.json) {
    // Deep clone and interpolate the original step body from journey definition
    const originalBody = JSON.parse(JSON.stringify(step.request.json));
    const interpolatedBody = interpolateObject(originalBody, interpolationContext);
    requestParams.json = interpolatedBody;
    // Also set the stringified body to ensure Artillery sends the correct payload
    requestParams.body = JSON.stringify(interpolatedBody);
  }

  // Interpolate string body from journey definition
  if (step.request.body && typeof step.request.body === 'string') {
    requestParams.body = interpolateObject(step.request.body, interpolationContext);
  }

  // Record step start
  context.vars.__currentStepId = stepId;
  context.vars.__stepStartTime = Date.now();

  next();
}

/**
 * After response hook
 * Handles data extraction and branch evaluation
 */
export function afterResponse(
  requestParams: ArtilleryRequestParams,
  response: ArtilleryResponse,
  context: ArtilleryContext,
  ee: EventEmitter,
  next: () => void
): void {
  // Get VU-specific state
  const vuState = getVUState(context);
  const dataExtractor = getDataExtractor();

  if (!vuState) {
    next();
    return;
  }

  const { flowEngine } = vuState;

  const stepId = requestParams.__stepId;
  if (!stepId) {
    next();
    return;
  }

  const step = flowEngine.getStep(stepId);
  if (!step) {
    next();
    return;
  }

  // Build step response object
  const stepResponse: StepResponse = {
    statusCode: response.statusCode,
    headers: response.headers,
    body: response.body,
    responseTime: response.timings.phases.total,
  };

  // Execute extractions
  if (step.extract && step.extract.length > 0) {
    const { variables, errors } = dataExtractor.extractAll(step.extract, stepResponse);

    // Store extracted values in context
    for (const [key, value] of Object.entries(variables)) {
      context.vars[key] = value;
    }

    // Log extraction errors (but don't fail)
    if (errors.length > 0) {
      ee.emit('counter', `extraction.errors.${stepId}`, errors.length);
    }
  }

  // Evaluate branches and determine next step
  const flowState = {
    currentStepId: stepId,
    variables: context.vars,
    executedSteps: (context.vars.__executedSteps as string[]) || [],
  };

  const branchResult = flowEngine.evaluateBranches(step, stepResponse, flowState);

  // Set next step for conditional execution
  context.vars.__nextStep = branchResult.nextStepId;

  // Track executed steps and path
  const executedSteps = context.vars.__executedSteps as string[];
  executedSteps.push(stepId);

  const currentPath = context.vars.__currentPath as string[];
  currentPath.push(stepId);

  // Emit step-level metrics
  ee.emit('histogram', `step.${stepId}.response_time`, stepResponse.responseTime);
  ee.emit('counter', `step.${stepId}.status.${response.statusCode}`, 1);

  if (branchResult.matched && branchResult.nextStepId) {
    ee.emit('counter', `step.${stepId}.branch.${branchResult.nextStepId}`, 1);
  }

  next();
}

/**
 * Check if a step should execute based on flow state
 * Used by Artillery's ifTrue condition
 * IMPORTANT: This may be called BEFORE beforeScenario (setupUser), so we must
 * ensure VU state is initialized from context.vars.__journey here.
 */
export function shouldExecuteStep(
  context: ArtilleryContext,
  stepId: string
): boolean {
  // CRITICAL: Get VU state - ifTrue is evaluated before beforeScenario
  const vuState = getVUState(context);
  if (!vuState) {
    return false;
  }

  const { journey } = vuState;
  const nextStep = context.vars.__nextStep as string | undefined;
  const executedSteps = (context.vars.__executedSteps as string[]) || [];

  // First step always executes
  if (executedSteps.length === 0) {
    const firstStep = journey.steps[0];
    return stepId === firstStep?.id;
  }

  // Step already executed
  if (executedSteps.includes(stepId)) {
    return false;
  }

  // Check if this is the expected next step
  if (nextStep) {
    return stepId === nextStep;
  }

  // No next step set - journey complete
  return false;
}

/**
 * Generate ifTrue function for a specific step
 * Returns a function that Artillery can call
 */
export function createStepCondition(stepId: string): (context: ArtilleryContext) => boolean {
  return (context: ArtilleryContext) => shouldExecuteStep(context, stepId);
}

/**
 * Calculate think time
 */
export function getThinkTime(thinkTime: ThinkTime | undefined): number {
  if (!thinkTime) return 0;

  if (typeof thinkTime === 'number') {
    return thinkTime;
  }

  // Random between min and max
  return Math.floor(Math.random() * (thinkTime.max - thinkTime.min + 1)) + thinkTime.min;
}

/**
 * Think time function for Artillery
 */
export function think(
  context: ArtilleryContext,
  events: EventEmitter,
  done: () => void
): void {
  const stepId = context.vars.__currentStepId as string;
  const vuState = getVUState(context);

  if (!stepId || !vuState) {
    done();
    return;
  }

  const { journey, flowEngine } = vuState;
  const step = flowEngine.getStep(stepId);
  const thinkTime = step?.thinkTime || journey.defaults?.thinkTime;

  if (!thinkTime) {
    done();
    return;
  }

  const delay = getThinkTime(thinkTime);
  setTimeout(done, delay * 1000); // Convert to milliseconds
}

/**
 * Cleanup at end of scenario
 */
export function cleanup(
  context: ArtilleryContext,
  events: EventEmitter,
  done: () => void
): void {
  const journeyStartTime = context.vars.__journeyStartTime as number;
  if (journeyStartTime) {
    const journeyDuration = Date.now() - journeyStartTime;
    events.emit('histogram', 'journey.duration', journeyDuration);
  }

  const profile = context.vars.profile as string;
  if (profile) {
    events.emit('counter', `journey.profile.${profile}`, 1);
  }

  const currentPath = context.vars.__currentPath as string[];
  if (currentPath) {
    events.emit('counter', `journey.path.${currentPath.join('->')}`, 1);
  }

  done();
}

/**
 * Build context for variable interpolation
 */
function buildInterpolationContext(context: ArtilleryContext): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  // Copy all context vars
  for (const [key, value] of Object.entries(context.vars)) {
    // Skip internal variables
    if (!key.startsWith('__')) {
      result[key] = value;
    }
  }

  // Add built-in generators
  result.$uuid = crypto.randomUUID();
  result.$timestamp = Date.now();
  result.$isoTimestamp = new Date().toISOString();

  return result;
}

/**
 * Export processor functions for Artillery config
 */
export const processorFunctions = {
  initialize,
  setupUser,
  beforeRequest,
  afterResponse,
  shouldExecuteStep,
  think,
  cleanup,
};
