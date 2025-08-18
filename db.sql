-- WARNING: This schema is for context only and is not meant to be run.
-- Table order and constraints may not be valid for execution.

CREATE TABLE public.bookings (
  user_id uuid,
  bus_id uuid,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  status text DEFAULT 'pending'::text CHECK (status = ANY (ARRAY['pending'::text, 'confirmed'::text, 'cancelled'::text])),
  created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT bookings_pkey PRIMARY KEY (id),
  CONSTRAINT bookings_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id),
  CONSTRAINT bookings_bus_id_fkey FOREIGN KEY (bus_id) REFERENCES public.buses(id)
);
CREATE TABLE public.buses (
  bus_number text NOT NULL UNIQUE,
  current_location jsonb,
  total_seats integer NOT NULL,
  driver_id uuid,
  conductor_id uuid,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  status text DEFAULT 'active'::text CHECK (status = ANY (ARRAY['active'::text, 'inactive'::text, 'maintenance'::text])),
  available_seats integer DEFAULT 0,
  terminal_id uuid,
  route_id uuid,
  CONSTRAINT buses_pkey PRIMARY KEY (id),
  CONSTRAINT buses_terminal_id_fkey FOREIGN KEY (terminal_id) REFERENCES public.terminals(id),
  CONSTRAINT buses_route_id_fkey FOREIGN KEY (route_id) REFERENCES public.routes(id),
  CONSTRAINT buses_driver_id_fkey FOREIGN KEY (driver_id) REFERENCES public.users(id),
  CONSTRAINT buses_conductor_id_fkey FOREIGN KEY (conductor_id) REFERENCES public.users(id)
);
CREATE TABLE public.feedbacks (
  user_id uuid,
  bus_id uuid,
  rating integer CHECK (rating >= 1 AND rating <= 5),
  comment text,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT feedbacks_pkey PRIMARY KEY (id),
  CONSTRAINT feedbacks_bus_id_fkey FOREIGN KEY (bus_id) REFERENCES public.buses(id),
  CONSTRAINT feedbacks_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id)
);
CREATE TABLE public.notifications (
  title text,
  is_read boolean DEFAULT false,
  priority text DEFAULT 'normal'::text CHECK (priority = ANY (ARRAY['low'::text, 'normal'::text, 'high'::text, 'urgent'::text])),
  read_at timestamp with time zone,
  type text NOT NULL CHECK (type = ANY (ARRAY['delay'::text, 'route_change'::text, 'traffic'::text, 'general'::text, 'announcement'::text, 'maintenance'::text])),
  message text NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  recipient_id uuid NOT NULL,
  CONSTRAINT notifications_pkey PRIMARY KEY (id),
  CONSTRAINT notifications_recipient_id_fkey FOREIGN KEY (recipient_id) REFERENCES public.users(id)
);
CREATE TABLE public.reports (
  employee_id uuid,
  bus_id uuid,
  type text NOT NULL CHECK (type = ANY (ARRAY['maintenance'::text, 'violation'::text, 'delay'::text])),
  description text,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT reports_pkey PRIMARY KEY (id),
  CONSTRAINT reports_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES public.users(id),
  CONSTRAINT reports_bus_id_fkey FOREIGN KEY (bus_id) REFERENCES public.buses(id)
);
CREATE TABLE public.route_stops (
  route_id uuid,
  terminal_id uuid,
  stop_order integer NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  CONSTRAINT route_stops_pkey PRIMARY KEY (id),
  CONSTRAINT route_stops_route_id_fkey FOREIGN KEY (route_id) REFERENCES public.routes(id),
  CONSTRAINT route_stops_terminal_id_fkey FOREIGN KEY (terminal_id) REFERENCES public.terminals(id)
);
CREATE TABLE public.routes (
  name text NOT NULL,
  start_terminal_id uuid,
  end_terminal_id uuid,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  CONSTRAINT routes_pkey PRIMARY KEY (id),
  CONSTRAINT routes_start_terminal_id_fkey FOREIGN KEY (start_terminal_id) REFERENCES public.terminals(id),
  CONSTRAINT routes_end_terminal_id_fkey FOREIGN KEY (end_terminal_id) REFERENCES public.terminals(id)
);
CREATE TABLE public.terminals (
  name text NOT NULL,
  address text NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  CONSTRAINT terminals_pkey PRIMARY KEY (id)
);
CREATE TABLE public.users (
  id uuid NOT NULL,
  role text NOT NULL CHECK (role = ANY (ARRAY['client'::text, 'admin'::text, 'employee'::text, 'driver'::text, 'conductor'::text])),
  username text NOT NULL,
  email text NOT NULL UNIQUE,
  profile jsonb,
  employee_id text UNIQUE,
  assigned_bus_id uuid,
  status text DEFAULT 'active'::text CHECK (status = ANY (ARRAY['active'::text, 'inactive'::text, 'suspended'::text, 'pending'::text])),
  created_by uuid,
  created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT users_pkey PRIMARY KEY (id),
  CONSTRAINT users_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id),
  CONSTRAINT users_assigned_bus_id_fkey FOREIGN KEY (assigned_bus_id) REFERENCES public.buses(id)
);