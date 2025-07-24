-- Users table (Supabase auth.users is used for authentication, this is for additional profile data)
CREATE TABLE users (
  id UUID PRIMARY KEY REFERENCES auth.users(id),
  role TEXT CHECK (role IN ('client', 'admin', 'employee')) NOT NULL,
  username TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  profile JSONB -- Stores name, phone, address
);

-- Buses table
CREATE TABLE buses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bus_number TEXT NOT NULL UNIQUE,
  route TEXT NOT NULL,
  current_location JSONB, -- Stores { lat: number, lng: number }
  status TEXT CHECK (status IN ('active', 'inactive', 'maintenance')) DEFAULT 'active',
  available_seats INTEGER DEFAULT 0,
  total_seats INTEGER NOT NULL,
  driver_id UUID REFERENCES users(id),
  conductor_id UUID REFERENCES users(id)
);

-- Bookings table
CREATE TABLE bookings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id),
  bus_id UUID REFERENCES buses(id),
  status TEXT CHECK (status IN ('pending', 'confirmed', 'cancelled')) DEFAULT 'pending',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Notifications table
CREATE TABLE notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  recipient_id UUID REFERENCES users(id),
  type TEXT CHECK (type IN ('delay', 'route_change', 'traffic', 'general')) NOT NULL,
  message TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Feedback table
CREATE TABLE feedbacks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id),
  bus_id UUID REFERENCES buses(id),
  rating INTEGER CHECK (rating >= 1 AND rating <= 5),
  comment TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Reports table
CREATE TABLE reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id UUID REFERENCES users(id),
  bus_id UUID REFERENCES buses(id),
  type TEXT CHECK (type IN ('maintenance', 'violation', 'delay')) NOT NULL,
  description TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Terminals table
CREATE TABLE terminals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  address TEXT NOT NULL
);

-- Routes table
CREATE TABLE routes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  start_terminal_id UUID REFERENCES terminals(id),
  end_terminal_id UUID REFERENCES terminals(id)
);

-- Route stops (for intermediate stops)
CREATE TABLE route_stops (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  route_id UUID REFERENCES routes(id),
  terminal_id UUID REFERENCES terminals(id),
  stop_order INTEGER NOT NULL
);

-- Update buses table to reference terminal and route
ALTER TABLE buses ADD COLUMN terminal_id UUID REFERENCES terminals(id);
ALTER TABLE buses ADD COLUMN route_id UUID REFERENCES routes(id);

-- Enable real-time for notifications
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow read for all" ON notifications FOR SELECT USING (true);
CREATE POLICY "Allow insert for authenticated" ON notifications FOR INSERT WITH CHECK (auth.role() = 'authenticated');
-- Remove the old route column from buses table (no longer needed)
ALTER TABLE buses DROP COLUMN route;