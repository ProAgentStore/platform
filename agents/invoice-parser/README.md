# invoice-parser

A ProAgentStore stateless API tool that extracts structured data from invoice text using Workers AI, and keeps a parse history in a Durable Object for analytics.

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | Health check |
| POST | `/parse` | Extract structured fields from invoice text |
| GET | `/history` | Recent parses with results (default: last 20) |

## POST /parse

**Request body:**

```json
{
  "text": "<raw invoice text>"
}
```

`text` is the full plain-text content of the invoice (copy-pasted or OCR output). Required.

**Response:**

```json
{
  "id": "uuid",
  "parsedAt": "2026-06-06T12:00:00.000Z",
  "result": {
    "vendor": "Acme Supplies Ltd.",
    "invoice_number": "INV-2024-0042",
    "date": "2024-03-01",
    "due_date": "2024-03-31",
    "line_items": [
      { "description": "Widget A x 10", "quantity": 10, "unit_price": 9.99, "amount": 99.90 },
      { "description": "Shipping", "quantity": null, "unit_price": null, "amount": 12.50 }
    ],
    "subtotal": 99.90,
    "tax": 11.24,
    "total": 123.64,
    "currency": "USD"
  }
}
```

All fields are `null` if the model cannot determine them. `line_items` is `[]` when no line items are found.

## GET /history

Returns the most recent parses, newest first.

Optional query param: `?limit=<1-100>` (default: 20).

```json
{
  "records": [
    {
      "id": "uuid",
      "preview": "ACME SUPPLIES LTD\nInvoice #INV-2024-0042...",
      "result": { ... },
      "inputLength": 843,
      "parsedAt": "2026-06-06T12:00:00.000Z"
    }
  ],
  "total": 1
}
```

`preview` is the first 200 characters of the submitted text.

## Authentication

No authentication is required by default. To restrict access, set the `API_KEY` secret — callers must then include `X-Api-Key: <value>` on every request.

## Secrets

| Secret | Required | Description |
|--------|----------|-------------|
| `API_KEY` | No | If set, all requests must include `X-Api-Key: <value>` |

Set via `wrangler secret put` and mirror in Doppler (`pags` project):

```bash
wrangler secret put API_KEY
doppler secrets set API_KEY=<value> --project pags --config prd
```

## Development

```bash
pnpm install
pnpm dev
```

Parse a sample invoice locally:

```bash
curl -X POST http://localhost:8787/parse \
  -H "Content-Type: application/json" \
  -d '{
    "text": "ACME SUPPLIES LTD\nInvoice #INV-2024-0042\nDate: March 1, 2024\nDue: March 31, 2024\n\nWidget A x 10 @ $9.99 = $99.90\nShipping = $12.50\n\nSubtotal: $99.90\nTax (10%): $11.24\nTotal: $123.64"
  }'
```

Retrieve history:

```bash
curl http://localhost:8787/history?limit=5
```

## Deploy

```bash
pnpm deploy
# or push to main — GitHub Actions auto-deploys
```

## Extraction model

Uses `@cf/meta/llama-3.3-70b-instruct-fp8-fast` via Workers AI. The model is prompted to return a strict JSON schema; the response is sanitised and normalised before being returned. If extraction fails, all fields return as `null` rather than erroring.
