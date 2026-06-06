-- Add storeType taxonomy matching FAGS pattern:
-- tool = stateless API (like FAGS library)
-- worker = always-on DO with memory (like FAGS model)
-- agent = full AI agent with conversation + tools (like FAGS agent)
ALTER TABLE agents ADD COLUMN store_type TEXT NOT NULL DEFAULT 'agent';
