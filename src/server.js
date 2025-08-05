const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const cors = require('cors');
const dotenv = require('dotenv');
const crypto = require('crypto');

dotenv.config();
const app = express();

// Initialize Supabase
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

// Middleware
app.use(cors());
app.use(express.json());

// Supabase real-time subscriptions
supabase
  .channel('notifications')
  .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'notifications' }, (payload) => {
    // Broadcast new notifications to connected clients
    // You can integrate with a frontend WebSocket client here
    console.log('New notification:', payload);
  })
  .subscribe();

// Client Routes
app.get('/api/client/bus-eta', async (req, res) => {
  try {
    const { data: buses, error } = await supabase
      .from('buses')
      .select('id, bus_number, route_id, current_location, route:routes(name, start_terminal_id, end_terminal_id)')
      .eq('status', 'active');
    
    if (error) throw error;
    
    // Map buses to include ETA (placeholder) and relevant details
    const response = buses.map(bus => ({
      busId: bus.id,
      busNumber: bus.bus_number,
      eta: '15 minutes', // Placeholder: Replace with mapping API logic
      currentLocation: bus.current_location,
      route: bus.route
    }));

    res.json(response);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/client/booking', async (req, res) => {
  try {
    const { userId, busId } = req.body;
    const { data: booking, error } = await supabase
      .from('bookings')
      .insert({ user_id: userId, bus_id: busId })
      .select()
      .single();

    if (error) throw error;

    // Fetch current available seats
    const { data: bus, error: busError } = await supabase
      .from('buses')
      .select('available_seats')
      .eq('id', busId)
      .single();
    if (busError) throw busError;

    // Decrement and update
    const newSeats = bus.available_seats - 1;
    await supabase
      .from('buses')
      .update({ available_seats: newSeats })
      .eq('id', busId);

    res.status(201).json(booking);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/client/bookings', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('bookings')
      .select(`
        *,
        bus:bus_id(bus_number, route:route_id(name)),
        user:user_id(username, email, profile)
      `);
    if (error) throw error;
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/client/feedback', async (req, res) => {
  try {
    const { userId, busId, rating, comment } = req.body;
    const { data: feedback, error } = await supabase
      .from('feedbacks')
      .insert({ user_id: userId, bus_id: busId, rating, comment })
      .select()
      .single();

    if (error) throw error;
    res.status(201).json(feedback);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Admin Routes

app.get('/api/admin/transit-insights', async (req, res) => {
  try {
    const { data: buses, error } = await supabase
      .from('buses')
      .select('*, driver:driver_id(id, username, profile), conductor:conductor_id(id, username, profile)')
      .eq('status', 'active');

    if (error) throw error;
    // Add real-time analytics logic here
    res.json(buses);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Confirm a booking and send notifications
app.put('/api/admin/booking/:id/confirm', async (req, res) => {
  try {
    // 1. Confirm the booking
    const { data: booking, error: bookingError } = await supabase
      .from('bookings')
      .update({ status: 'confirmed' })
      .eq('id', req.params.id)
      .select(`
        *,
        bus:bus_id(*, route:route_id(name)),
        user:user_id(*)
      `)
      .single();

    if (bookingError) throw bookingError;
    if (!booking) return res.status(404).json({ error: 'Booking not found' });

    // 2. Prepare notification details
    const { bus, user } = booking;
    const driverId = bus.driver_id;
    const conductorId = bus.conductor_id;
    const clientId = user.id;

    const notifications = [];

    // 3. Create notification for the client
    notifications.push({
      recipient_id: clientId,
      type: 'booking_confirmed',
      message: `Your booking for bus ${bus.bus_number} (${bus.route.name}) has been confirmed.`
    });

    // 4. Create notification for the driver
    if (driverId) {
      notifications.push({
        recipient_id: driverId,
        type: 'new_passenger',
        message: `New passenger: ${user.profile?.fullName || user.username} has booked a seat on your bus.`
      });
    }

    // 5. Create notification for the conductor
    if (conductorId) {
      notifications.push({
        recipient_id: conductorId,
        type: 'new_passenger',
        message: `New passenger: ${user.profile?.fullName || user.username} has booked a seat on your bus.`
      });
    }

    // 6. Insert all notifications
    if (notifications.length > 0) {
      const { error: notificationError } = await supabase
        .from('notifications')
        .insert(notifications);
      if (notificationError) throw notificationError;
    }

    res.json(booking);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/admin/notification', async (req, res) => {
  try {
    const { recipientId, type, message } = req.body;
    const { data: notification, error } = await supabase
      .from('notifications')
      .insert({ recipient_id: recipientId, type, message })
      .select()
      .single();

    if (error) throw error;
    res.status(201).json(notification);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// --- Report Management (Admin) ---
// Get all reports
app.get('/api/admin/reports', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('reports')
      .select(`
        id,
        type,
        description,
        created_at,
        employee:employee_id(id, username, email, profile),
        bus:bus_id(id, bus_number)
      `)
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// --- Terminals ---
// Add Terminal
app.post('/api/admin/terminal', async (req, res) => {
  try {
    const { name, address } = req.body;
    const { data, error } = await supabase
      .from('terminals')
      .insert([{ name, address }])
      .select()
      .single();
    if (error) throw error;
    res.status(201).json(data);
    // Note: Removed message.success as it's not defined in Node.js (likely frontend code)
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// List Terminals
app.get('/api/admin/terminals', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('terminals')
      .select('*');
    if (error) throw error;
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Edit Terminal
app.put('/api/admin/terminal/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { name, address } = req.body;

    // Validate required fields
    if (!name || !address) {
      return res.status(400).json({ error: 'Name and address are required' });
    }

    // Check if terminal exists
    const { data: existingTerminal, error: checkError } = await supabase
      .from('terminals')
      .select('id')
      .eq('id', id)
      .single();

    if (checkError || !existingTerminal) {
      return res.status(404).json({ error: 'Terminal not found' });
    }

    // Update terminal
    const { data, error } = await supabase
      .from('terminals')
      .update({ name, address })
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Delete Terminal
app.delete('/api/admin/terminal/:id', async (req, res) => {
  try {
    const { id } = req.params;

    // Check if terminal exists
    const { data: existingTerminal, error: checkError } = await supabase
      .from('terminals')
      .select('id')
      .eq('id', id)
      .single();

    if (checkError || !existingTerminal) {
      return res.status(404).json({ error: 'Terminal not found' });
    }

    // Check if terminal is being used by any routes
    const { data: routesUsingTerminal, error: routesError } = await supabase
      .from('routes')
      .select('id, name')
      .or(`start_terminal_id.eq.${id},end_terminal_id.eq.${id}`);

    if (routesError) throw routesError;

    if (routesUsingTerminal && routesUsingTerminal.length > 0) {
      return res.status(400).json({
        error: 'Cannot delete terminal',
        message: 'Terminal is being used by routes',
        routes: routesUsingTerminal.map(route => ({ id: route.id, name: route.name }))
      });
    }

    // Check if terminal is being used by any route stops
    const { data: stopsUsingTerminal, error: stopsError } = await supabase
      .from('route_stops')
      .select('id, route_id')
      .eq('terminal_id', id);

    if (stopsError) throw stopsError;

    if (stopsUsingTerminal && stopsUsingTerminal.length > 0) {
      return res.status(400).json({
        error: 'Cannot delete terminal',
        message: 'Terminal is being used as a stop in routes',
        stops: stopsUsingTerminal
      });
    }

    // Delete terminal
    const { error } = await supabase
      .from('terminals')
      .delete()
      .eq('id', id);

    if (error) throw error;
    res.json({ message: 'Terminal deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// --- Routes ---
// Add Route (with stops)
app.post('/api/admin/route', async (req, res) => {
  try {
    const { name, start_terminal_id, end_terminal_id, stops } = req.body;
    const { data: route, error: routeError } = await supabase
      .from('routes')
      .insert([{ name, start_terminal_id, end_terminal_id }])
      .select()
      .single();
    if (routeError) throw routeError;
    // Insert stops if provided
    if (Array.isArray(stops) && stops.length > 0) {
      const stopsData = stops.map((terminal_id, idx) => ({
        route_id: route.id,
        terminal_id,
        stop_order: idx + 1
      }));
      const { error: stopsError } = await supabase
        .from('route_stops')
        .insert(stopsData);
      if (stopsError) throw stopsError;
    }
    res.status(201).json(route);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// List Routes (with stops)
app.get('/api/admin/routes', async (req, res) => {
  try {
    // Get all routes
    const { data: routes, error: routesError } = await supabase
      .from('routes')
      .select('*');
    if (routesError) throw routesError;
    // Get all stops
    const { data: stops, error: stopsError } = await supabase
      .from('route_stops')
      .select('*');
    if (stopsError) throw stopsError;
    // Attach stops to routes
    const routesWithStops = routes.map(route => ({
      ...route,
      stops: stops.filter(stop => stop.route_id === route.id)
    }));
    res.json(routesWithStops);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Edit Route
app.put('/api/admin/route/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { name, start_terminal_id, end_terminal_id, stops } = req.body;

    // Validate required fields
    if (!name || !start_terminal_id || !end_terminal_id) {
      return res.status(400).json({ error: 'Name, start_terminal_id, and end_terminal_id are required' });
    }

    // Check if route exists
    const { data: existingRoute, error: checkError } = await supabase
      .from('routes')
      .select('id')
      .eq('id', id)
      .single();

    if (checkError || !existingRoute) {
      return res.status(404).json({ error: 'Route not found' });
    }

    // Validate terminals exist
    const { data: terminals, error: terminalsError } = await supabase
      .from('terminals')
      .select('id')
      .in('id', [start_terminal_id, end_terminal_id]);

    if (terminalsError) throw terminalsError;

    if (terminals.length !== 2) {
      return res.status(400).json({ error: 'Start or end terminal not found' });
    }

    // Update route
    const { data: updatedRoute, error: routeError } = await supabase
      .from('routes')
      .update({ name, start_terminal_id, end_terminal_id })
      .eq('id', id)
      .select()
      .single();

    if (routeError) throw routeError;

    // Update stops if provided
    if (Array.isArray(stops)) {
      // Delete existing stops
      await supabase
        .from('route_stops')
        .delete()
        .eq('route_id', id);

      // Insert new stops if any
      if (stops.length > 0) {
        const stopsData = stops.map((terminal_id, idx) => ({
          route_id: id,
          terminal_id,
          stop_order: idx + 1
        }));

        const { error: stopsError } = await supabase
          .from('route_stops')
          .insert(stopsData);

        if (stopsError) throw stopsError;
      }
    }

    // Get updated route with stops
    const { data: finalRoute, error: finalError } = await supabase
      .from('routes')
      .select('*')
      .eq('id', id)
      .single();

    if (finalError) throw finalError;

    // Get stops for the route
    const { data: routeStops, error: stopsError } = await supabase
      .from('route_stops')
      .select('*')
      .eq('route_id', id);

    if (stopsError) throw stopsError;

    const routeWithStops = {
      ...finalRoute,
      stops: routeStops || []
    };

    res.json(routeWithStops);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Delete Route
app.delete('/api/admin/route/:id', async (req, res) => {
  try {
    const { id } = req.params;

    // Check if route exists
    const { data: existingRoute, error: checkError } = await supabase
      .from('routes')
      .select('id, name')
      .eq('id', id)
      .single();

    if (checkError || !existingRoute) {
      return res.status(404).json({ error: 'Route not found' });
    }

    // Check if route is being used by any buses
    const { data: busesUsingRoute, error: busesError } = await supabase
      .from('buses')
      .select('id, bus_number')
      .eq('route_id', id);

    if (busesError) throw busesError;

    if (busesUsingRoute && busesUsingRoute.length > 0) {
      return res.status(400).json({
        error: 'Cannot delete route',
        message: 'Route is being used by buses',
        buses: busesUsingRoute.map(bus => ({ id: bus.id, bus_number: bus.bus_number }))
      });
    }

    // Delete route stops first (due to foreign key constraint)
    await supabase
      .from('route_stops')
      .delete()
      .eq('route_id', id);

    // Delete route
    const { error } = await supabase
      .from('routes')
      .delete()
      .eq('id', id);

    if (error) throw error;
    res.json({ message: 'Route deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get single terminal by ID
app.get('/api/admin/terminal/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { data, error } = await supabase
      .from('terminals')
      .select('*')
      .eq('id', id)
      .single();

    if (error) {
      return res.status(404).json({ error: 'Terminal not found' });
    }

    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get single route by ID (with stops)
app.get('/api/admin/route/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    // Get route
    const { data: route, error: routeError } = await supabase
      .from('routes')
      .select('*')
      .eq('id', id)
      .single();

    if (routeError) {
      return res.status(404).json({ error: 'Route not found' });
    }

    // Get stops for the route
    const { data: stops, error: stopsError } = await supabase
      .from('route_stops')
      .select('*')
      .eq('route_id', id)
      .order('stop_order', { ascending: true });

    if (stopsError) throw stopsError;

    const routeWithStops = {
      ...route,
      stops: stops || []
    };

    res.json(routeWithStops);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// --- Buses ---
// Register New Bus
app.post('/api/admin/bus', async (req, res) => {
  try {
    const { bus_number, total_seats, terminal_id, route_id } = req.body;
    const { data, error } = await supabase
      .from('buses')
      .insert([{ bus_number, total_seats, available_seats: total_seats, terminal_id, route_id }])
      .select()
      .single();
    if (error) throw error;
    res.status(201).json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// List Buses (for fleet)
app.get('/api/admin/buses', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('buses')
      .select('*');
    if (error) throw error;
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// --- Live Map ---
// Get all bus locations
app.get('/api/admin/bus-locations', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('buses')
      .select('id, bus_number, current_location');
    if (error) throw error;
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Employee Routes
app.post('/api/employee/report', async (req, res) => {
  try {
    const { employeeId, busId, type, description } = req.body;
    const { data: report, error } = await supabase
      .from('reports')
      .insert({ employee_id: employeeId, bus_id: busId, type, description })
      .select()
      .single();

    if (error) throw error;
    res.status(201).json(report);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.put('/api/employee/passenger-count/:busId', async (req, res) => {
  try {
    const { action } = req.body; // 'add' or 'remove'

    // 1. Fetch current available_seats
    const { data: bus, error: fetchError } = await supabase
      .from('buses')
      .select('available_seats')
      .eq('id', req.params.busId)
      .single();
    if (fetchError) throw fetchError;

    // 2. Calculate new value
    let newSeats = bus.available_seats;
    if (action === 'add') {
      newSeats = bus.available_seats - 1;
    }
    else if (action === 'remove') {
      newSeats = bus.available_seats + 1;
    }

    // 3. Update the value
    const { data: updatedBus, error: updateError } = await supabase
      .from('buses')
      .update({ available_seats: newSeats })
      .eq('id', req.params.busId)
      .select()
      .single();
    if (updateError) throw updateError;

    res.json(updatedBus);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Authentication Routes (using Supabase Auth)
app.post('/api/auth/signup', async (req, res) => {
  try {
    const { email, password, username, role, profile } = req.body;
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: { data: { username, role } }
    });

    if (error) throw error;

    // Insert additional user data
    await supabase
      .from('users')
      .insert({ id: data.user.id, username, email, role, profile });

    res.status(201).json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password
    });

    if (error) throw error;
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// --- User Management (Admin) ---
// Get all users
app.get('/api/admin/users', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('users')
      .select('*');
    if (error) throw error;
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get only client users
app.get('/api/admin/users/clients', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('users')
      .select('*')
      .eq('role', 'client');
    if (error) throw error;
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get only employee users (all employee types)
app.get('/api/admin/users/employees', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('users')
      .select('*')
      .in('role', ['employee', 'driver', 'conductor'])
      .order('created_at', { ascending: false });
    if (error) throw error;
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get only drivers
app.get('/api/admin/users/drivers', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('users')
      .select('id, username, employee_id, email, profile, assigned_bus_id, status, created_at')
      .eq('role', 'driver')
      .order('created_at', { ascending: false });
    if (error) throw error;
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get only conductors
app.get('/api/admin/users/conductors', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('users')
      .select('id, username, employee_id, email, profile, assigned_bus_id, status, created_at')
      .eq('role', 'conductor')
      .order('created_at', { ascending: false });
    if (error) throw error;
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Confirm employee account
app.put('/api/admin/employee/:id/confirm', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('users')
      .update({ status: 'active' })
      .eq('id', req.params.id)
      .select()
      .single();

    if (error) throw error;
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get employee by ID
app.get('/api/admin/employee/:id', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('users')
      .select('id, username, email, role, profile, status, assigned_bus_id')
      .eq('id', req.params.id)
      .in('role', ['driver', 'conductor', 'employee'])
      .single();

    if (error) {
      return res.status(404).json({ error: 'Employee not found' });
    }

    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// --- Employee Management (Admin) ---
// Create new employee account
app.post('/api/admin/employee/create', async (req, res) => {
  try {
    const {
      fullName,
      phone,
      role, // 'driver' or 'conductor'
      email, // Employee's real email
      password, // Employee's password
      busId // Optional: assign to bus immediately
    } = req.body;

    // Validate required fields
    if (!fullName || !phone || !role || !email || !password) {
      return res.status(400).json({
        error: 'Missing required fields: fullName, phone, role, email, password'
      });
    }

    // Validate role
    if (!['driver', 'conductor'].includes(role)) {
      return res.status(400).json({
        error: 'Role must be either "driver" or "conductor"'
      });
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({
        error: 'Invalid email format'
      });
    }

    // Check if email already exists
    const { data: existingEmployee } = await supabase
      .from('users')
      .select('email')
      .eq('email', email)
      .single();

    if (existingEmployee) {
      return res.status(400).json({
        error: 'Email already exists'
      });
    }

    // 1. Create auth user (with email confirmation disabled in Supabase settings)
    console.log('Creating Supabase auth user with email:', email);
    const { data: authData, error: authError } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: { username: email.split('@')[0], role },
        emailRedirectTo: undefined // No email confirmation needed
      }
    });

    if (authError) {
      console.log('Supabase auth signup error:', authError);
      throw authError;
    }

    console.log('Supabase auth user created:', authData.user?.id);

    // 2. Create user profile
    const { data: userData, error: userError } = await supabase
      .from('users')
      .insert({
        id: authData.user.id,
        username: email.split('@')[0], // Use email prefix as username
        email,
        role,
        employee_id: null, // Remove employee_id since we're using email
        assigned_bus_id: busId || null,
        profile: {
          fullName,
          phone,
          position: role,
          created_date: new Date().toISOString()
        },
        status: 'pending'
      })
      .select()
      .single();

    if (userError) throw userError;

    // If bus assigned, update bus table
    if (busId) {
      const updateField = role === 'driver' ? 'driver_id' : 'conductor_id';
      await supabase
        .from('buses')
        .update({ [updateField]: userData.id })
        .eq('id', busId);
    }

    res.status(201).json({
      employee: userData,
      credentials: {
        email,
        password,
        message: "Employee can login with their email and password"
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Employee login with Email and Password
app.post('/api/auth/employee-login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        error: 'Email and password are required'
      });
    }

    // Check if user exists and is an employee
    const { data: employee, error: empError } = await supabase
      .from('users')
      .select('id, email, role, assigned_bus_id, status, profile, username')
      .eq('email', email)
      .in('role', ['driver', 'conductor', 'employee'])
      .single();

    if (empError) {
      console.log('Employee lookup error:', empError);
      return res.status(404).json({ error: 'Employee not found' });
    }

    console.log('Found employee:', { email: employee.email, role: employee.role, status: employee.status });

    if (employee.status !== 'active') {
      return res.status(403).json({ error: 'Employee account is not active' });
    }

    // Login with email using Supabase auth
    console.log('Attempting login with email:', employee.email);
    const { data, error } = await supabase.auth.signInWithPassword({
      email: employee.email,
      password
    });

    if (error) {
      console.log('Supabase auth error:', error);
      return res.status(401).json({
        error: 'Invalid credentials',
        debug: error.message
      });
    }

    res.json({
      success: true,
      session: data.session,
      employee: {
        id: data.user.id,
        email: employee.email,
        username: employee.username,
        role: employee.role,
        assignedBusId: employee.assigned_bus_id,
        profile: {
          fullName: employee.profile?.fullName,
          phone: employee.profile?.phone,
          position: employee.profile?.position
        }
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get employee's notifications
app.get('/api/employee/notifications', async (req, res) => {
  try {
    const { employeeId } = req.query;
    if (!employeeId) {
      return res.status(400).json({ error: 'Employee ID is required' });
    }
    
    const { data, error } = await supabase
      .from('notifications')
      .select('*')
      .eq('recipient_id', employeeId)
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get client's notifications
app.get('/api/client/notifications', async (req, res) => {
  try {
    const { userId } = req.query;
    if (!userId) {
      return res.status(400).json({ error: 'User ID is required' });
    }

    const { data, error } = await supabase
      .from('notifications')
      .select('*')
      .eq('recipient_id', userId)
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get employee's assigned bus info
app.get('/api/employee/my-bus', async (req, res) => {
  try {
    const { email } = req.query;

    if (!email) {
      return res.status(400).json({ error: 'Employee email is required' });
    }

    const { data: employee, error: empError } = await supabase
      .from('users')
      .select(`
        assigned_bus_id,
        role,
        bus:assigned_bus_id(
          id,
          bus_number,
          total_seats,
          available_seats,
          current_location,
          status,
          route:route_id(name, start_terminal_id, end_terminal_id)
        )
      `)
      .eq('email', email)
      .in('role', ['driver', 'conductor', 'employee'])
      .single();

    if (empError) {
      return res.status(404).json({ error: 'Employee not found' });
    }

    if (!employee.assigned_bus_id) {
      return res.json({ message: 'No bus assigned', bus: null });
    }

    res.json({
      role: employee.role,
      bus: employee.bus
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Assign employee to bus
app.put('/api/admin/employee/assign-bus', async (req, res) => {
  try {
    const { busId, email } = req.body;

    if (!busId || !email) {
      return res.status(400).json({ error: 'Bus ID and employee email are required' });
    }

    // Get employee details
    const { data: employee, error: empError } = await supabase
      .from('users')
      .select('id, role, username, profile, status')
      .eq('email', email)
      .in('role', ['driver', 'conductor', 'employee'])
      .single();

    if (empError) {
      return res.status(404).json({ error: 'Employee not found' });
    }

    // Check if employee is active
    if (employee.status !== 'active') {
      return res.status(403).json({ error: 'Employee account must be active before assignment' });
    }

    // Update user's assigned bus
    await supabase
      .from('users')
      .update({ assigned_bus_id: busId })
      .eq('email', email);

    // Update bus assignment
    const updateField = employee.role === 'driver' ? 'driver_id' : 'conductor_id';
    const { data: updatedBus, error: busError } = await supabase
      .from('buses')
      .update({ [updateField]: employee.id })
      .eq('id', busId)
      .select()
      .single();

    if (busError) throw busError;

    res.json({
      message: `${employee.role} ${employee.profile?.fullName || employee.username} assigned to bus successfully`,
      bus: updatedBus
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// --- Feedback Management (Admin) ---
// Get all feedback submissions
app.get('/api/admin/feedbacks', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('feedbacks')
      .select(`
        id,
        rating,
        comment,
        created_at,
        user:user_id(id, username, email, profile),
        bus:bus_id(id, bus_number, route_id, route:route_id(name))
      `)
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get feedback by bus ID
app.get('/api/admin/feedbacks/bus/:busId', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('feedbacks')
      .select(`
        id,
        rating,
        comment,
        created_at,
        user:user_id(id, username, email, profile)
      `)
      .eq('bus_id', req.params.busId)
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get feedback statistics
app.get('/api/admin/feedbacks/stats', async (req, res) => {
  try {
    // Get overall feedback stats
    const { data: allFeedbacks, error: feedbackError } = await supabase
      .from('feedbacks')
      .select('rating, bus_id');

    if (feedbackError) throw feedbackError;

    // Calculate statistics
    const totalFeedbacks = allFeedbacks.length;
    const averageRating = totalFeedbacks > 0
      ? (allFeedbacks.reduce((sum, feedback) => sum + feedback.rating, 0) / totalFeedbacks).toFixed(2)
      : 0;

    // Rating distribution
    const ratingDistribution = {
      1: allFeedbacks.filter(f => f.rating === 1).length,
      2: allFeedbacks.filter(f => f.rating === 2).length,
      3: allFeedbacks.filter(f => f.rating === 3).length,
      4: allFeedbacks.filter(f => f.rating === 4).length,
      5: allFeedbacks.filter(f => f.rating === 5).length
    };

    // Bus-wise feedback count
    const busFeedbackCount = allFeedbacks.reduce((acc, feedback) => {
      acc[feedback.bus_id] = (acc[feedback.bus_id] || 0) + 1;
      return acc;
    }, {});

    const stats = {
      totalFeedbacks,
      averageRating: parseFloat(averageRating),
      ratingDistribution,
      busFeedbackCount
    };

    res.json(stats);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get feedback by user ID
app.get('/api/admin/feedbacks/user/:userId', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('feedbacks')
      .select(`
        id,
        rating,
        comment,
        created_at,
        bus:bus_id(id, bus_number, route_id, route:route_id(name))
      `)
      .eq('user_id', req.params.userId)
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));