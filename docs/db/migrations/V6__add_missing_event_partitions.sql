-- Add missing monthly partitions for events table
-- This fixes the "no partition of relation 'events' found for row" error

-- Create partition for November 2025
CREATE TABLE IF NOT EXISTS events_2025_11 PARTITION OF events
  FOR VALUES FROM ('2025-11-01') TO ('2025-12-01');

-- Create partition for December 2025
CREATE TABLE IF NOT EXISTS events_2025_12 PARTITION OF events
  FOR VALUES FROM ('2025-12-01') TO ('2026-01-01');

-- Create partition for January 2026
CREATE TABLE IF NOT EXISTS events_2026_01 PARTITION OF events
  FOR VALUES FROM ('2026-01-01') TO ('2026-02-01');

-- Create partition for February 2026
CREATE TABLE IF NOT EXISTS events_2026_02 PARTITION OF events
  FOR VALUES FROM ('2026-02-01') TO ('2026-03-01');

-- Create partition for March 2026
CREATE TABLE IF NOT EXISTS events_2026_03 PARTITION OF events
  FOR VALUES FROM ('2026-03-01') TO ('2026-04-01');
