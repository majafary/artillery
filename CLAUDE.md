# Claude Code Guidelines

## Project-Specific Rules

### Module System Awareness

- This project uses ES Modules (`"type": "module"` in package.json)
- When creating standalone Node.js scripts that use CommonJS (`require()`), use the `.cjs` extension
- Example: `server.cjs` instead of `server.js` for CommonJS scripts
- Always check package.json before creating JS files to determine the module system

## Core Quality Rules

### No Patch Work

- Never introduce band-aid fixes that mask symptoms without addressing root causes
- Do not add safeguards or caps that hide incorrect behavior (e.g., `Math.min(100, errorRate)` to hide >100% rates)
- When encountering unexpected behavior, investigate the root cause first
- If logic appears correct, gather more data (verbose output, debug logs) rather than adding workarounds

### Clean Code Principles

- Fix the actual problem, not the symptom
- If a calculation produces impossible results (e.g., errors > requests), the logic is wrong - find and fix it
- Don't introduce "dirty code" to work around issues that aren't fully understood
- When uncertain about the cause, add proper debugging/logging to understand the issue, don't guess with patches

### Debugging Approach

1. Trace through the logic step by step
2. Verify assumptions with actual data
3. If logic seems correct but results are wrong, the assumptions about input data may be wrong
4. Use verbose mode or add temporary logging to see actual values
5. Only implement a fix when the root cause is understood
