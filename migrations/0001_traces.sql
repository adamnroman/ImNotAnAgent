-- Opt-in behavioural traces from labelled test sessions (src/traces.js).
-- `record` is JSON holding only the fields listed in the README's privacy section.
-- `day` is the UTC date; no time of day is kept. Rows are deleted 30 days after it.
CREATE TABLE IF NOT EXISTS traces (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  day TEXT NOT NULL,
  label TEXT NOT NULL,
  test TEXT NOT NULL,
  record TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS traces_day ON traces (day);
