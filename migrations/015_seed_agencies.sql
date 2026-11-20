-- A small catalog seed so agency metadata is available from a clean volume.
INSERT INTO agencies (id, name, website) VALUES
  ('bettergov', 'BetterGovPH', 'https://data.bettergov.ph'),
  ('dbm', 'Department of Budget and Management', 'https://www.dbm.gov.ph')
ON CONFLICT (id) DO NOTHING;
