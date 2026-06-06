# data-analyst

Upload CSVs or JSON datasets, then ask questions in plain English. Workers AI generates SQL, runs it against your D1 tables, and returns structured results.

## How it works

1. Upload a CSV or JSON file via `POST /upload` — the agent parses it, infers column types, and creates a D1 table
2. Ask a question via `POST /query` — Workers AI (`llama-3.3-70b`) generates a SELECT statement from your question and the table schema
3. The SQL runs against D1 and the results are returned as JSON alongside the generated SQL

## API

Write endpoints (`/upload`, `DELETE /tables/:name`) require `Authorization: Bearer <ADMIN_TOKEN>`. All read endpoints are public.

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/upload` | yes | Upload CSV or JSON — creates a D1 table |
| `GET` | `/tables` | no | List all datasets |
| `GET` | `/tables/:name/schema` | no | Column names + types for one table |
| `POST` | `/query` | no | Natural language → SQL → results |
| `GET` | `/history` | no | Recent query history (`?dataset=`, `?limit=`) |
| `DELETE` | `/tables/:name` | yes | Drop a dataset and its table |
| `GET` | `/` | no | Health check |

### Upload a CSV

```bash
# Multipart form (recommended)
curl -X POST https://data-analyst.proagentstore.online/upload \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -F "file=@sales.csv" \
  -F "name=Sales 2025"

# Raw CSV body
curl -X POST "https://data-analyst.proagentstore.online/upload?name=sales" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: text/csv" \
  --data-binary @sales.csv
```

### Upload JSON

```bash
# Accepts an array of objects or an object with a top-level array property
curl -X POST https://data-analyst.proagentstore.online/upload \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -F "file=@orders.json" \
  -F "name=Orders"
```

### Ask a question

```bash
curl -X POST https://data-analyst.proagentstore.online/query \
  -H "Content-Type: application/json" \
  -d '{"question": "What are the top 5 products by total revenue?"}'

# When multiple datasets exist, specify which one
curl -X POST https://data-analyst.proagentstore.online/query \
  -H "Content-Type: application/json" \
  -d '{"question": "Show average order value by month", "table": "orders"}'
```

**Response:**

```json
{
  "id": "abc123",
  "question": "What are the top 5 products by total revenue?",
  "sql": "SELECT \"product\", SUM(\"revenue\") AS total_revenue FROM \"t_sales_2025_xyz789\" GROUP BY \"product\" ORDER BY total_revenue DESC LIMIT 5;",
  "row_count": 5,
  "results": [
    { "product": "Widget A", "total_revenue": 48200 },
    ...
  ]
}
```

### List datasets

```bash
curl https://data-analyst.proagentstore.online/tables
```

### Get schema

```bash
curl https://data-analyst.proagentstore.online/tables/orders/schema
```

### Query history

```bash
curl "https://data-analyst.proagentstore.online/history?limit=20"
curl "https://data-analyst.proagentstore.online/history?dataset=orders"
```

### Delete a dataset

```bash
curl -X DELETE https://data-analyst.proagentstore.online/tables/orders \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

## Upload formats

### CSV

Standard comma-separated. Quoted fields (including embedded commas and newlines) are handled. The first row is the header.

### JSON

Either a top-level array of objects:

```json
[{"id": 1, "name": "Alice", "revenue": 1200}, ...]
```

Or an object whose first array-valued property is used:

```json
{"orders": [{"id": 1, ...}, ...]}
```

Nested objects are stringified to TEXT.

### Column type inference

The agent inspects up to 200 rows to decide the SQLite type:

| Inferred type | Condition |
|---|---|
| `INTEGER` | All non-empty values are whole numbers |
| `REAL` | All non-empty values are valid numbers (including decimals) |
| `TEXT` | Anything else |

## Setup

### 1. Create the D1 database

```bash
wrangler d1 create data-analyst-db
# Copy the database_id into wrangler.toml
```

### 2. Run migrations

```bash
wrangler d1 migrations apply data-analyst-db --remote
```

### 3. Deploy the Worker

```bash
pnpm install
wrangler deploy
```

### 4. Set secrets

```bash
wrangler secret put ADMIN_TOKEN
# Also update Doppler:
doppler secrets set ADMIN_TOKEN=<value> --project pags --config prd
```

## Local dev

```bash
pnpm dev
# Upload a file:
curl -X POST "http://localhost:8787/upload?name=test" \
  -H "Content-Type: text/csv" \
  --data-binary @sample.csv
# Query it:
curl -X POST http://localhost:8787/query \
  -H "Content-Type: application/json" \
  -d '{"question": "How many rows are there?"}'
```

## Bindings

| Binding | Type | Purpose |
|---------|------|---------|
| `AI` | Workers AI | Translates natural language questions to SQL |
| `DB` | D1 | Stores dataset metadata, query history, and all uploaded data tables |

## D1 schema

### Metadata tables (created by migration)

| Table | Purpose |
|---|---|
| `datasets` | Registry of uploaded datasets — name, table_name, column schema, row count |
| `query_history` | Every query run: question, generated SQL, result row count, any error |

### Data tables (created dynamically per upload)

Each upload creates a table named `t_<sanitised-name>_<6-char-uid>`. Columns are named after the CSV headers / JSON keys, with types inferred from the data. These tables are dropped when the dataset is deleted.
