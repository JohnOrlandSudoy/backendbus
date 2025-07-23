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
      .select('id, bus_number, route, current_location')
      .eq('id', req.params.busId)
      .single();
    
    if (error) throw error;
    
    // Calculate ETA (implement your logic here, e.g., with a mapping API)
    res.json({ eta: '15 minutes', currentLocation: bus.current_location });
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

    // Update available seats
    await supabase
      .from('buses')
      .update({ available_seats: supabase.raw('available_seats - 1') })
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
    const update = action === 'add'
      ? { available_seats: supabase.raw('available_seats - 1') }
      : { available_seats: supabase.raw('available_seats + 1') };
    const { data: bus, error } = await supabase
      .from('buses')
      .update(update)
      .eq('id', req.params.busId)
      .select()
      .single();

    if (error) throw error;
    res.json(bus);
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

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));