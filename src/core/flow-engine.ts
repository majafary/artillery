/**
 * Flow Engine
 * Handles conditional branching and step navigation for journey execution
 */

import { JSONPath } from 'jsonpath-plus';
import type {
  Journey,
  Step,
  Branch,
  Condition,
  StepResponse,
  JourneyExecutionState,
} from '../types/index.js';

export interface FlowState {
  currentStepId: string;
  variables: Record<string, unknown>;
  executedSteps: string[];
}

export interface BranchEvaluationResult {
  matched: boolean;
  nextStepId: string | null;
  matchedCondition?: Condition;
}

export class FlowEngine {
  private journey: Journey;
  private stepMap: Map<string, Step>;
  private stepOrder: string[];

  constructor(journey: Journey) {
    this.journey = journey;
    this.stepMap = new Map();
    this.stepOrder = [];

    // Build step lookup map and order
    for (const step of journey.steps) {
      this.stepMap.set(step.id, step);
      this.stepOrder.push(step.id);
    }
  }

  /**
   * Get a step by ID
   */
  getStep(stepId: string): Step | undefined {
    return this.stepMap.get(stepId);
  }

  /**
   * Get the first step in the journey
   */
  getFirstStep(): Step | undefined {
    return this.journey.steps[0];
  }

  /**
   * Get the next step in sequence (without branching)
   */
  getNextSequentialStep(currentStepId: string): Step | undefined {
    const currentIndex = this.stepOrder.indexOf(currentStepId);
    if (currentIndex === -1 || currentIndex >= this.stepOrder.length - 1) {
      return undefined;
    }
    return this.stepMap.get(this.stepOrder[currentIndex + 1]);
  }

  /**
   * Evaluate branch conditions and determine the next step
   */
  evaluateBranches(
    step: Step,
    response: StepResponse,
    state: FlowState
  ): BranchEvaluationResult {
    // If no branches defined, check onSuccess/onFailure
    if (!step.branches || step.branches.length === 0) {
      return this.evaluateSimpleTransition(step, response);
    }

    // Evaluate each branch in order
    for (const branch of step.branches) {
      if (this.evaluateCondition(branch.condition, response, state)) {
        return {
          matched: true,
          nextStepId: branch.goto,
          matchedCondition: branch.condition,
        };
      }
    }

    // No branch matched - fall through to onSuccess or sequential
    return this.evaluateSimpleTransition(step, response);
  }

  /**
   * Evaluate a single condition against response and state
   */
  evaluateCondition(
    condition: Condition,
    response: StepResponse,
    state: FlowState
  ): boolean {
    // Get the value to evaluate
    let value: unknown;

    if (condition.field) {
      // JSONPath field extraction from response body
      value = this.extractFieldValue(response.body, condition.field);
    } else if (condition.status !== undefined) {
      // Direct status code comparison
      return response.statusCode === condition.status;
    } else if (condition.header) {
      // Header value extraction
      value = response.headers[condition.header.toLowerCase()];
    } else {
      // No field specified - can't evaluate
      return false;
    }

    // Evaluate the comparison operator
    return this.evaluateOperator(condition, value);
  }

  /**
   * Extract a field value from response body using JSONPath
   */
  private extractFieldValue(body: unknown, path: string): unknown {
    if (body === null || body === undefined) {
      return undefined;
    }

    let jsonBody = body;
    if (typeof body === 'string') {
      try {
        jsonBody = JSON.parse(body);
      } catch {
        return undefined;
      }
    }

    try {
      const results = JSONPath({
        path,
        json: jsonBody as object,
        wrap: false,
      });

      // Return single value if only one result
      if (Array.isArray(results) && results.length === 1) {
        return results[0];
      }
      return results;
    } catch {
      return undefined;
    }
  }

  /**
   * Evaluate comparison operators
   */
  private evaluateOperator(condition: Condition, value: unknown): boolean {
    // Equal
    if (condition.eq !== undefined) {
      return value === condition.eq;
    }

    // Not equal
    if (condition.ne !== undefined) {
      return value !== condition.ne;
    }

    // Greater than
    if (condition.gt !== undefined) {
      return typeof value === 'number' && value > condition.gt;
    }

    // Greater than or equal
    if (condition.gte !== undefined) {
      return typeof value === 'number' && value >= condition.gte;
    }

    // Less than
    if (condition.lt !== undefined) {
      return typeof value === 'number' && value < condition.lt;
    }

    // Less than or equal
    if (condition.lte !== undefined) {
      return typeof value === 'number' && value <= condition.lte;
    }

    // Contains (string)
    if (condition.contains !== undefined) {
      return typeof value === 'string' && value.includes(condition.contains);
    }

    // Matches (regex)
    if (condition.matches !== undefined) {
      if (typeof value !== 'string') return false;
      try {
        const regex = new RegExp(condition.matches);
        return regex.test(value);
      } catch {
        return false;
      }
    }

    // Exists
    if (condition.exists !== undefined) {
      const exists = value !== undefined && value !== null;
      return condition.exists ? exists : !exists;
    }

    // In array
    if (condition.in !== undefined) {
      return Array.isArray(condition.in) && condition.in.includes(value);
    }

    // No operator specified
    return false;
  }

  /**
   * Evaluate simple onSuccess/onFailure transitions
   */
  private evaluateSimpleTransition(
    step: Step,
    response: StepResponse
  ): BranchEvaluationResult {
    const isSuccess = response.statusCode >= 200 && response.statusCode < 300;

    if (isSuccess && step.onSuccess) {
      return { matched: true, nextStepId: step.onSuccess };
    }

    if (!isSuccess && step.onFailure) {
      return { matched: true, nextStepId: step.onFailure };
    }

    // Fall through to sequential next step
    const nextStep = this.getNextSequentialStep(step.id);
    return {
      matched: false,
      nextStepId: nextStep?.id || null,
    };
  }

  /**
   * Determine if a step should execute based on current flow state
   * This is used by Artillery's ifTrue condition
   */
  shouldExecuteStep(stepId: string, state: FlowState): boolean {
    const expectedStep = (state.variables as Record<string, unknown>).__nextStep as string | undefined;

    // If no __nextStep is set, we're at the beginning - execute first step
    if (!expectedStep) {
      return stepId === this.stepOrder[0];
    }

    // Check if this is the expected next step
    if (stepId === expectedStep) {
      return true;
    }

    // Check if we've passed the expected step in sequence
    // (step should not execute if it's before the expected step)
    const expectedIndex = this.stepOrder.indexOf(expectedStep);
    const currentIndex = this.stepOrder.indexOf(stepId);

    // If the expected step comes after this step, skip this step
    return currentIndex >= expectedIndex;
  }

  /**
   * Build all possible paths through the journey
   * Useful for scenario generation and validation
   */
  enumeratePaths(): JourneyPath[] {
    const paths: JourneyPath[] = [];
    const visited = new Set<string>();

    const traverse = (stepId: string, currentPath: string[]): void => {
      const step = this.stepMap.get(stepId);
      if (!step) return;

      const newPath = [...currentPath, stepId];

      // Check for cycles
      if (visited.has(stepId)) {
        paths.push({ steps: newPath, isComplete: false, hasCycle: true });
        return;
      }

      visited.add(stepId);

      // Get all possible next steps
      const nextSteps = new Set<string>();

      // From branches
      if (step.branches) {
        for (const branch of step.branches) {
          nextSteps.add(branch.goto);
        }
      }

      // From onSuccess/onFailure
      if (step.onSuccess) nextSteps.add(step.onSuccess);
      if (step.onFailure) nextSteps.add(step.onFailure);

      // Sequential next
      const seqNext = this.getNextSequentialStep(stepId);
      if (seqNext) nextSteps.add(seqNext.id);

      // If no next steps, this is an end path
      if (nextSteps.size === 0) {
        paths.push({ steps: newPath, isComplete: true, hasCycle: false });
      } else {
        // Traverse all next steps
        for (const nextId of nextSteps) {
          traverse(nextId, newPath);
        }
      }

      visited.delete(stepId);
    };

    const firstStep = this.getFirstStep();
    if (firstStep) {
      traverse(firstStep.id, []);
    }

    return paths;
  }

  /**
   * Validate journey structure
   */
  validate(): ValidationIssue[] {
    const issues: ValidationIssue[] = [];

    // Check all branch targets exist
    for (const step of this.journey.steps) {
      if (step.branches) {
        for (const branch of step.branches) {
          if (!this.stepMap.has(branch.goto)) {
            issues.push({
              type: 'error',
              stepId: step.id,
              message: `Branch target '${branch.goto}' does not exist`,
            });
          }
        }
      }

      if (step.onSuccess && !this.stepMap.has(step.onSuccess)) {
        issues.push({
          type: 'error',
          stepId: step.id,
          message: `onSuccess target '${step.onSuccess}' does not exist`,
        });
      }

      if (step.onFailure && !this.stepMap.has(step.onFailure)) {
        issues.push({
          type: 'error',
          stepId: step.id,
          message: `onFailure target '${step.onFailure}' does not exist`,
        });
      }
    }

    // Check for unreachable steps
    const reachable = new Set<string>();
    const firstStep = this.getFirstStep();
    if (firstStep) {
      this.findReachableSteps(firstStep.id, reachable);
    }

    for (const stepId of this.stepOrder) {
      if (!reachable.has(stepId)) {
        issues.push({
          type: 'warning',
          stepId,
          message: `Step '${stepId}' is unreachable`,
        });
      }
    }

    return issues;
  }

  private findReachableSteps(stepId: string, reachable: Set<string>): void {
    if (reachable.has(stepId)) return;

    const step = this.stepMap.get(stepId);
    if (!step) return;

    reachable.add(stepId);

    // From branches
    if (step.branches) {
      for (const branch of step.branches) {
        this.findReachableSteps(branch.goto, reachable);
      }
    }

    // From onSuccess/onFailure
    if (step.onSuccess) this.findReachableSteps(step.onSuccess, reachable);
    if (step.onFailure) this.findReachableSteps(step.onFailure, reachable);

    // Sequential
    const seqNext = this.getNextSequentialStep(stepId);
    if (seqNext) this.findReachableSteps(seqNext.id, reachable);
  }
}

export interface JourneyPath {
  steps: string[];
  isComplete: boolean;
  hasCycle: boolean;
}

export interface ValidationIssue {
  type: 'error' | 'warning';
  stepId?: string;
  message: string;
}
