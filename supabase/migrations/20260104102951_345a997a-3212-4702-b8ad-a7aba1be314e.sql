-- Add unique constraint on client_order_id for upsert support
ALTER TABLE public.orders ADD CONSTRAINT orders_client_order_id_key UNIQUE (client_order_id);