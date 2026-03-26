import type { SimulationEvent } from './agent-types'
import { STRESS_SCENARIOS, type StressLevel } from './stress-test-scenario'

// ─── Stress Test Support ─────────────────────────────────────────────────────
// Add ?stress=light|medium|heavy|extreme to the URL to load a stress scenario.
// This replaces the normal mock scenario for profiling purposes.

function getStressLevel(): StressLevel | null {
  if (typeof window === 'undefined') return null
  const params = new URLSearchParams(window.location.search)
  const level = params.get('stress')
  if (level && level in STRESS_SCENARIOS) return level as StressLevel
  return null
}

const stressLevel = getStressLevel()
if (stressLevel) {
  // eslint-disable-next-line no-console
  console.log(`[stress-test] Loading ${stressLevel} stress scenario...`)
}

// ─── Rich Mock Scenario ──────────────────────────────────────────────────────
// Demonstrates a full agent session: user prompt → research → parallel subagents
// → implementation → testing with error recovery → completion

const NORMAL_MOCK_SCENARIO: SimulationEvent[] = [
  // ── Agent Spawn & User Prompt ─────────────────────────────────────────────
  { time: 0.0, type: 'agent_spawn', payload: { name: 'orchestrator', isMain: true, task: 'Waiting for instructions...' } },
  { time: 0.2, type: 'message', payload: { agent: 'orchestrator', role: 'user', content: 'Refactor the payment system to support Stripe and PayPal, add webhook handling, and write integration tests' } },
  { time: 0.4, type: 'context_update', payload: { agent: 'orchestrator', tokens: 2200, breakdown: { systemPrompt: 1500, userMessages: 700, toolResults: 0, reasoning: 0, subagentResults: 0 } } },
  { time: 1.0, type: 'message', payload: { agent: 'orchestrator', role: 'thinking', content: 'This is a multi-part task: refactor payments, add Stripe + PayPal, webhooks, and tests. I should start by understanding the existing payment code before planning the implementation.' } },
  { time: 2.5, type: 'message', payload: { agent: 'orchestrator', content: 'I\'ll analyze the codebase and plan the payment system refactoring. Let me start by understanding the current structure.' } },
  { time: 3.0, type: 'context_update', payload: { agent: 'orchestrator', tokens: 3000, breakdown: { systemPrompt: 1500, userMessages: 700, toolResults: 0, reasoning: 800, subagentResults: 0 } } },

  // ── Phase 1: Codebase Exploration ─────────────────────────────────────────
  { time: 4.0, type: 'tool_call_start', payload: { agent: 'orchestrator', tool: 'Glob', args: 'src/**/*.ts', inputData: { pattern: 'src/**/*.ts' } } },
  { time: 4.3, type: 'tool_call_end', payload: { agent: 'orchestrator', tool: 'Glob', result: '47 files matched', tokenCost: 500 } },
  { time: 4.3, type: 'context_update', payload: { agent: 'orchestrator', tokens: 4200, breakdown: { systemPrompt: 1500, userMessages: 700, toolResults: 500, reasoning: 1500, subagentResults: 0 } } },

  { time: 4.5, type: 'tool_call_start', payload: { agent: 'orchestrator', tool: 'Read', args: 'src/services/payment.ts', inputData: { file_path: 'src/services/payment.ts' } } },
  { time: 4.8, type: 'tool_call_end', payload: { agent: 'orchestrator', tool: 'Read', result: 'payment.ts — 234 lines, legacy payment processor with direct Stripe v2 API calls', tokenCost: 3500, discovery: { type: 'file', label: 'src/services/payment.ts', content: 'Legacy processor, 234 lines\nDirect Stripe v2 calls (outdated)\nNo PayPal support' } } },

  { time: 5.0, type: 'tool_call_start', payload: { agent: 'orchestrator', tool: 'Read', args: 'src/routes/checkout.ts', inputData: { file_path: 'src/routes/checkout.ts' } } },
  { time: 5.3, type: 'tool_call_end', payload: { agent: 'orchestrator', tool: 'Read', result: 'checkout.ts — 89 lines, Express routes for /checkout and /payment-status', tokenCost: 1800 } },

  { time: 5.5, type: 'tool_call_start', payload: { agent: 'orchestrator', tool: 'Grep', args: '"stripe|paypal|payment" --type ts', inputData: { pattern: 'stripe|paypal|payment', type: 'ts' } } },
  { time: 5.8, type: 'tool_call_end', payload: { agent: 'orchestrator', tool: 'Grep', result: '28 matches in 9 files — concentrated in services/ and routes/', tokenCost: 700, discovery: { type: 'pattern', label: 'Payment references', content: '28 matches across 9 files\nConcentrated in services/ and routes/\nNo webhook handling found' } } },
  { time: 6.0, type: 'context_update', payload: { agent: 'orchestrator', tokens: 11500, breakdown: { systemPrompt: 1500, userMessages: 700, toolResults: 6500, reasoning: 2800, subagentResults: 0 } } },

  // ── Phase 2: Planning (thinking — deciding on approach) ───────────────────
  { time: 8.0, type: 'tool_call_start', payload: { agent: 'orchestrator', tool: 'TodoWrite', args: 'planning implementation', inputData: {
    todos: [
      { content: 'Analyze existing payment code', status: 'completed', activeForm: 'Analyzing existing payment code' },
      { content: 'Research Stripe & PayPal APIs', status: 'in_progress', activeForm: 'Researching Stripe & PayPal APIs' },
      { content: 'Create payment gateway abstraction', status: 'pending', activeForm: 'Creating payment gateway abstraction' },
      { content: 'Implement Stripe adapter', status: 'pending', activeForm: 'Implementing Stripe adapter' },
      { content: 'Implement PayPal adapter', status: 'pending', activeForm: 'Implementing PayPal adapter' },
      { content: 'Add webhook handling', status: 'pending', activeForm: 'Adding webhook handling' },
      { content: 'Write integration tests', status: 'pending', activeForm: 'Writing integration tests' },
      { content: 'Run tests and verify', status: 'pending', activeForm: 'Running tests and verifying' },
    ]
  } } },
  { time: 8.2, type: 'tool_call_end', payload: { agent: 'orchestrator', tool: 'TodoWrite', result: 'Todos updated — 8 items', tokenCost: 80 } },

  // ── Phase 3: Parallel Research via Subagents (thinking — planning delegation)
  { time: 9.7, type: 'message', payload: { agent: 'orchestrator', content: 'Dispatching agents for parallel research and schema analysis...' } },
  { time: 9.9, type: 'subagent_dispatch', payload: { parent: 'orchestrator', child: 'explore-agent', task: 'Deep-dive into payment flow and DB schema' } },
  { time: 9.9, type: 'subagent_dispatch', payload: { parent: 'orchestrator', child: 'research-agent', task: 'Research Stripe & PayPal API patterns' } },
  { time: 10.2, type: 'agent_spawn', payload: { name: 'explore-agent', parent: 'orchestrator', task: 'Analyze payment flow and database schema' } },
  { time: 10.2, type: 'agent_spawn', payload: { name: 'research-agent', parent: 'orchestrator', task: 'Research Stripe & PayPal integration patterns' } },
  { time: 10.5, type: 'context_update', payload: { agent: 'explore-agent', tokens: 1800, breakdown: { systemPrompt: 1400, userMessages: 400, toolResults: 0, reasoning: 0, subagentResults: 0 } } },
  { time: 10.5, type: 'context_update', payload: { agent: 'research-agent', tokens: 1800, breakdown: { systemPrompt: 1400, userMessages: 400, toolResults: 0, reasoning: 0, subagentResults: 0 } } },

  // explore-agent: reads model file (1.5s initial thinking)
  { time: 12.0, type: 'tool_call_start', payload: { agent: 'explore-agent', tool: 'Read', args: 'src/models/payment.model.ts', inputData: { file_path: 'src/models/payment.model.ts' } } },
  { time: 12.3, type: 'tool_call_end', payload: { agent: 'explore-agent', tool: 'Read', result: 'Prisma schema: Payment { id, amount, currency, status, provider, customerId, metadata }', tokenCost: 1200, discovery: { type: 'code', label: 'Payment Model', content: 'Payment { id, amount, currency,\n  status, provider, customerId }' } } },

  // explore-agent: reads config (immediate)
  { time: 12.5, type: 'tool_call_start', payload: { agent: 'explore-agent', tool: 'Read', args: 'src/config/environment.ts', inputData: { file_path: 'src/config/environment.ts' } } },
  { time: 12.8, type: 'tool_call_end', payload: { agent: 'explore-agent', tool: 'Read', result: 'Environment config: DATABASE_URL, STRIPE_KEY (v2), no PayPal keys configured', tokenCost: 800 } },

  // explore-agent: grep for error handling (immediate)
  { time: 13.0, type: 'tool_call_start', payload: { agent: 'explore-agent', tool: 'Grep', args: '"catch|error|throw" src/services/', inputData: { pattern: 'catch|error|throw', path: 'src/services/' } } },
  { time: 13.3, type: 'tool_call_end', payload: { agent: 'explore-agent', tool: 'Grep', result: '15 matches — minimal error handling, no retry logic', tokenCost: 500, discovery: { type: 'finding', label: 'Weak error handling', content: 'No retry logic in payment flow\nGeneric catch blocks only\nNo idempotency keys' } } },
  { time: 13.5, type: 'context_update', payload: { agent: 'explore-agent', tokens: 6500, breakdown: { systemPrompt: 1400, userMessages: 400, toolResults: 2500, reasoning: 2200, subagentResults: 0 } } },
  { time: 14.0, type: 'subagent_return', payload: { child: 'explore-agent', parent: 'orchestrator', summary: 'Legacy Stripe v2 direct calls, Prisma Payment model, weak error handling, no webhooks' } },
  { time: 14.0, type: 'agent_complete', payload: { name: 'explore-agent' } },

  // research-agent: web search (1.5s initial thinking — slow: network)
  { time: 12.5, type: 'tool_call_start', payload: { agent: 'research-agent', tool: 'WebSearch', args: 'Stripe PaymentIntents Node.js TypeScript 2026', inputData: { query: 'Stripe PaymentIntents Node.js TypeScript 2026' } } },
  { time: 15.0, type: 'tool_call_end', payload: { agent: 'research-agent', tool: 'WebSearch', result: '12 results — Stripe PaymentIntents is the recommended API', tokenCost: 2500 } },

  // research-agent: fetches Stripe docs (immediate — slow: network)
  { time: 15.2, type: 'tool_call_start', payload: { agent: 'research-agent', tool: 'WebFetch', args: 'stripe.com/docs/payments/accept-a-payment', inputData: { url: 'https://stripe.com/docs/payments/accept-a-payment', prompt: 'Extract key steps for PaymentIntents implementation' } } },
  { time: 18.2, type: 'tool_call_end', payload: { agent: 'research-agent', tool: 'WebFetch', result: 'PaymentIntents flow: 1) Create intent, 2) Confirm client-side, 3) Handle webhooks for async events', tokenCost: 4000 } },

  // research-agent: second search for PayPal (immediate — slow: network)
  { time: 18.4, type: 'tool_call_start', payload: { agent: 'research-agent', tool: 'WebSearch', args: 'PayPal Orders API v2 Node.js SDK', inputData: { query: 'PayPal Orders API v2 Node.js SDK 2026' } } },
  { time: 20.7, type: 'tool_call_end', payload: { agent: 'research-agent', tool: 'WebSearch', result: '8 results — PayPal Checkout Server SDK with Orders API v2', tokenCost: 2000 } },
  { time: 21.0, type: 'context_update', payload: { agent: 'research-agent', tokens: 12000, breakdown: { systemPrompt: 1400, userMessages: 400, toolResults: 8500, reasoning: 1700, subagentResults: 0 } } },
  { time: 21.5, type: 'subagent_return', payload: { child: 'research-agent', parent: 'orchestrator', summary: 'Stripe PaymentIntents + webhooks, PayPal Orders API v2, both have Node.js SDKs' } },
  { time: 21.5, type: 'agent_complete', payload: { name: 'research-agent' } },

  // ── Phase 4: Implementation (thinking — planning implementation) ──────────
  { time: 22.0, type: 'context_update', payload: { agent: 'orchestrator', tokens: 25000, breakdown: { systemPrompt: 1500, userMessages: 700, toolResults: 6500, reasoning: 6300, subagentResults: 10000 } } },
  { time: 22.5, type: 'message', payload: { agent: 'orchestrator', role: 'thinking', content: 'Both agents returned. I\'ll use the strategy pattern — a PaymentGateway with adapters for Stripe (PaymentIntents) and PayPal (Orders API v2). Need to install SDKs first, then write the abstraction layer.' } },
  { time: 23.5, type: 'message', payload: { agent: 'orchestrator', content: 'Research complete. Installing dependencies and implementing the payment gateway...' } },

  // Install dependencies (slow: real process)
  { time: 24.0, type: 'tool_call_start', payload: { agent: 'orchestrator', tool: 'Bash', args: 'npm install stripe @paypal/checkout-server-sdk', inputData: { command: 'npm install stripe @paypal/checkout-server-sdk', description: 'Install Stripe and PayPal SDKs' } } },
  { time: 29.0, type: 'tool_call_end', payload: { agent: 'orchestrator', tool: 'Bash', result: 'added 23 packages in 4.2s\n+ stripe@14.2.0\n+ @paypal/checkout-server-sdk@2.0.1', tokenCost: 300 } },

  // Write Stripe adapter (immediate)
  { time: 29.2, type: 'tool_call_start', payload: { agent: 'orchestrator', tool: 'Write', args: 'src/services/stripe-adapter.ts', inputData: { file_path: 'src/services/stripe-adapter.ts' } } },
  { time: 29.5, type: 'tool_call_end', payload: { agent: 'orchestrator', tool: 'Write', result: 'Created src/services/stripe-adapter.ts — 94 lines', tokenCost: 250, discovery: { type: 'code', label: 'NEW: stripe-adapter.ts', content: 'createPayment()\ncapturePayment()\nrefundPayment()\nverifyWebhook()' } } },

  // Write PayPal adapter (immediate)
  { time: 29.7, type: 'tool_call_start', payload: { agent: 'orchestrator', tool: 'Write', args: 'src/services/paypal-adapter.ts', inputData: { file_path: 'src/services/paypal-adapter.ts' } } },
  { time: 30.0, type: 'tool_call_end', payload: { agent: 'orchestrator', tool: 'Write', result: 'Created src/services/paypal-adapter.ts — 78 lines', tokenCost: 220 } },

  // Write unified gateway (immediate)
  { time: 30.2, type: 'tool_call_start', payload: { agent: 'orchestrator', tool: 'Write', args: 'src/services/payment-gateway.ts', inputData: { file_path: 'src/services/payment-gateway.ts' } } },
  { time: 30.5, type: 'tool_call_end', payload: { agent: 'orchestrator', tool: 'Write', result: 'Created src/services/payment-gateway.ts — 112 lines, strategy pattern with retry logic', tokenCost: 300, discovery: { type: 'code', label: 'NEW: payment-gateway.ts', content: 'Strategy pattern: IPaymentAdapter\nRetry with exponential backoff\nIdempotency key support' } } },

  // Refactor existing payment service (immediate)
  { time: 30.7, type: 'tool_call_start', payload: { agent: 'orchestrator', tool: 'Edit', args: 'src/services/payment.ts', inputData: { file_path: 'src/services/payment.ts', old_string: 'const stripe = require("stripe")(STRIPE_KEY)', new_string: 'import { PaymentGateway } from "./payment-gateway"' } } },
  { time: 31.0, type: 'tool_call_end', payload: { agent: 'orchestrator', tool: 'Edit', result: 'Refactored payment.ts — replaced direct Stripe calls with PaymentGateway', tokenCost: 350 } },

  // Write webhook handler (immediate)
  { time: 31.2, type: 'tool_call_start', payload: { agent: 'orchestrator', tool: 'Write', args: 'src/webhooks/stripe-webhook.ts', inputData: { file_path: 'src/webhooks/stripe-webhook.ts' } } },
  { time: 31.5, type: 'tool_call_end', payload: { agent: 'orchestrator', tool: 'Write', result: 'Created stripe-webhook.ts — 67 lines, handles payment_intent.succeeded/failed/canceled', tokenCost: 200 } },

  // Edit routes to add webhook endpoints (immediate)
  { time: 31.7, type: 'tool_call_start', payload: { agent: 'orchestrator', tool: 'Edit', args: 'src/routes/checkout.ts', inputData: { file_path: 'src/routes/checkout.ts', old_string: "router.post('/checkout')", new_string: "router.post('/checkout')\nrouter.post('/webhooks/stripe', stripeWebhook)\nrouter.post('/webhooks/paypal', paypalWebhook)" } } },
  { time: 32.0, type: 'tool_call_end', payload: { agent: 'orchestrator', tool: 'Edit', result: 'Added webhook routes to checkout.ts', tokenCost: 180 } },

  { time: 32.2, type: 'context_update', payload: { agent: 'orchestrator', tokens: 38000, breakdown: { systemPrompt: 1500, userMessages: 700, toolResults: 12500, reasoning: 13300, subagentResults: 10000 } } },
  { time: 33.0, type: 'message', payload: { agent: 'orchestrator', content: 'Core implementation done. Dispatching test agent for comprehensive testing...' } },

  // ── Phase 5: Testing ──────────────────────────────────────────────────────
  { time: 33.5, type: 'subagent_dispatch', payload: { parent: 'orchestrator', child: 'test-runner', task: 'Write and run integration tests for payment adapters and webhooks' } },
  { time: 33.8, type: 'agent_spawn', payload: { name: 'test-runner', parent: 'orchestrator', task: 'Write and run payment integration tests' } },
  { time: 34.0, type: 'context_update', payload: { agent: 'test-runner', tokens: 2000, breakdown: { systemPrompt: 1400, userMessages: 600, toolResults: 0, reasoning: 0, subagentResults: 0 } } },

  // Write test files (1.5s initial thinking, then chain immediately)
  { time: 35.5, type: 'tool_call_start', payload: { agent: 'test-runner', tool: 'Write', args: 'src/__tests__/stripe-adapter.test.ts', inputData: { file_path: 'src/__tests__/stripe-adapter.test.ts' } } },
  { time: 35.8, type: 'tool_call_end', payload: { agent: 'test-runner', tool: 'Write', result: 'Created stripe-adapter.test.ts — 145 lines, 8 test cases', tokenCost: 350 } },

  { time: 36.0, type: 'tool_call_start', payload: { agent: 'test-runner', tool: 'Write', args: 'src/__tests__/payment-gateway.test.ts', inputData: { file_path: 'src/__tests__/payment-gateway.test.ts' } } },
  { time: 36.3, type: 'tool_call_end', payload: { agent: 'test-runner', tool: 'Write', result: 'Created payment-gateway.test.ts — 110 lines, 6 test cases', tokenCost: 280 } },

  { time: 36.5, type: 'tool_call_start', payload: { agent: 'test-runner', tool: 'Write', args: 'src/__tests__/webhook.test.ts', inputData: { file_path: 'src/__tests__/webhook.test.ts' } } },
  { time: 36.8, type: 'tool_call_end', payload: { agent: 'test-runner', tool: 'Write', result: 'Created webhook.test.ts — 85 lines, 4 test cases', tokenCost: 220 } },

  // Run tests — first attempt (immediate — slow: real process)
  { time: 37.0, type: 'tool_call_start', payload: { agent: 'test-runner', tool: 'Bash', args: 'npm test -- --coverage 2>&1 | tail -30', inputData: { command: 'npm test -- --coverage 2>&1 | tail -30', description: 'Run tests with coverage' } } },
  { time: 41.5, type: 'tool_call_end', payload: { agent: 'test-runner', tool: 'Bash', result: 'FAIL: StripeAdapter > createPayment > should handle API errors\nError: STRIPE_SECRET_KEY is not defined\n\n6 passed, 3 failed', tokenCost: 400, isError: true, errorMessage: 'STRIPE_SECRET_KEY is not defined — 3 tests failed' } },

  // Thinking — analyzing error
  { time: 42.0, type: 'message', payload: { agent: 'test-runner', role: 'thinking', content: 'The failing tests are trying to initialize the real Stripe SDK. I need a test setup file that stubs STRIPE_SECRET_KEY and mocks the SDK clients before any test imports run.' } },
  { time: 43.0, type: 'message', payload: { agent: 'test-runner', content: 'Tests need environment variables. Adding test setup with mocks...' } },

  // Fix: add test setup
  { time: 43.5, type: 'tool_call_start', payload: { agent: 'test-runner', tool: 'Write', args: 'src/__tests__/setup.ts', inputData: { file_path: 'src/__tests__/setup.ts' } } },
  { time: 43.8, type: 'tool_call_end', payload: { agent: 'test-runner', tool: 'Write', result: 'Created test setup with mock env vars and SDK stubs', tokenCost: 180 } },

  { time: 44.0, type: 'tool_call_start', payload: { agent: 'test-runner', tool: 'Edit', args: 'jest.config.ts', inputData: { file_path: 'jest.config.ts', old_string: 'preset: "ts-jest"', new_string: 'preset: "ts-jest",\n  setupFiles: ["./src/__tests__/setup.ts"]' } } },
  { time: 44.3, type: 'tool_call_end', payload: { agent: 'test-runner', tool: 'Edit', result: 'Updated jest.config.ts with setup file reference', tokenCost: 100 } },

  // Run tests — second attempt (immediate — slow: real process)
  { time: 44.5, type: 'tool_call_start', payload: { agent: 'test-runner', tool: 'Bash', args: 'npm test -- --coverage 2>&1 | tail -30', inputData: { command: 'npm test -- --coverage 2>&1 | tail -30', description: 'Re-running tests with mock configuration' } } },
  { time: 49.0, type: 'tool_call_end', payload: { agent: 'test-runner', tool: 'Bash', result: 'FAIL: Webhook > verifySignature > should reject tampered payloads\nExpected: SIGNATURE_MISMATCH\nReceived: INVALID_PAYLOAD\n\n17 passed, 1 failed', tokenCost: 400, isError: true, errorMessage: 'Webhook signature test: expected SIGNATURE_MISMATCH, got INVALID_PAYLOAD' } },

  // Thinking — analyzing second error
  { time: 50.5, type: 'message', payload: { agent: 'test-runner', content: 'One test still failing — webhook signature returns wrong error type. Fixing...' } },

  // Fix: correct error classification
  { time: 51.0, type: 'tool_call_start', payload: { agent: 'test-runner', tool: 'Edit', args: 'src/webhooks/stripe-webhook.ts', inputData: { file_path: 'src/webhooks/stripe-webhook.ts', old_string: 'throw new Error("INVALID_PAYLOAD")', new_string: 'throw new WebhookError("SIGNATURE_MISMATCH", "Webhook signature verification failed")' } } },
  { time: 51.3, type: 'tool_call_end', payload: { agent: 'test-runner', tool: 'Edit', result: 'Fixed webhook error classification in stripe-webhook.ts', tokenCost: 120 } },

  // Run tests — third attempt (immediate — slow: real process)
  { time: 51.5, type: 'tool_call_start', payload: { agent: 'test-runner', tool: 'Bash', args: 'npm test -- --coverage 2>&1 | tail -30', inputData: { command: 'npm test -- --coverage 2>&1 | tail -30', description: 'Final test run' } } },
  { time: 56.0, type: 'tool_call_end', payload: { agent: 'test-runner', tool: 'Bash', result: 'Test Suites: 3 passed, 3 total\nTests: 18 passed, 18 total\nCoverage: 91.3% stmts, 87.2% branches', tokenCost: 400, discovery: { type: 'finding', label: 'All 18 tests pass', content: '18/18 tests passing\n91.3% statement coverage\n87.2% branch coverage' } } },

  { time: 56.3, type: 'context_update', payload: { agent: 'test-runner', tokens: 8500, breakdown: { systemPrompt: 1400, userMessages: 600, toolResults: 3500, reasoning: 3000, subagentResults: 0 } } },
  { time: 56.5, type: 'subagent_return', payload: { child: 'test-runner', parent: 'orchestrator', summary: '18 tests passing with 91% coverage, fixed webhook error classification' } },
  { time: 56.5, type: 'agent_complete', payload: { name: 'test-runner' } },

  // ── Phase 6: Final Verification (thinking — deciding on final steps) ──────
  { time: 57.0, type: 'context_update', payload: { agent: 'orchestrator', tokens: 48000, breakdown: { systemPrompt: 1500, userMessages: 700, toolResults: 12500, reasoning: 16800, subagentResults: 16500 } } },
  { time: 58.0, type: 'message', payload: { agent: 'orchestrator', content: 'Tests passing. Running type check and final verification...' } },

  { time: 58.5, type: 'tool_call_start', payload: { agent: 'orchestrator', tool: 'Bash', args: 'npx tsc --noEmit 2>&1', inputData: { command: 'npx tsc --noEmit 2>&1', description: 'TypeScript type checking' } } },
  { time: 62.0, type: 'tool_call_end', payload: { agent: 'orchestrator', tool: 'Bash', result: 'No errors found. Build clean.', tokenCost: 200 } },

  { time: 62.2, type: 'tool_call_start', payload: { agent: 'orchestrator', tool: 'TodoWrite', args: 'marking all complete', inputData: {
    todos: [
      { content: 'Analyze existing payment code', status: 'completed', activeForm: 'Analyzing existing payment code' },
      { content: 'Research Stripe & PayPal APIs', status: 'completed', activeForm: 'Researching Stripe & PayPal APIs' },
      { content: 'Create payment gateway abstraction', status: 'completed', activeForm: 'Creating payment gateway abstraction' },
      { content: 'Implement Stripe adapter', status: 'completed', activeForm: 'Implementing Stripe adapter' },
      { content: 'Implement PayPal adapter', status: 'completed', activeForm: 'Implementing PayPal adapter' },
      { content: 'Add webhook handling', status: 'completed', activeForm: 'Adding webhook handling' },
      { content: 'Write integration tests', status: 'completed', activeForm: 'Writing integration tests' },
      { content: 'Run tests and verify', status: 'completed', activeForm: 'Running tests and verifying' },
    ]
  } } },
  { time: 62.4, type: 'tool_call_end', payload: { agent: 'orchestrator', tool: 'TodoWrite', result: 'All 8 tasks completed', tokenCost: 80 } },

  { time: 62.7, type: 'context_update', payload: { agent: 'orchestrator', tokens: 50000, breakdown: { systemPrompt: 1500, userMessages: 700, toolResults: 12780, reasoning: 18520, subagentResults: 16500 } } },
  { time: 64.0, type: 'message', payload: { agent: 'orchestrator', content: 'Payment system refactored successfully. Created Stripe and PayPal adapters with a unified gateway using the strategy pattern, added webhook handling with signature verification, and all 18 integration tests pass with 91% coverage.' } },
  { time: 65.0, type: 'agent_complete', payload: { name: 'orchestrator' } },
]

export const MOCK_SCENARIO: SimulationEvent[] = stressLevel
  ? STRESS_SCENARIOS[stressLevel]()
  : NORMAL_MOCK_SCENARIO

export const MOCK_DURATION = MOCK_SCENARIO.length > 0
  ? MOCK_SCENARIO[MOCK_SCENARIO.length - 1].time + 10
  : 0
