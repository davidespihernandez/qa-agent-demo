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
import { Mastra } from '@mastra/core/mastra';
import { Memory } from '@mastra/memory';
import { LibSQLStore } from '@mastra/libsql';
import { Observability } from '@mastra/observability';
import { OtelExporter } from '@mastra/otel-exporter';
import { serve } from '@astropods/adapter-mastra';
// Also start the HTTP API (POST /review) so the agent can be called from Postman or curl.
import './server';

const memory = new Memory({
  storage: new LibSQLStore({
    id: 'memory',
    url: ':memory:',
  }),
});

function resolveOtlpTracesEndpoint(): string {
  const raw = process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://localhost:4318';
  try {
    const url = new URL(raw);
    if (!url.pathname || url.pathname === '/') {
      url.pathname = '/v1/traces';
    }
    return url.toString();
  } catch {
    return `${raw.replace(/\/+$/, '')}/v1/traces`;
  }
}

const observability = new Observability({
  configs: {
    otel: {
      serviceName: 'fraud-agent',
      exporters: [
        new OtelExporter({
          provider: {
            custom: {
              endpoint: resolveOtlpTracesEndpoint(),
              protocol: 'http/protobuf',
            },
          },
        }),
      ],
    },
  },
});

// Same agent the benchmark harness runs; only env vars differ between arms.
const { agent } = await createFraudAgent(loadConfig(), {
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
});

// Instantiate Mastra so it registers agents/observability plugins at startup.
// `serve(agent)` handles request serving; this constructor call wires runtime integration.
new Mastra({
  agents: {
    'fraud-agent': agent,
  },
  observability,
});

serve(agent);
