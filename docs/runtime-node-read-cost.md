# Owner runtime registration reads (#1646)

`ownerRuntimeNodes` consolidates metadata reads used by the instance machine picker,
browser runtime candidates, terminal identity views, repin registration discovery,
and stamped-runner identity checks. Concurrent reads for the same D1 binding and
owner share one pending query in an isolate. Settled results are discarded, including
failures: identity is read again after runner operations, before a later routing or
lock-release decision. Returned rows are copied for each consumer.

The unclaim endpoint uses one owner read for both the named node and remaining
machine aliases, replacing its two sequential reads. Repin retains its existing
200-entry result limit after filtering; it now reads the complete owner metadata
before applying that limit. Owners whose fleet exceeds that cap may therefore read more rows per repin query. Resource blobs and credentials are not selected.

No migration or API response change is required. Migration 0047 already indexes
`user_id`; migration 0098 also indexes `(user_id, machine_id)`. The real-schema test
checks the executed query's SQLite plan uses an indexed owner lookup.

This is concurrent call coalescing, not a timed cache. It does not reduce isolated,
sequential polls or share results between isolates. Tests prove overlapping calls
become one query; they do not establish production savings.

After deployment, compare equal-duration D1 analytics windows for the old owner
query variants and the canonical metadata query together. Record execution count,
total rows read and rows read per execution, normalized for runtime activity. Include
the remaining resource-history query and capped repin traffic when assessing the
overall cost. A drop in one SQL fingerprint alone is not evidence of savings.
Production counts and per-call rows read remain unverified locally.
