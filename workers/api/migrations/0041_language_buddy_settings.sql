-- Language Buddy: typed per-instance settings (replaces fragile memory-based
-- language/level config). target_language drives the voice language
-- (voiceLanguage: true — option values are BCP-47 tags), so STT/TTS follow the
-- chosen language automatically. Idempotent: re-running re-sets the same JSON;
-- a no-op on databases without the language-buddy agent.

UPDATE agents
SET config = json_set(COALESCE(NULLIF(config, ''), '{}'), '$.settingsSchema', json('[
  {"id":"target_language","label":"Target language","type":"select","voiceLanguage":true,
   "description":"The language you are practicing. Speech recognition and the spoken voice follow it.",
   "default":"es-ES","options":[
    {"value":"es-ES","label":"Spanish"},{"value":"fr-FR","label":"French"},
    {"value":"de-DE","label":"German"},{"value":"it-IT","label":"Italian"},
    {"value":"pt-BR","label":"Portuguese (Brazil)"},{"value":"zh-CN","label":"Chinese (Mandarin)"},
    {"value":"ja-JP","label":"Japanese"},{"value":"ko-KR","label":"Korean"},
    {"value":"hi-IN","label":"Hindi"},{"value":"en-US","label":"English (US)"}]},
  {"id":"level","label":"Level","type":"select","default":"beginner",
   "description":"How advanced your practice sessions should be.",
   "options":[{"value":"beginner","label":"Beginner"},
    {"value":"intermediate","label":"Intermediate"},{"value":"advanced","label":"Advanced"}]}
]'))
WHERE slug = 'language-buddy';
