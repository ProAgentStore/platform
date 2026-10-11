-- #1009: the platform resumes the exact blocked operation itself, after the owner's verified grant.
--
-- 0204 kept only a fingerprint of the blocked call's arguments, so a resume needed the ORIGINAL caller
-- to send them again — and no caller ever did: approval verified the grant and the blocked work never
-- ran. The arguments are now kept as an envelope-encrypted continuation (AES-256-GCM DEK wrapped with
-- AES-KW under KEY_ENCRYPTION_KEY, the scheme `lib/crypto.ts` uses for every stored credential), at
-- most 64 KiB, owner- and instance-scoped like the row, and WIPED the moment the request is consumed
-- or reaches any terminal state. No plaintext argument is ever written; without the key nothing is
-- stored and the resume falls back to the caller-supplied, fingerprint-checked payload.
ALTER TABLE instance_permission_requests ADD COLUMN continuation_ciphertext BLOB;
ALTER TABLE instance_permission_requests ADD COLUMN continuation_dek BLOB;
ALTER TABLE instance_permission_requests ADD COLUMN continuation_iv BLOB;

-- The run whose step was blocked, when a run was. A run that has since stopped is not resumed
-- behind the owner's back: its continuation goes `stale` instead.
ALTER TABLE instance_permission_requests ADD COLUMN origin_run_id TEXT;
