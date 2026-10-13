/**
 * Shared QA agent builder. Used by the Astro entry point (index.ts) and by the
 * benchmark harness, so every arm runs the exact same agent. Only env vars change.
 *
 * Arms (see ../../README.md):
 *   A direct:  no LLM_BASE_URL / MCP_URL / FABRIC_GATEWAY_KEY (MCP runs locally over stdio)
 *   B/C gateway: LLM_BASE_URL + MCP_URL point at Fabric, FABRIC_GATEWAY_KEY is sent as Authorization: Bearer
 *                (Tool Search on/off is a Fabric plugin setting, not agent code)
 */

import { Agent } from '@mastra/core/agent';
import { MCPClient } from '@mastra/mcp';
import { createAnthropic } from '@ai-sdk/anthropic';

export const INSTRUCTIONS = `You are a QA agent. You test a web application in a real browser using the browser tools you are given.

You will receive a test written in plain English. Perform it step by step in the browser, checking what you see after each important action. Do not assume a step worked: verify it on the page.

Rules:
- Only test what the test says. Do not explore other features.
- If a step cannot be done, or what you see differs from what the test expects, the test FAILS.
- Keep it efficient: avoid unnecessary page snapshots and repeated actions.
- When finished, the last line of your final message must be exactly one of:
  VERDICT: PASS - <one sentence of evidence>
  VERDICT: FAIL - <one sentence saying what was expected and what you saw>`;

export type QaConfig = {
  model: string;
  llmBaseUrl?: string;
  llmApiKey?: string;
  gatewayKey?: string;
  mcpUrl?: string;
  mcpToken?: string;
  appUrl: string;
};

export function loadConfig(env: Record<string, string | undefined> = process.env): QaConfig {
  return {
    model: env.QA_MODEL || 'anthropic/claude-sonnet-4-5',
    llmBaseUrl: env.LLM_BASE_URL || undefined,
    llmApiKey: env.ANTHROPIC_API_KEY || undefined,
    gatewayKey: env.FABRIC_GATEWAY_KEY || undefined,
    mcpUrl: env.MCP_URL || undefined,
    mcpToken: env.MCP_TOKEN || undefined,
    appUrl: env.APP_URL || 'http://localhost:4173',
  };
}

function mcpServerDef(cfg: QaConfig) {
  if (!cfg.mcpUrl) {
    // Local browser over stdio (arm A baseline on a laptop)
    return { command: 'npx', args: ['-y', '@playwright/mcp@latest', '--headless'] };
  }
  const headers: Record<string, string> = {};
  if (cfg.gatewayKey) headers['Authorization'] = `Bearer ${cfg.gatewayKey}`;
  if (cfg.mcpToken) headers['Authorization'] = `Bearer ${cfg.mcpToken}`;
  return { url: new URL(cfg.mcpUrl), requestInit: { headers } };
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

export async function createQaAgent(cfg: QaConfig = loadConfig(), extra: Record<string, unknown> = {}) {
  const mcp = new MCPClient({ id: 'qa-browser', servers: { browser: mcpServerDef(cfg) } });
  const tools = await mcp.listTools();
  const agent = new Agent({
    id: 'qa-agent',
    name: 'QA Agent',
    instructions: INSTRUCTIONS,
    model: modelDef(cfg),
    tools,
    ...extra,
  });
  return { agent, mcp, toolCount: Object.keys(tools).length };
}

export function parseVerdict(text: string): { verdict: 'pass' | 'fail' | 'unknown'; reason: string } {
  const m = text.match(/VERDICT:\s*(PASS|FAIL)\s*-?\s*(.*)$/im);
  if (!m) return { verdict: 'unknown', reason: text.slice(-200) };
  return { verdict: m[1].toUpperCase() === 'PASS' ? 'pass' : 'fail', reason: m[2].trim() };
}
