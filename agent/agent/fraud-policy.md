# Fraud policy

Flag an order as suspicious if ANY of these rules is true:

1. **High value**: the order total is greater than 10,000.
2. **Unknown customer**: the order's `customerId` does not exist in the Users API (looking the user up by id returns 404).
3. **Repeated identical orders**: the same customer has 3 or more orders with exactly the same total. Flag every one of those orders.

Anything else is NOT fraud. An order with a total of exactly 10,000 or less is fine, and so is a customer with two similar orders. Do not invent additional rules.
