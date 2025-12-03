/**
 * Artillery Processor
 * Hook functions for Artillery's beforeRequest/afterResponse lifecycle
 * This is where conditional branching and data extraction happen
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
 * Processor state - initialized per scenario
 */
let journey: Journey | null = null;
let flowEngine: FlowEngine | null = null;
let dataExtractor: DataExtractor | null = null;
let profileDistributor: ProfileDistributor | null = null;

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
  // Try to get journey from context (might not be available yet)
  if (context.vars.__journey && !journey) {
    journey = context.vars.__journey as Journey;
    flowEngine = new FlowEngine(journey);
  }

  if (!dataExtractor) {
    dataExtractor = new DataExtractor();
  }

  // Get profile distributor if available
  if (context.vars.__profileDistributor && !profileDistributor) {
    profileDistributor = context.vars.__profileDistributor as ProfileDistributor | null;
  }

  done();
}

/**
 * Ensure journey is initialized from context
 * Called at the start of scenario execution when config.variables are available
 * IMPORTANT: Template markers are escaped in the YAML to prevent Artillery from
 * processing {{...}} variables. We unescape them here to restore the original templates.
 */
function ensureJourneyInitialized(context: ArtilleryContext): void {
  if (!journey && context.vars.__journey) {
    // Unescape template markers that were escaped in script-generator to prevent
    // Artillery's template engine from processing them at YAML load time
    journey = unescapeTemplateMarkers(context.vars.__journey) as Journey;
    flowEngine = new FlowEngine(journey);
  }
  if (!dataExtractor) {
    dataExtractor = new DataExtractor();
  }
  // Handle both __profileDistributor (instantiated) and __profiles (raw config)
  if (!profileDistributor) {
    if (context.vars.__profileDistributor) {
      profileDistributor = context.vars.__profileDistributor as ProfileDistributor;
    } else if (context.vars.__profiles) {
      // Create ProfileDistributor from raw profiles config passed via script generator
      // Note: loadDataSync() only works for inline data (profile.data), not file-based dataSource
      // Also unescape any template markers in profile data
      const profileConfig = unescapeTemplateMarkers(context.vars.__profiles) as import('../types/index.js').ProfileConfig;
      profileDistributor = new ProfileDistributor(profileConfig);
      profileDistributor.loadDataSync(); // Load inline data synchronously
    }
  }
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
  // Ensure journey is initialized (config.variables now available)
  ensureJourneyInitialized(context);

  // Get user data from profile distributor
  if (profileDistributor) {
    const userContext = profileDistributor.getNextUser();

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
  // Ensure journey is initialized
  ensureJourneyInitialized(context);

  if (!journey) {
    next();
    return;
  }

  const stepId = requestParams.__stepId;
  if (!stepId) {
    next();
    return;
  }

  const step = flowEngine?.getStep(stepId);
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
  if (step.request.json) {
    // Deep clone and interpolate the original step body from journey definition
    const originalBody = JSON.parse(JSON.stringify(step.request.json));
    const interpolatedBody = interpolateObject(originalBody, interpolationContext);
    requestParams.json = interpolatedBody;
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
  if (!journey || !flowEngine || !dataExtractor) {
    next();
    return;
  }

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
 * ensure journey is initialized from context.vars.__journey here.
 */
export function shouldExecuteStep(
  context: ArtilleryContext,
  stepId: string
): boolean {
  // CRITICAL: Initialize journey from context - ifTrue is evaluated before beforeScenario
  ensureJourneyInitialized(context);

  const nextStep = context.vars.__nextStep as string | undefined;
  const executedSteps = (context.vars.__executedSteps as string[]) || [];

  // First step always executes
  if (executedSteps.length === 0 && journey) {
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
  if (!stepId || !journey) {
    done();
    return;
  }

  const step = flowEngine?.getStep(stepId);
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
