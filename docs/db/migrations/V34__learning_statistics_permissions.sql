-- The learning statistics tables are created by the postgres migration role,
-- while the application connects as linklish in production.
GRANT SELECT, INSERT, UPDATE
  ON TABLE daily_learning_stats, learning_streaks
  TO linklish;

GRANT USAGE
  ON SEQUENCE daily_learning_stats_id_seq, learning_streaks_id_seq
  TO linklish;
