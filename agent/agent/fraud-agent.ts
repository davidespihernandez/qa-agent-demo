/**
 * Shared fraud-review agent builder. Used by the Astro entry point (index.ts) and by the
 * benchmark harness, so every arm runs the exact same agent. Only env vars change.
 *
 * Arms (see ../../README.md):
 *   A direct:    no LLM_BASE_URL / MCP_URL / FABRIC_GATEWAY_KEY. API tools are built in-process from
 *                the OpenAPI specs in ./specs (read-only: writes are refused locally).
 *   B/C gateway: LLM_BASE_URL + MCP_URL point at Fabric, FABRIC_GATEWAY_KEY is sent as Authorization: Bearer to the LLM route and as fg-api-key to the MCP route.
 *                The API tools come from Fabric's MCP HTTP bridge (Tool Search on/off is a Fabric plugin setting).
 *
 * `report_fraud` is always a local tool: it POSTs the finding to a webhook (FRAUD_WEBHOOK_URL).
 */

import { Agent } from '@mastra/core/agent';
import { createTool } from '@mastra/core/tools';
import { MCPClient } from '@mastra/mcp';
import { createAnthropic } from '@ai-sdk/anthropic';
import { z } from 'zod';
import { jsonSchema } from '@ai-sdk/provider-utils';
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
  /** Header that carries the gateway key on HTTP/MCP routes. Beta: fg-api-key (default). Production docs: X-Gateway-Key. */
  keyHeader?: string;
  /** If set, the LLM route takes the gateway key in this header instead of Authorization: Bearer. */
  llmKeyHeader?: string;
  mcpUrl?: string;
  mcpToken?: string;
  apiBaseUrl?: string;
  /** Extra headers for the API calls (a gateway key when the APIs are reached through Fabric). */
  apiHeaders?: Record<string, string>;
  /** Where ground truth is read when apiBaseUrl is a gateway URL that needs a key. */
  truthBaseUrl?: string;
  webhookUrl?: string;
};

export function loadConfig(env: Record<string, string | undefined> = process.env): QaConfig {
  return {
    model: env.QA_MODEL || 'anthropic/claude-sonnet-4-5',
    llmBaseUrl: env.LLM_BASE_URL || undefined,
    llmApiKey: env.ANTHROPIC_API_KEY || undefined,
    gatewayKey: env.FABRIC_GATEWAY_KEY || undefined,
    keyHeader: env.FABRIC_KEY_HEADER || undefined,
    llmKeyHeader: env.FABRIC_LLM_KEY_HEADER || undefined,
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

// ---------- API tools for arm A (in-process, same definitions the Fabric MCP bridge exposes) ----------

// bridge-tools.json is a snapshot of what Fabric's MCP HTTP bridge serves (see scripts/dump-bridge-tools.ts),
// demo-apis.json is the OpenAPI spec it was compiled from. Together they let arm A show the model the very
// same tool names, descriptions and input schemas, and call the same HTTP operations.
const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'];

function apiTools(cfg: QaConfig) {
  const spec = JSON.parse(readFileSync(join(import.meta.dir, 'specs', 'demo-apis.json'), 'utf8'));
  const bridge: { name: string; description: string; inputSchema: any }[] = JSON.parse(
    readFileSync(join(import.meta.dir, 'specs', 'bridge-tools.json'), 'utf8'),
  );
  const base = (cfg.apiBaseUrl ?? spec.servers?.[0]?.url ?? '').replace(/\/+$/, '');
  const ops = new Map<string, { path: string; method: string; params: any[]; hasBody: boolean }>();
  for (const [path, item] of Object.entries<any>(spec.paths ?? {})) {
    for (const method of HTTP_METHODS) {
      const op = item?.[method];
      if (op?.operationId) ops.set(op.operationId, { path, method, params: [...(item.parameters ?? []), ...(op.parameters ?? [])], hasBody: !!op.requestBody });
    }
  }
  const tools: Record<string, any> = {};
  for (const def of bridge) {
    const op = ops.get(def.name);
    if (!op) continue;
    const id = `apis_${def.name}`; // same names Mastra gives the MCP tools (server key "apis")
    tools[id] = createTool({
      id,
      description: def.description,
      inputSchema: jsonSchema(def.inputSchema) as any,
      execute: async (input: any) => {
        // This agent is read-only. Through Fabric the Agent Scope Gate plugin enforces that;
        // in the direct arm we enforce it here so the baseline cannot modify data.
        if (op.method !== 'get') return { error: 'Blocked: this agent has read-only access.' };
        let url = op.path.replace(/\{(\w+)\}/g, (_, k) => encodeURIComponent(String(input[k])));
        const query = op.params.filter((p) => p.in === 'query' && input[p.name] !== undefined);
        if (query.length) url += '?' + new URLSearchParams(query.map((p) => [p.name, String(input[p.name])])).toString();
        const res = await fetch(base + url, { headers: cfg.apiHeaders });
        // Return the raw body text, like the MCP bridge does, so result formatting (and tokens) match.
        const text = await res.text();
        if (text.length > 40000) return 'Response too large, truncated. Use a more specific lookup.\n' + text.slice(0, 2000);
        return res.ok ? text : `HTTP ${res.status}: ${text}`;
      },
    });
  }
  return tools;
}

// ---------- report_fraud: POST to the webhook with an Idempotency-Key ----------

export type Delivery = { kind: 'alert' | 'summary'; orderId?: string; status: 'sent' | 'rejected' | 'failed' | 'skipped'; httpStatus?: number; response?: string; idempotencyKey?: string };

/** POST JSON to the webhook with an Idempotency-Key; one retry with the same key. Keeps the Flow's reply so it can be shown. */
export async function postWebhook(url: string | undefined, key: string, payload: object): Promise<Omit<Delivery, 'kind' | 'orderId'>> {
  if (!url) return { status: 'skipped', response: 'No webhook configured (dry run).' };
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key },
        body: JSON.stringify(payload),
      });
      if (res.status < 500) return { status: res.ok ? 'sent' : 'rejected', httpStatus: res.status, response: (await res.text().catch(() => '')).slice(0, 500), idempotencyKey: key };
    } catch {
      /* retry once with the same key */
    }
  }
  return { status: 'failed', response: 'Webhook unreachable after retry.', idempotencyKey: key };
}

function reportFraudTool(cfg: QaConfig, runId: string, onReport?: (r: FraudReport) => void, onDelivery?: (d: Delivery) => void) {
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
      // Same order + same policy = same key, so a re-run does not create a second alert.
      const key = createHash('sha256').update(`${input.orderId}:${POLICY_VERSION}`).digest('hex');
      const r = await postWebhook(cfg.webhookUrl, key, { type: 'fraud-alert', ...input, policyVersion: POLICY_VERSION, runId, detectedAt: new Date().toISOString() });
      onDelivery?.({ kind: 'alert', orderId: input.orderId, ...r });
      return { status: r.status, httpStatus: r.httpStatus };
    },
  });
}

// ---------- model + MCP wiring ----------

function mcpServerDef(cfg: QaConfig) {
  const headers: Record<string, string> = {};
  // Fabric HTTP and MCP routes take the gateway key in `fg-api-key` (the LLM route takes Authorization: Bearer).
  if (cfg.gatewayKey) headers[cfg.keyHeader ?? 'fg-api-key'] = cfg.gatewayKey;
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
    headers: viaGateway ? (cfg.llmKeyHeader ? { [cfg.llmKeyHeader]: cfg.gatewayKey! } : { Authorization: `Bearer ${cfg.gatewayKey}` }) : undefined,
  });
  return provider(cfg.model.replace(/^anthropic\//, ''));
}

export async function createFraudAgent(
  cfg: QaConfig = loadConfig(),
  extra: Record<string, unknown> = {},
  onReport?: (r: FraudReport) => void,
  onDelivery?: (d: Delivery) => void,
) {
  const runId = randomUUID();
  const mcp = cfg.mcpUrl ? new MCPClient({ id: 'fraud-apis', servers: { apis: mcpServerDef(cfg) } }) : undefined;
  const apiToolset = mcp ? await mcp.listTools() : apiTools(cfg);
  // Mastra logs MCP connection errors and carries on with zero tools: fail loudly instead of running a blind agent.
  if (mcp && Object.keys(apiToolset).length === 0) throw new Error(`No tools came back from the MCP server ${cfg.mcpUrl}`);
  const tools = { ...apiToolset, report_fraud: reportFraudTool(cfg, runId, onReport, onDelivery) };
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
