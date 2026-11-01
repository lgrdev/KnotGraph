---
id: ADR-001
title: Tax rules (VAT)
status: accepted
---

# ADR-001 Tax rules

## Decision
VAT is computed per destination country from the rate table in `rates.ts`, rounded to 2 decimals.
The EU 2026 rule must be applied in `calculateVAT` only.
