/**
 * Artillery Script Generator
 * Converts journey JSON to Artillery-compatible YAML configuration
 */

import { stringify as yamlStringify } from 'yaml';
import type {
  Journey,
  Step,
  ProfileConfig,
  EnvironmentConfig,
  ThinkTime,
} from '../types/index.js';
import { FlowEngine } from '../core/flow-engine.js';

// Template marker escape sequences
// Artillery's template engine processes {{...}} at YAML load time, which corrupts our templates
// We escape them to markers that Artillery won't process, then unescape in the processor
const TEMPLATE_OPEN_MARKER = '__SHIELD_VAR_OPEN__';
const TEMPLATE_CLOSE_MARKER = '__SHIELD_VAR_CLOSE__';

/**
 * Recursively escape template markers in an object
 * Replaces {{ with __SHIELD_VAR_OPEN__ and }} with __SHIELD_VAR_CLOSE__
 */
function escapeTemplateMarkers(obj: unknown): unknown {
  if (obj === null || obj === undefined) {
    return obj;
  }

  if (typeof obj === 'string') {
    return obj
      .replace(/\{\{/g, TEMPLATE_OPEN_MARKER)
      .replace(/\}\}/g, TEMPLATE_CLOSE_MARKER);
  }

  if (Array.isArray(obj)) {
    return obj.map((item) => escapeTemplateMarkers(item));
  }

  if (typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = escapeTemplateMarkers(value);
    }
    return result;
  }

  return obj;
}

export interface GeneratedScript {
  yaml: string;
  config: ArtilleryConfig;
  scenarios: ArtilleryScenario[];
}

export interface ArtilleryConfig {
  target: string;
  phases: ArtilleryPhase[];
  processor: string;
  variables?: Record<string, unknown>;
  http?: {
    timeout?: number;
    pool?: number;
  };
}

export interface ArtilleryPhase {
  name?: string;
  duration: string | number;
  arrivalRate?: number;
  rampTo?: number;
  maxVusers?: number;
  pause?: string | number;
}

export interface ArtilleryScenario {
  name: string;
  weight?: number;
  beforeScenario?: string;
  afterScenario?: string;
  flow: ArtilleryFlowItem[];
}

export type ArtilleryFlowItem =
  | { function: string }
  | { think: number | string }
  | { get: ArtilleryRequest }
  | { post: ArtilleryRequest }
  | { put: ArtilleryRequest }
  | { patch: ArtilleryRequest }
  | { delete: ArtilleryRequest };

export interface ArtilleryRequest {
  url: string;
  headers?: Record<string, string>;
  json?: Record<string, unknown>;
  body?: string;
  beforeRequest?: string;
  afterResponse?: string;
  ifTrue?: string;
  capture?: ArtilleryCapture[];
}

export interface ArtilleryCapture {
  json?: string;
  header?: string;
  as: string;
}

export class ScriptGenerator {
  private journey: Journey;
  private profiles?: ProfileConfig;
  private environment: EnvironmentConfig;
  private flowEngine: FlowEngine;
  private profileJourneys: Map<string, Journey>;

  constructor(
    journey: Journey,
    environment: EnvironmentConfig,
    profiles?: ProfileConfig,
    profileJourneys?: Map<string, Journey>
  ) {
    this.journey = journey;
    this.environment = environment;
    this.profiles = profiles;
    this.profileJourneys = profileJourneys || new Map();
    this.flowEngine = new FlowEngine(journey);
  }

  /**
   * Generate complete Artillery script
   */
  generate(): GeneratedScript {
    const config = this.buildConfig();
    const scenarios = this.buildScenarios();

    const script = {
      config,
      scenarios,
    };

    return {
      yaml: yamlStringify(script),
      config,
      scenarios,
    };
  }

  /**
   * Build Artillery config section
   * Note: Step metrics are collected via processor and extracted from Artillery's output
   */
  private buildConfig(): ArtilleryConfig {
    // Escape template markers in journey and profiles to prevent Artillery from processing them
    // Artillery's template engine would convert {{user.email}} to "" at YAML load time
    const escapedJourney = escapeTemplateMarkers(this.journey);
    const escapedProfiles = this.profiles ? escapeTemplateMarkers(this.profiles) : undefined;

    const config: ArtilleryConfig = {
      target: this.journey.baseUrl || this.environment.target.baseUrl,
      phases: this.buildPhases(),
      processor: './processor.cjs',
      variables: {
        __journey: escapedJourney,
        __profiles: escapedProfiles,
      },
    };

    // HTTP settings
    if (this.environment.http || this.journey.defaults?.timeout) {
      config.http = {};
      if (this.environment.http?.timeout || this.journey.defaults?.timeout) {
        config.http.timeout = this.environment.http?.timeout || this.journey.defaults?.timeout;
      }
      if (this.environment.http?.pool) {
        config.http.pool = this.environment.http.pool;
      }
    }

    return config;
  }

  /**
   * Build load phases from environment config
   */
  private buildPhases(): ArtilleryPhase[] {
    if (!this.environment.load?.phases) {
      // Default single phase
      return [
        {
          duration: '1m',
          arrivalRate: 1,
        },
      ];
    }

    return this.environment.load.phases.map((phase) => {
      const artilleryPhase: ArtilleryPhase = {
        duration: phase.duration,
      };

      if (phase.name) artilleryPhase.name = phase.name;
      if (phase.arrivalRate) artilleryPhase.arrivalRate = phase.arrivalRate;
      if (phase.rampTo) artilleryPhase.rampTo = phase.rampTo;
      if (phase.maxVusers) artilleryPhase.maxVusers = phase.maxVusers;
      if (phase.pause) artilleryPhase.pause = phase.pause;

      return artilleryPhase;
    });
  }

  /**
   * Build scenarios from profiles or single default scenario
   */
  private buildScenarios(): ArtilleryScenario[] {
    if (this.profiles && this.profiles.profiles.length > 0) {
      // Create weighted scenario per profile
      return this.profiles.profiles.map((profile) => {
        // Use profile-specific journey if available, otherwise use default
        const profileJourney = this.profileJourneys.get(profile.name) || this.journey;

        return {
          name: `${profileJourney.name} - ${profile.name}`,
          weight: profile.weight,
          beforeScenario: 'setupUser',
          afterScenario: 'cleanup',
          flow: this.buildFlowForJourney(profileJourney),
        };
      });
    }

    // Single default scenario
    return [
      {
        name: this.journey.name,
        beforeScenario: 'setupUser',
        afterScenario: 'cleanup',
        flow: this.buildFlowForJourney(this.journey),
      },
    ];
  }

  /**
   * Build flow array from journey steps
   */
  private buildFlowForJourney(journey: Journey): ArtilleryFlowItem[] {
    const flow: ArtilleryFlowItem[] = [];

    for (const step of journey.steps) {
      // Add the request step with conditional execution
      flow.push(this.buildStepRequest(step));

      // Add think time after step if configured
      const thinkTime = step.thinkTime || journey.defaults?.thinkTime;
      if (thinkTime) {
        flow.push(this.buildThinkTime(thinkTime));
      }
    }

    return flow;
  }

  /**
   * Build Artillery request from journey step
   */
  private buildStepRequest(step: Step): ArtilleryFlowItem {
    const method = step.request.method.toLowerCase() as 'get' | 'post' | 'put' | 'patch' | 'delete';

    const request: ArtilleryRequest = {
      url: step.request.url,
      beforeRequest: 'beforeRequest',
      afterResponse: 'afterResponse',
      // Use function name pattern for conditional execution
      ifTrue: `shouldExecuteStep_${step.id}`,
    };

    // IMPORTANT: Artillery's request body handling requires special care.
    //
    // Artillery's template engine processes {{...}} variables BEFORE the beforeRequest hook runs.
    // When variables are undefined (e.g., user data not yet loaded), Artillery converts them to
    // empty strings, which corrupts JSON structure.
    //
    // Solution: We add an EMPTY json placeholder `json: {}` here ONLY when the step has a body.
    // This tells Artillery to prepare a JSON request, then beforeRequest hook replaces the
    // empty body with the properly interpolated values from config.variables.__journey.
    //
    // This approach ensures:
    // 1. Artillery knows this is a JSON request and sets Content-Type appropriately
    // 2. The body can be modified in beforeRequest before the HTTP request is sent
    // 3. Variables are interpolated with proper user context (loaded in beforeScenario)
    if (step.request.json) {
      // Add empty placeholder - beforeRequest will populate with interpolated values
      request.json = {};
    } else if (step.request.body) {
      // For string body, add empty string placeholder
      request.body = '';
    }

    // Add native captures for simple extractions
    if (step.extract) {
      request.capture = this.buildCaptures(step);
    }

    // Create the flow item with step metadata
    const flowItem: Record<string, unknown> = {
      [method]: {
        ...request,
        // Add metadata for processor
        __stepId: step.id,
        __stepName: step.name || step.id,
      },
    };

    return flowItem as ArtilleryFlowItem;
  }

  /**
   * Build native Artillery captures for simple extractions
   */
  private buildCaptures(step: Step): ArtilleryCapture[] {
    const captures: ArtilleryCapture[] = [];

    if (!step.extract) return captures;

    for (const extraction of step.extract) {
      // Only use native capture for simple JSONPath without transforms
      if (
        (extraction.type === 'jsonpath' || !extraction.type) &&
        !extraction.transform &&
        !extraction.default
      ) {
        captures.push({
          json: extraction.path,
          as: extraction.as,
        });
      } else if (extraction.type === 'header' && !extraction.transform) {
        captures.push({
          header: extraction.path,
          as: extraction.as,
        });
      }
      // Complex extractions handled by afterResponse hook
    }

    return captures;
  }

  /**
   * Build think time flow item
   */
  private buildThinkTime(thinkTime: ThinkTime): ArtilleryFlowItem {
    if (typeof thinkTime === 'number') {
      return { think: thinkTime };
    }

    // For range, use function
    return { function: 'think' };
  }

  /**
   * Generate processor file content
   */
  generateProcessor(processorModulePath: string, debugLogPath?: string): string {
    // Collect all unique steps from all journeys (default + profile-specific)
    const allSteps = new Map<string, Step>();

    // Add steps from default journey
    for (const step of this.journey.steps) {
      allSteps.set(step.id, step);
    }

    // Add steps from profile-specific journeys
    for (const [, profileJourney] of this.profileJourneys) {
      for (const step of profileJourney.steps) {
        allSteps.set(step.id, step);
      }
    }

    const stepConditions = Array.from(allSteps.values()).map((step) => {
      return `
// Condition for step: ${step.id}
module.exports.shouldExecuteStep_${step.id} = function(context) {
  return processor.shouldExecuteStep(context, '${step.id}');
};`;
    });

    // Escape backslashes for Windows paths
    const escapedPath = processorModulePath.replace(/\\/g, '\\\\');
    const escapedDebugPath = debugLogPath ? debugLogPath.replace(/\\/g, '\\\\') : '';

    // Debug logging setup
    const debugSetup = debugLogPath ? `
// Debug logging setup
const fs = require('fs');
const DEBUG_LOG_PATH = '${escapedDebugPath}';

// Initialize debug log file
fs.writeFileSync(DEBUG_LOG_PATH, '=== Shield Artillery Debug Log ===\\n' +
  'Started: ' + new Date().toISOString() + '\\n\\n');

// Wrap beforeRequest to add debug logging
const originalBeforeRequest = processor.beforeRequest;
module.exports.beforeRequest = function(requestParams, context, ee, next) {
  // Log BEFORE state with detailed context info
  const beforeLog = {
    timestamp: new Date().toISOString(),
    phase: 'BEFORE beforeRequest',
    step: requestParams.__stepId || 'unknown',
    requestParams: {
      url: requestParams.url,
      method: requestParams.method,
      headers: requestParams.headers,
      json: requestParams.json,
      body: requestParams.body
    },
    contextVars: Object.keys(context.vars).filter(k => !k.startsWith('__')),
    internalVars: Object.keys(context.vars).filter(k => k.startsWith('__')),
    hasJourney: !!context.vars.__journey,
    hasProfiles: !!context.vars.__profiles,
    hasUser: !!context.vars.user,
    userData: context.vars.user || null
  };

  fs.appendFileSync(DEBUG_LOG_PATH,
    '--- beforeRequest Debug ---\\n' +
    JSON.stringify(beforeLog, null, 2) + '\\n\\n'
  );

  // Call original handler
  return originalBeforeRequest(requestParams, context, ee, function() {
    // Log AFTER state with detailed info
    const afterLog = {
      timestamp: new Date().toISOString(),
      phase: 'AFTER beforeRequest',
      step: requestParams.__stepId || 'unknown',
      requestParams: {
        url: requestParams.url,
        method: requestParams.method,
        headers: requestParams.headers,
        json: requestParams.json,
        body: requestParams.body
      },
      hasUser: !!context.vars.user,
      userData: context.vars.user || null
    };

    fs.appendFileSync(DEBUG_LOG_PATH,
      JSON.stringify(afterLog, null, 2) + '\\n\\n'
    );

    next();
  });
};

// Wrap afterResponse to add debug logging
const originalAfterResponse = processor.afterResponse;
module.exports.afterResponse = function(requestParams, response, context, ee, next) {
  // Log request/response details
  const logEntry = {
    timestamp: new Date().toISOString(),
    step: requestParams.__stepId || 'unknown',
    request: {
      method: requestParams.method,
      url: requestParams.url,
      headers: requestParams.headers,
      body: requestParams.json || requestParams.body
    },
    response: {
      statusCode: response.statusCode,
      headers: response.headers,
      body: typeof response.body === 'string' ? response.body.substring(0, 2000) : response.body,
      responseTime: response.timings?.phases?.total
    }
  };

  fs.appendFileSync(DEBUG_LOG_PATH,
    '--- Request/Response ---\\n' +
    JSON.stringify(logEntry, null, 2) + '\\n\\n'
  );

  // Call original handler
  return originalAfterResponse(requestParams, response, context, ee, next);
};
` : '';

    return `/**
 * Generated Artillery Processor
 * Auto-generated by shield-artillery
 */

const processor = require('${escapedPath}');
${debugSetup}
// Re-export standard processor functions
module.exports.initialize = processor.initialize;
module.exports.setupUser = processor.setupUser;
${debugLogPath ? '// beforeRequest is wrapped above for debug logging' : 'module.exports.beforeRequest = processor.beforeRequest;'}
${debugLogPath ? '// afterResponse is wrapped above for debug logging' : 'module.exports.afterResponse = processor.afterResponse;'}
module.exports.think = processor.think;
module.exports.cleanup = processor.cleanup;

// Step-specific condition functions
${stepConditions.join('\n')}
`;
  }

  /**
   * Get all unique paths through the journey
   */
  getJourneyPaths(): string[][] {
    const paths = this.flowEngine.enumeratePaths();
    return paths.map((p) => p.steps);
  }

  /**
   * Validate the generated script structure
   */
  validate(): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    // Check target URL
    if (!this.journey.baseUrl && !this.environment.target.baseUrl) {
      errors.push('No base URL defined in journey or environment');
    }

    // Check steps
    if (this.journey.steps.length === 0) {
      errors.push('Journey has no steps defined');
    }

    // Validate flow engine
    const flowIssues = this.flowEngine.validate();
    for (const issue of flowIssues) {
      if (issue.type === 'error') {
        errors.push(issue.message);
      }
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }
}

/**
 * Convenience function to generate script
 */
export function generateScript(
  journey: Journey,
  environment: EnvironmentConfig,
  profiles?: ProfileConfig,
  profileJourneys?: Map<string, Journey>
): GeneratedScript {
  const generator = new ScriptGenerator(journey, environment, profiles, profileJourneys);
  return generator.generate();
}
