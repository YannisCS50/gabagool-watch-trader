-- Single-row lease table to enforce only one active runner
CREATE TABLE public.runner_lease (
  id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001'::uuid PRIMARY KEY,
  runner_id text NOT NULL,
  locked_until timestamp with time zone NOT NULL DEFAULT now(),
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

-- Insert the single row
INSERT INTO public.runner_lease (id, runner_id, locked_until)
VALUES ('00000000-0000-0000-0000-000000000001', '', now() - interval '1 hour');

-- Enable RLS
ALTER TABLE public.runner_lease ENABLE ROW LEVEL SECURITY;

-- Public read policy
CREATE POLICY "Allow public read for runner_lease"
  ON public.runner_lease
  FOR SELECT
  USING (true);

-- Service insert/update (runners run with service key)
CREATE POLICY "Allow service insert for runner_lease"
  ON public.runner_lease
  FOR INSERT
  WITH CHECK (true);

CREATE POLICY "Allow service update for runner_lease"
  ON public.runner_lease
  FOR UPDATE
  USING (true);