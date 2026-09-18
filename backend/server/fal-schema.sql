CREATE TABLE IF NOT EXISTS fal_requests (
  job_id TEXT PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
  model TEXT NOT NULL,
  request_id TEXT,
  status_url TEXT,
  response_url TEXT
);
