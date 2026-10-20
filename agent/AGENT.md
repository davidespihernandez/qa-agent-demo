---
description: "Reviews orders against a plain-English fraud policy and reports suspicious ones to a Postman Flow."
tags: [fraud, orders, postman]
authors: []
capabilities: []
integrations:
  - "anthropic"
---

Reviews orders from the Orders, Users and Payments APIs, flags orders over $10,000, unknown customers and 3 or more identical orders, and reports each finding plus a summary to a webhook.
