-- Partition templates (apply by month via automation)

-- word_interactions monthly partitioning
ALTER TABLE word_interactions
  PARTITION BY RANGE (created_at);

-- example partition for 2025-10
CREATE TABLE word_interactions_2025_10 PARTITION OF word_interactions
  FOR VALUES FROM ('2025-10-01') TO ('2025-11-01');

-- events monthly partitioning
ALTER TABLE events
  PARTITION BY RANGE (event_time);

CREATE TABLE events_2025_10 PARTITION OF events
  FOR VALUES FROM ('2025-10-01') TO ('2025-11-01');

