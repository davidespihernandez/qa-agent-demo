# Fraud alert webhook contract

The agent calls `report_fraud` once per suspicious order. When `FRAUD_WEBHOOK_URL` is set, that becomes:

```
POST <FRAUD_WEBHOOK_URL>
Content-Type: application/json
Idempotency-Key: <sha256(orderId + ":" + policyVersion)>
```

```json
{
  "orderId": "ord-1a2b3c4d",
  "customerId": "usr-001",
  "total": 12500,
  "rulesBroken": ["high-value"],
  "evidence": "Order total 12500 exceeds the 10000 threshold.",
  "severity": "high",
  "policyVersion": "a1b2c3d4",
  "runId": "5f6e...",
  "detectedAt": "2026-10-14T09:30:00.000Z"
}
```

| Field | Notes |
|---|---|
| `rulesBroken` | one or more of `high-value`, `unknown-customer`, `repeated-identical` |
| `severity` | `low`, `medium` or `high`, chosen by the agent |
| `policyVersion` | first 8 hex chars of the SHA-256 of `agent/agent/fraud-policy.md`; changes when the policy changes |
| `runId` | one value per agent run (not used for dedupe) |

## Duplicates

`Idempotency-Key` is the same for the same order under the same policy, so a re-run or a retry
sends the same key. The header only helps if the receiver acts on it: the Flow should check
whether it already handled that key (the body also carries `orderId` and `policyVersion`).
A policy change produces a new key on purpose, because the order is re-evaluated.

The agent retries once on a network error or 5xx, with the same key.
