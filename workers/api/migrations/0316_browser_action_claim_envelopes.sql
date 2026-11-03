-- #1439: claims share the runtime event feed and must have its complete envelope.
-- Old `dispatched` values were written BEFORE the RPC: they are not evidence of execution.
-- Keep the primary key and task ownership unchanged so a workflow retry cannot act again.
UPDATE instance_runtime_task_events
SET payload = json_set(
  json_remove(payload, '$.step', '$.result'),
  '$.id', id,
  '$.taskId', task_id,
  '$.type', type,
  '$.message', 'Browser action reserved; execution result is unverified.',
  '$.data', json_object(
    'step', COALESCE(json_extract(payload, '$.data.step'), json_extract(payload, '$.step')),
    'result', 'unverified'
  ),
  '$.createdAt', strftime('%Y-%m-%dT%H:%M:%fZ', created_at)
)
WHERE type = 'browser.action.claimed'
  AND id LIKE 'browser-action:%'
  AND CASE WHEN json_valid(payload) THEN
    json_extract(payload, '$.id') IS NULL
    OR json_extract(payload, '$.taskId') IS NULL
    OR json_extract(payload, '$.type') IS NULL
    OR json_extract(payload, '$.createdAt') IS NULL
  ELSE 0 END;
