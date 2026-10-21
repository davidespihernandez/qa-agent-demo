/**
 * One Mastra instance with OpenTelemetry tracing to Astro, shared by the chat agent (index.ts) and by every
 * POST /review run (review.ts), so each request to the agent shows up under Traces in Astro.
 * The collector endpoint (OTEL_EXPORTER_OTLP_ENDPOINT) is injected in deployed environments only;
 * locally `ast dev` runs no collector, so tracing is a silent no-op.
 */
import { Mastra } from '@mastra/core/mastra';
import { Observability } from '@mastra/observability';
import { OtelExporter } from '@mastra/otel-exporter';

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

export const mastra = new Mastra({ agents: {}, observability });

/** Registers a per-request agent with the traced Mastra instance; call the returned function when the run is done. */
export function traceRunAgent(agent: any, key: string): () => void {
  mastra.addAgent(agent, key);
  return () => {
    try {
      mastra.removeAgent(key);
    } catch {
      /* already gone */
    }
  };
}

/** Tags and metadata attached to the trace of a run. */
export const runTracingOptions = (meta: Record<string, string>) => ({
  tags: ['astro', 'agent:fraud-agent', 'review', ...Object.entries(meta).map(([k, v]) => `${k}:${v}`)],
  metadata: { agent_id: 'fraud-agent', ...meta },
});
