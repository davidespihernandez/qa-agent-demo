/**
 * Shared fraud-review agent builder. Used by the Astro entry point (index.ts) and by the
 * benchmark harness, so every arm runs the exact same agent. Only env vars change.
 *
 * Arms (see ../../README.md):
 *   A direct:    no LLM_BASE_URL / MCP_URL / FABRIC_GATEWAY_KEY. API tools are built in-process from
 *                the OpenAPI specs in ./specs (read-only: writes are refused locally).
 *   B/C gateway: LLM_BASE_URL + MCP_URL point at Fabric, FABRIC_GATEWAY_KEY is sent as Authorization: Bearer.
 *                The API tools come from Fabric's MCP HTTP bridge (Tool Search on/off is a Fabric plugin setting).
 *
 * `report_fraud` is always a local tool: it POSTs the finding to a webhook (FRAUD_WEBHOOK_URL).
 */

import { Agent } from '@mastra/core/agent';
import { createTool } from '@mastra/core/tools';
import { MCPClient } from '@mastra/mcp';
import { createAnthropic } from '@ai-sdk/anthropic';
import { z } from 'zod';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const POLICY = readFileSync(join(import.meta.dir, 'fraud-policy.md'), 'utf8');
/** Changes whenever the policy text changes, so a re-evaluation under a new policy is a new alert. */
export const POLICY_VERSION = createHash('sha256').update(POLICY).digest('hex').slice(0, 8);

export const INSTRUCTIONS = `You are a fraud analyst agent. You review the orders in an e-commerce system and flag suspicious ones.

Use the API tools to read the data you need. You have read-only access: never try to change or delete anything.

Apply this policy exactly:

${POLICY}

Process:
1. Read all orders.
2. To check customers, look up each DISTINCT customerId once with the get-user tool. NEVER list all users: the users list is huge and will break your context.
3. For EACH order that breaks a rule, call report_fraud once (one call per order).
4. Finish with one line: "SUMMARY: reviewed <n> orders, flagged <m>".

Be efficient: do not call tools you do not need, and do not repeat calls.`;

export type QaConfig = {
  model: string;
  llmBaseUrl?: string;
  llmApiKey?: string;
  gatewayKey?: string;
  mcpUrl?: string;
  mcpToken?: string;
  apiBaseUrl?: string;
  webhookUrl?: string;
};

export function loadConfig(env: Record<string, string | undefined> = process.env): QaConfig {
  return {
    model: env.QA_MODEL || 'anthropic/claude-sonnet-4-5',
    llmBaseUrl: env.LLM_BASE_URL || undefined,
    llmApiKey: env.ANTHROPIC_API_KEY || undefined,
    gatewayKey: env.FABRIC_GATEWAY_KEY || undefined,
    mcpUrl: env.MCP_URL || undefined,
    mcpToken: env.MCP_TOKEN || undefined,
    apiBaseUrl: env.API_BASE_URL || undefined,
    webhookUrl: env.FRAUD_WEBHOOK_URL || undefined,
  };
}

export type FraudReport = {
  orderId: string;
  customerId: string;
  total: number;
  rulesBroken: string[];
  evidence: string;
  severity: 'low' | 'medium' | 'high';
};

// ---------- API tools built from the OpenAPI specs (arm A) ----------

// One merged spec (Orders + Users + Payments): the same file is imported into Fabric, so every arm sees the same 21 operations.
const SPEC_NAMES = ['demo-apis'];
const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'];

function apiTools(cfg: QaConfig) {
  const tools: Record<string, any> = {};
  for (const api of SPEC_NAMES) {
    const spec = JSON.parse(readFileSync(join(import.meta.dir, 'specs', `${api}.json`), 'utf8'));
    const base = (cfg.apiBaseUrl ?? spec.servers?.[0]?.url ?? '').replace(/\/+$/, '');
    for (const [path, item] of Object.entries<any>(spec.paths ?? {})) {
      for (const method of HTTP_METHODS) {
        const op = item?.[method];
        if (!op?.operationId) continue;
        const params: any[] = [...(item.parameters ?? []), ...(op.parameters ?? [])];
        const shape: Record<string, z.ZodTypeAny> = {};
        for (const p of params) {
          let s: z.ZodTypeAny = ['integer', 'number'].includes(p.schema?.type) ? z.number() : z.string();
          if (p.description) s = s.describe(p.description);
          shape[p.name] = p.required ? s : s.optional();
        }
        if (op.requestBody) shape.body = z.record(z.string(), z.any()).describe('JSON request body');
        const id = op.operationId;
        tools[id] = createTool({
          id,
          description: [op.summary, op.description].filter(Boolean).join('. '),
          inputSchema: z.object(shape),
          execute: async (input: any) => {
            // This agent is read-only. Through Fabric the Agent Scope Gate plugin enforces that;
            // in the direct arm we enforce it here so the baseline cannot modify data.
            if (method !== 'get') return { error: 'Blocked: this agent has read-only access.' };
            let url = path.replace(/\{(\w+)\}/g, (_, k) => encodeURIComponent(String(input[k])));
            const query = params.filter((p) => p.in === 'query' && input[p.name] !== undefined);
            if (query.length) url += '?' + new URLSearchParams(query.map((p) => [p.name, String(input[p.name])])).toString();
            const res = await fetch(base + url);
            const text = await res.text();
            // Safety net so one careless call (e.g. listing 60k users) cannot overflow the context.
            if (text.length > 40000) return { error: 'Response too large, truncated. Use a more specific lookup.', status: res.status, head: text.slice(0, 2000) };
            try {
              return JSON.parse(text);
            } catch {
              return { status: res.status, body: text };
            }
          },
        });
      }
    }
  }
  return tools;
}

// ---------- report_fraud: POST to the webhook with an Idempotency-Key ----------

function reportFraudTool(cfg: QaConfig, runId: string, onReport?: (r: FraudReport) => void) {
  return createTool({
    id: 'report_fraud',
    description:
      'Report one suspicious order to the fraud team. Call once per order that breaks the policy. ' +
      'Include which rules were broken and the evidence you saw.',
    inputSchema: z.object({
      orderId: z.string(),
      customerId: z.string(),
      total: z.number(),
      rulesBroken: z.array(z.enum(['high-value', 'unknown-customer', 'repeated-identical'])).min(1),
      evidence: z.string().describe('One or two sentences with the facts that show the rule was broken'),
      severity: z.enum(['low', 'medium', 'high']),
    }),
    execute: async (input: any) => {
      onReport?.(input as FraudReport);
      if (!cfg.webhookUrl) return { status: 'skipped', reason: 'No webhook configured (dry run).' };
      // Same order + same policy = same key, so a re-run does not create a second alert.
      const key = createHash('sha256').update(`${input.orderId}:${POLICY_VERSION}`).digest('hex');
      const body = JSON.stringify({ ...input, policyVersion: POLICY_VERSION, runId, detectedAt: new Date().toISOString() });
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          const res = await fetch(cfg.webhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key },
            body,
          });
          if (res.status < 500) return { status: res.ok ? 'sent' : 'rejected', httpStatus: res.status };
        } catch {
          /* retry once with the same key */
        }
      }
      return { status: 'failed', reason: 'Webhook unreachable after retry.' };
    },
  });
}

// ---------- model + MCP wiring ----------

function mcpServerDef(cfg: QaConfig) {
  const headers: Record<string, string> = {};
  if (cfg.gatewayKey) headers['Authorization'] = `Bearer ${cfg.gatewayKey}`;
  if (cfg.mcpToken) headers['Authorization'] = `Bearer ${cfg.mcpToken}`;
  return { url: new URL(cfg.mcpUrl!), requestInit: { headers } };
}

function modelDef(cfg: QaConfig) {
  if (!cfg.llmBaseUrl && !cfg.gatewayKey) return cfg.model;
  // Mastra's own `url` option assumes an OpenAI-style path (/chat/completions) and drops our route
  // prefix, so go through the AI SDK Anthropic provider, which honours baseURL exactly.
  // Through the gateway the SDK's x-api-key must NOT carry the real Anthropic key: the gateway
  // authenticates the caller with Authorization: Bearer and injects the upstream key from its vault.
  const viaGateway = !!cfg.gatewayKey;
  const provider = createAnthropic({
    // Anthropic SDK default is https://api.anthropic.com/v1, so the gateway base must end in /v1
    baseURL: cfg.llmBaseUrl ? `${cfg.llmBaseUrl.replace(/\/+$/, '')}/v1` : undefined,
    apiKey: viaGateway ? 'managed-by-fabric' : cfg.llmApiKey,
    headers: viaGateway ? { Authorization: `Bearer ${cfg.gatewayKey}` } : undefined,
  });
  return provider(cfg.model.replace(/^anthropic\//, ''));
}

export async function createFraudAgent(
  cfg: QaConfig = loadConfig(),
  extra: Record<string, unknown> = {},
  onReport?: (r: FraudReport) => void,
) {
  const runId = randomUUID();
  const mcp = cfg.mcpUrl ? new MCPClient({ id: 'fraud-apis', servers: { apis: mcpServerDef(cfg) } }) : undefined;
  const apiToolset = mcp ? await mcp.listTools() : apiTools(cfg);
  const tools = { ...apiToolset, report_fraud: reportFraudTool(cfg, runId, onReport) };
  const agent = new Agent({
    id: 'fraud-agent',
    name: 'Fraud Agent',
    instructions: INSTRUCTIONS,
    model: modelDef(cfg),
    tools,
    ...extra,
  });
  return { agent, mcp, runId, toolCount: Object.keys(tools).length };
}
