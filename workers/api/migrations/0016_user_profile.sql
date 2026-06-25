-- Structured per-user candidate profile: reusable PII that agents read through
-- the platform (never invent). Distinct from the KB (unstructured docs) and the
-- credentials vault (site logins). One row per user, keyed by user id.
CREATE TABLE IF NOT EXISTS user_profile (
  user_id            TEXT PRIMARY KEY,
  first_name         TEXT,
  last_name          TEXT,
  email              TEXT,
  phone              TEXT,
  city               TEXT,
  state              TEXT,
  country            TEXT,
  postal_code        TEXT,
  linkedin           TEXT,
  website            TEXT,
  work_authorization TEXT,
  salary_expectation TEXT,
  custom             TEXT,                 -- JSON for extra fields
  updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
);
