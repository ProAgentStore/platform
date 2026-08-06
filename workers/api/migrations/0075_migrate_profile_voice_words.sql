-- Retire the second home for hands-free control words (#222).
--
-- Control words were once edited on the Profile page and stored in `user_profile.custom` as
-- `voiceRepeatWords` / `voiceMuteWords` / `voiceStopWords` / `voiceStopSpeechKeyword`. When the
-- Preferences page arrived (#211) it wrote the SAME setting to `users.preferences.voice` through
-- a different endpoint, and that one wins: it is merged server-side by effectiveVoice, while the
-- profile copy is only a CLIENT-side fallback applied when the effective value is empty. So two
-- UIs wrote one setting and one of them silently lost.
--
-- The Profile UI is gone. This moves the surviving values to the one home that is actually read,
-- so the client-side fallback can be deleted without anyone losing words they configured.
--
-- Values move ACROSS, not merged: a profile value is only promoted when the preferences side is
-- unset, so a word set in Preferences (the winning path) is never clobbered by an older profile
-- value the user has not been able to see the effect of.
--
-- These are SCALAR strings ("shush, quiet please"), not objects, so the JSON-subtype trap
-- documented at length in 0071 does not apply — json_set embeds a text value as a proper JSON
-- string, and parseVoiceWords already splits a comma/newline/semicolon-separated string. Verified
-- against SQLite 3.50 before committing.

-- 1. Normalise the column so the paths below have somewhere to write. The column defaults to ''
--    (0071), which is not JSON.
UPDATE users
   SET preferences = '{}'
 WHERE preferences IS NULL OR preferences = '' OR NOT json_valid(preferences);

-- 2. Ensure `$.voice` is an OBJECT. 0071 leaves it as JSON null for anyone who had no per-instance
--    voice settings to promote, and json_set cannot create a key under a null parent — without
--    this the writes below are silent no-ops for exactly those users.
UPDATE users
   SET preferences = json_set(preferences, '$.voice', json('{}'))
 WHERE json_type(preferences, '$.voice') IS NULL
    OR json_type(preferences, '$.voice') <> 'object';

-- 3. Promote each field, only where the profile has a non-empty value AND preferences does not.
--    `json_quote` is not needed: json_set binds a TEXT argument as a JSON string already.
UPDATE users
   SET preferences = json_set(
         preferences,
         '$.voice.repeatWords',
         (SELECT json_extract(p.custom, '$.voiceRepeatWords') FROM user_profile p WHERE p.user_id = users.id)
       )
 WHERE COALESCE(json_extract(preferences, '$.voice.repeatWords'), '') IN ('', '[]')
   AND EXISTS (
         SELECT 1 FROM user_profile p
          WHERE p.user_id = users.id AND p.custom IS NOT NULL AND json_valid(p.custom)
            AND TRIM(COALESCE(json_extract(p.custom, '$.voiceRepeatWords'), '')) <> ''
       );

UPDATE users
   SET preferences = json_set(
         preferences,
         '$.voice.muteWords',
         (SELECT json_extract(p.custom, '$.voiceMuteWords') FROM user_profile p WHERE p.user_id = users.id)
       )
 WHERE COALESCE(json_extract(preferences, '$.voice.muteWords'), '') IN ('', '[]')
   AND EXISTS (
         SELECT 1 FROM user_profile p
          WHERE p.user_id = users.id AND p.custom IS NOT NULL AND json_valid(p.custom)
            AND TRIM(COALESCE(json_extract(p.custom, '$.voiceMuteWords'), '')) <> ''
       );

UPDATE users
   SET preferences = json_set(
         preferences,
         '$.voice.stopWords',
         (SELECT json_extract(p.custom, '$.voiceStopWords') FROM user_profile p WHERE p.user_id = users.id)
       )
 WHERE COALESCE(json_extract(preferences, '$.voice.stopWords'), '') IN ('', '[]')
   AND EXISTS (
         SELECT 1 FROM user_profile p
          WHERE p.user_id = users.id AND p.custom IS NOT NULL AND json_valid(p.custom)
            AND TRIM(COALESCE(json_extract(p.custom, '$.voiceStopWords'), '')) <> ''
       );

UPDATE users
   SET preferences = json_set(
         preferences,
         '$.voice.stopSpeechKeyword',
         (SELECT json_extract(p.custom, '$.voiceStopSpeechKeyword') FROM user_profile p WHERE p.user_id = users.id)
       )
 WHERE COALESCE(json_extract(preferences, '$.voice.stopSpeechKeyword'), '') = ''
   AND EXISTS (
         SELECT 1 FROM user_profile p
          WHERE p.user_id = users.id AND p.custom IS NOT NULL AND json_valid(p.custom)
            AND TRIM(COALESCE(json_extract(p.custom, '$.voiceStopSpeechKeyword'), '')) <> ''
       );

-- 4. Rename the profile copies rather than deleting them, matching 0071's precedent: if a
--    promotion above picked wrong, the original is still recoverable. Nothing reads these keys
--    after this migration — the client-side fallback is removed in the same change.
UPDATE user_profile
   SET custom = json_remove(
         json_set(
           json_set(
             json_set(
               json_set(custom, '$.voiceRepeatWordsLegacy', json_extract(custom, '$.voiceRepeatWords')),
               '$.voiceMuteWordsLegacy', json_extract(custom, '$.voiceMuteWords')
             ),
             '$.voiceStopWordsLegacy', json_extract(custom, '$.voiceStopWords')
           ),
           '$.voiceStopSpeechKeywordLegacy', json_extract(custom, '$.voiceStopSpeechKeyword')
         ),
         '$.voiceRepeatWords', '$.voiceMuteWords', '$.voiceStopWords', '$.voiceStopSpeechKeyword'
       )
 WHERE custom IS NOT NULL
   AND json_valid(custom)
   AND (json_extract(custom, '$.voiceRepeatWords') IS NOT NULL
     OR json_extract(custom, '$.voiceMuteWords') IS NOT NULL
     OR json_extract(custom, '$.voiceStopWords') IS NOT NULL
     OR json_extract(custom, '$.voiceStopSpeechKeyword') IS NOT NULL);

-- 5. Drop the legacy placeholders for fields that never had a value. json_set writes a JSON null
--    for an absent source, which would leave every migrated profile carrying four keys where it
--    had one. Nothing reads them either way; this just keeps the blob honest about what existed.
UPDATE user_profile SET custom = json_remove(custom, '$.voiceRepeatWordsLegacy')      WHERE json_valid(custom) AND json_type(custom, '$.voiceRepeatWordsLegacy')      = 'null';
UPDATE user_profile SET custom = json_remove(custom, '$.voiceMuteWordsLegacy')        WHERE json_valid(custom) AND json_type(custom, '$.voiceMuteWordsLegacy')        = 'null';
UPDATE user_profile SET custom = json_remove(custom, '$.voiceStopWordsLegacy')        WHERE json_valid(custom) AND json_type(custom, '$.voiceStopWordsLegacy')        = 'null';
UPDATE user_profile SET custom = json_remove(custom, '$.voiceStopSpeechKeywordLegacy') WHERE json_valid(custom) AND json_type(custom, '$.voiceStopSpeechKeywordLegacy') = 'null';
