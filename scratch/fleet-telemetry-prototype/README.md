# Fleet telemetry prototype

The throwaway prototype for #1259 (live fleet telemetry graphs in the console). It is not shipped code; reuse its layout, status rules and chart choices.

- `fetch.py`: calls `list_runner_nodes` and `runner_resource_history` (coarse tier, 24h) through the signed-in `pags mcp` stdio proxy. It writes `runner-machines.csv` and `runner-telemetry-24h.csv`.
- `dashboard.html`: the page, written for the Claude dashboard artifact runtime. That runtime supplies the `dash` data API and the `d3` global, and the CSVs are its two datasets, `machines` and `telemetry`.
  - It shows a summary table with a status pill for each machine.
  - It has one multi-series chart per metric: load per core, disk %, relay round trip, and runner starts in 24h.

Status thresholds used: disk ≥90% warn and ≥95% bad; average load per core ≥1.5 warn and ≥3 bad; active sessions above the recommended max; and disconnected.

No telemetry data is committed. The CSVs name real machines, and this repository is public.

What the console version must change (see #1259):
- Read a fleet history route instead of CSVs.
- Update live from heartbeats.
- Draw with the console's own SVG helpers.
- Treat Windows load as not reported (#1258).
