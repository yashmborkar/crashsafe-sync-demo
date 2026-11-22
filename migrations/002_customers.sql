CREATE TABLE IF NOT EXISTS demo_customers (
  run_id uuid NOT NULL,
  external_id text NOT NULL,
  name text NOT NULL CONSTRAINT demo_customer_name_present CHECK (length(name) > 0),
  email text NOT NULL,
  company text NOT NULL,
  PRIMARY KEY (run_id, external_id)
);
