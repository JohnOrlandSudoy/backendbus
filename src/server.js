const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const cors = require('cors');
const dotenv = require('dotenv');

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
app.get('/api/client/bus-eta/:busId', async (req, res) => {
  try {
    const { data: bus, error } = await supabase
      .from('buses')
      .select('id, bus_number, route_id, current_location, route:routes(name, start_terminal_id, end_terminal_id)')
      .eq('id', req.params.busId)
      .single();
    
    if (error) throw error;
    
    // Calculate ETA (implement your logic here, e.g., with a mapping API)
    res.json({ 
      eta: '15 minutes', 
      currentLocation: bus.current_location,
      route: bus.route,
      busNumber: bus.bus_number
    });
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
app.put('/api/admin/bus/:id/reassign', async (req, res) => {
  try {
    const { driverId, conductorId, route } = req.body;
    const { data: bus, error } = await supabase
      .from('buses')
      .update({ driver_id: driverId, conductor_id: conductorId, route })
      .eq('id', req.params.id)
      .select()
      .single();

    if (error) throw error;
    res.json(bus);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

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
    message.success('Terminal added successfully');
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
    } else if (action === 'remove') {
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

// Get only employee users
app.get('/api/admin/users/employees', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('users')
      .select('*')
      .eq('role', 'employee');
    if (error) throw error;
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));