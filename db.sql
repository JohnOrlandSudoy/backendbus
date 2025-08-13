-- WARNING: This schema is for context only and is not meant to be run.
-- Table order and constraints may not be valid for execution.

CREATE TABLE public.bookings (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id uuid,
  bus_id uuid,
  status text DEFAULT 'pending'::text CHECK (status = ANY (ARRAY['pending'::text, 'confirmed'::text, 'cancelled'::text])),
  created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT bookings_pkey PRIMARY KEY (id),
  CONSTRAINT bookings_bus_id_fkey FOREIGN KEY (bus_id) REFERENCES public.buses(id),
  CONSTRAINT bookings_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id)
);
CREATE TABLE public.buses (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  bus_number text NOT NULL UNIQUE,
  current_location jsonb,
  status text DEFAULT 'active'::text CHECK (status = ANY (ARRAY['active'::text, 'inactive'::text, 'maintenance'::text])),
  available_seats integer DEFAULT 0,
  total_seats integer NOT NULL,
  driver_id uuid,
  conductor_id uuid,
  terminal_id uuid,
  route_id uuid,
  CONSTRAINT buses_pkey PRIMARY KEY (id),
  CONSTRAINT buses_route_id_fkey FOREIGN KEY (route_id) REFERENCES public.routes(id),
  CONSTRAINT buses_terminal_id_fkey FOREIGN KEY (terminal_id) REFERENCES public.terminals(id),
  CONSTRAINT buses_conductor_id_fkey FOREIGN KEY (conductor_id) REFERENCES public.users(id),
  CONSTRAINT buses_driver_id_fkey FOREIGN KEY (driver_id) REFERENCES public.users(id)
);
CREATE TABLE public.feedbacks (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id uuid,
  bus_id uuid,
  rating integer CHECK (rating >= 1 AND rating <= 5),
  comment text,
  created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT feedbacks_pkey PRIMARY KEY (id),
  CONSTRAINT feedbacks_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id),
  CONSTRAINT feedbacks_bus_id_fkey FOREIGN KEY (bus_id) REFERENCES public.buses(id)
);
CREATE TABLE public.notifications (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  recipient_id uuid,
  type text NOT NULL CHECK (type = ANY (ARRAY['delay'::text, 'route_change'::text, 'traffic'::text, 'general'::text, 'announcement'::text, 'maintenance'::text])),
  title text,
  message text NOT NULL,
  is_read boolean DEFAULT false,
  priority text DEFAULT 'normal'::text CHECK (priority = ANY (ARRAY['low'::text, 'normal'::text, 'high'::text, 'urgent'::text])),
  read_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT notifications_pkey PRIMARY KEY (id),
  CONSTRAINT notifications_recipient_id_fkey FOREIGN KEY (recipient_id) REFERENCES public.users(id)
);
CREATE TABLE public.reports (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  employee_id uuid,
  bus_id uuid,
  type text NOT NULL CHECK (type = ANY (ARRAY['maintenance'::text, 'violation'::text, 'delay'::text])),
  description text,
  created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT reports_pkey PRIMARY KEY (id),
  CONSTRAINT reports_bus_id_fkey FOREIGN KEY (bus_id) REFERENCES public.buses(id),
  CONSTRAINT reports_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES public.users(id)
);
CREATE TABLE public.route_stops (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  route_id uuid,
  terminal_id uuid,
  stop_order integer NOT NULL,
  CONSTRAINT route_stops_pkey PRIMARY KEY (id),
  CONSTRAINT route_stops_route_id_fkey FOREIGN KEY (route_id) REFERENCES public.routes(id),
  CONSTRAINT route_stops_terminal_id_fkey FOREIGN KEY (terminal_id) REFERENCES public.terminals(id)
);
CREATE TABLE public.routes (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  name text NOT NULL,
  start_terminal_id uuid,
  end_terminal_id uuid,
  CONSTRAINT routes_pkey PRIMARY KEY (id),
  CONSTRAINT routes_start_terminal_id_fkey FOREIGN KEY (start_terminal_id) REFERENCES public.terminals(id),
  CONSTRAINT routes_end_terminal_id_fkey FOREIGN KEY (end_terminal_id) REFERENCES public.terminals(id)
);
CREATE TABLE public.terminals (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  name text NOT NULL,
  address text NOT NULL,
  CONSTRAINT terminals_pkey PRIMARY KEY (id)
);
CREATE TABLE public.users (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
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
  CONSTRAINT users_assigned_bus_id_fkey FOREIGN KEY (assigned_bus_id) REFERENCES public.buses(id),
  CONSTRAINT users_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id)
);

-- Create indexes for better performance
CREATE INDEX idx_notifications_recipient_id ON public.notifications(recipient_id);
CREATE INDEX idx_notifications_type ON public.notifications(type);
CREATE INDEX idx_notifications_is_read ON public.notifications(is_read);
CREATE INDEX idx_notifications_created_at ON public.notifications(created_at);
CREATE INDEX idx_notifications_priority ON public.notifications(priority);

CREATE INDEX idx_bookings_user_id ON public.bookings(user_id);
CREATE INDEX idx_bookings_bus_id ON public.bookings(bus_id);
CREATE INDEX idx_bookings_status ON public.bookings(status);

CREATE INDEX idx_buses_route_id ON public.buses(route_id);
CREATE INDEX idx_buses_status ON public.buses(status);
CREATE INDEX idx_buses_driver_id ON public.buses(driver_id);

CREATE INDEX idx_users_role ON public.users(role);
CREATE INDEX idx_users_status ON public.users(status);
CREATE INDEX idx_users_email ON public.users(email);