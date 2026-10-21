/**
 * fraud-agent - Reviews orders against a plain-English fraud policy and reports suspicious ones to a webhook.
 *
 * This agent uses Mastra's Agent class with the Astro adapter to connect
 * to the Astro messaging service via gRPC.
 *
 * Environment variables (automatically injected by 'astro dev'):
 *   ANTHROPIC_API_KEY - injected by anthropic model
 *   GRPC_SERVER_ADDR - injected by Astro messaging service
 */

import { createFraudAgent, loadConfig } from './fraud-agent';
import { armConfig } from './review';
import { Memory } from '@mastra/memory';
import { LibSQLStore } from '@mastra/libsql';
import { mastra } from './telemetry';
import { serve } from '@astropods/adapter-mastra';
// Also start the HTTP API (POST /review) so the agent can be called from Postman or curl.
import './server';

const memory = new Memory({
  storage: new LibSQLStore({
    id: 'memory',
    url: ':memory:',
  }),
});

// Same agent the benchmark harness runs; only env vars differ between arms.
const extras = {
  memory,
  // Ensure traces include stable Astro metadata by default.
  // The collector endpoint (OTEL_EXPORTER_OTLP_ENDPOINT) is injected in deployed
  // environments only — `ast project start` runs no collector, so local tracing
  // is a silent no-op.
  defaultOptions: {
    tracingOptions: {
      tags: ['astro', 'agent:fraud-agent'],
      metadata: {
        agent_id: 'fraud-agent',
      },
    },
  },
};
let created;
try {
  created = await createFraudAgent(loadConfig(), extras);
} catch (e: any) {
  // The chat agent must come up even if the gateway is unreachable: fall back to the direct arm.
  console.error(`Chat agent could not start with the configured gateway (${e?.message}); falling back to direct mode.`);
  created = await createFraudAgent(armConfig('A'), extras);
}
const { agent } = created;

// Register the chat agent with the traced Mastra instance (see telemetry.ts). `serve(agent)` handles request serving.
mastra.addAgent(agent, 'fraud-agent');

serve(agent);
