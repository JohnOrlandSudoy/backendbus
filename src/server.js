// Get notifications for a specific client by user id
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const cors = require('cors');
const dotenv = require('dotenv');
const Stripe = require('stripe');
const sgMail = require('@sendgrid/mail');
const crypto = require('crypto');

dotenv.config();
const app = express();

// Initialize Stripe and SendGrid if keys are present
const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2022-11-15' }) : null;
if (process.env.SENDGRID_API_KEY) {
  sgMail.setApiKey(process.env.SENDGRID_API_KEY);
}

// Startup diagnostics for Stripe configuration (safe, masked output)
try {
  const hasStripeKey = Boolean(process.env.STRIPE_SECRET_KEY);
  const hasWebhookSecret = Boolean(process.env.STRIPE_WEBHOOK_SECRET);
  if (!hasStripeKey) {
    console.warn('⚠️  Stripe secret key not found in environment (STRIPE_SECRET_KEY). Stripe will be disabled.');
  } else {
    const masked = process.env.STRIPE_SECRET_KEY.replace(/.(?=.{4})/g, '*');
    console.debug(`🔒 STRIPE_SECRET_KEY present: ${masked}`);
  }
  if (!hasWebhookSecret) {
    console.warn('⚠️  Stripe webhook secret (STRIPE_WEBHOOK_SECRET) not configured. Webhook signature verification will fail if used.');
  } else {
    const maskedHook = process.env.STRIPE_WEBHOOK_SECRET.replace(/.(?=.{4})/g, '*');
    console.debug(`🔐 STRIPE_WEBHOOK_SECRET present: ${maskedHook}`);
  }
  if (!stripe) {
    console.warn('ℹ️  Stripe client not initialized. Calls to payment endpoints will return "Stripe is not configured".');
  } else {
    console.log('✅ Stripe client initialized.');
  }
} catch (diagErr) {
  console.error('Error while checking Stripe environment variables:', diagErr);
}

// Initialize Supabase
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

// Middleware
app.use(cors());
app.use(express.json());

// For Stripe webhook handling
app.use('/webhook', express.raw({ type: 'application/json' }));

// Helper: send simple receipt email via SendGrid (if configured)
// Create a Stripe checkout session
app.post('/api/create-payment-session', async (req, res) => {
  if (!stripe) {
    return res.status(500).json({ error: 'Stripe is not configured' });
  }

  try {
    const { userId, busId, seats, totalPrice, routeName, date } = req.body;

    // Create a pending booking in the database
    const { data: booking, error: bookingError } = await supabase
      .from('bookings')
      .insert([{
        user_id: userId,
        bus_id: busId,
        seats: seats,
        status: 'pending',
        payment_status: 'pending',
        payment_method: 'online',
        amount: totalPrice,
        created_at: new Date().toISOString()
      }])
      .select()
      .single();

    if (bookingError) throw bookingError;

    // Create Stripe checkout session
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: {
            name: `Bus Booking - ${routeName}`,
            description: `${seats.length} seat(s) for ${date}`,
          },
          unit_amount: totalPrice * 100, // Stripe expects amounts in cents
        },
        quantity: 1,
      }],
      mode: 'payment',
      success_url: `${process.env.CLIENT_URL}/booking/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.CLIENT_URL}/booking/cancel`,
      customer_email: booking.user_email,
      metadata: {
        booking_id: booking.id,
        user_id: userId,
        seats: seats.join(','),
        route_name: routeName,
        date: date
      }
    });

    // Update booking with session ID
    await supabase
      .from('bookings')
      .update({ payment_intent_id: session.payment_intent })
      .eq('id', booking.id);

    res.json({ sessionId: session.id });
  } catch (error) {
    console.error('Payment session creation failed:', error);
    res.status(500).json({ error: error.message });
  }
});

// Handle Stripe webhook
app.post('/webhook', async (req, res) => {
  if (!stripe) {
    return res.status(500).json({ error: 'Stripe is not configured' });
  }

  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      
      // Update booking status
      const { error: updateError } = await supabase
        .from('bookings')
        .update({ 
          payment_status: 'paid',
          status: 'confirmed',
          payment_intent_id: session.payment_intent,
          updated_at: new Date().toISOString()
        })
        .eq('id', session.metadata.booking_id);

      if (updateError) throw updateError;

      // Send receipt email
      await sendReceiptEmail({
        to: session.customer_email,
        booking: {
          id: session.metadata.booking_id,
          payment_intent_id: session.payment_intent
        },
        totalPrice: session.amount_total / 100,
        seats: session.metadata.seats.split(','),
        routeName: session.metadata.route_name,
        date: session.metadata.date
      });
    }

    res.json({ received: true });
  } catch (error) {
    console.error('Webhook processing failed:', error);
    res.status(500).json({ error: error.message });
  }
});

const sendReceiptEmail = async ({ to, booking, totalPrice, seats, routeName, date }) => {
  if (!process.env.SENDGRID_API_KEY) return false;
  try {
    const msg = {
      to,
      from: process.env.FROM_EMAIL || 'no-reply@auroride.com',
      subject: `AuroRide Booking Receipt — ${booking.id}`,
      html: `
        <h2>AuroRide - Booking Receipt</h2>
        <p><strong>Booking ID:</strong> ${booking.id}</p>
        <p><strong>Route:</strong> ${routeName || 'N/A'}</p>
        <p><strong>Date:</strong> ${date || 'N/A'}</p>
        <p><strong>Seats:</strong> ${seats.join(', ')}</p>
        <p><strong>Total:</strong> $${totalPrice}</p>
        <p>If you have questions, reply to this email or contact our support.</p>
      `,
    };
    await sgMail.send(msg);
    return true;
  } catch (err) {
    console.error('Failed to send receipt email', err);
    return false;
  }
};



// Enhanced Supabase real-time subscriptions for notifications
const notificationChannels = new Map();
const sseClientsByUser = new Map(); // userId -> Set<res>

// Broadcast helper to push events to all SSE clients for a given user
const broadcastToUser = (userId, event) => {
  const clients = sseClientsByUser.get(String(userId));
  if (!clients || clients.size === 0) return;
  const payload = JSON.stringify(event);
  clients.forEach((res) => {
    try {
      res.write(`data: ${payload}\n\n`);
    } catch (err) {
      // Drop broken clients silently
    }
  });
};

// Function to create notification channel for a specific user
const createNotificationChannel = (userId) => {
  if (notificationChannels.has(userId)) {
    return notificationChannels.get(userId);
  }

  const channel = supabase
    .channel(`notifications_${userId}`)
    .on('postgres_changes', 
      { 
        event: 'INSERT', 
        schema: 'public', 
        table: 'notifications',
        filter: `recipient_id=eq.${userId}`
      }, 
      (payload) => {
        // New notification for this user
        broadcastToUser(userId, { type: 'notification.insert', data: payload.new });
      }
    )
    .on('postgres_changes',
      {
        event: 'UPDATE',
        schema: 'public',
        table: 'notifications',
        filter: `recipient_id=eq.${userId}`
      },
      (payload) => {
        broadcastToUser(userId, { type: 'notification.update', data: payload.new, old: payload.old });
      }
    )
    .on('postgres_changes',
      {
        event: 'DELETE',
        schema: 'public',
        table: 'notifications',
        filter: `recipient_id=eq.${userId}`
      },
      (payload) => {
        broadcastToUser(userId, { type: 'notification.delete', data: payload.old });
      }
    )
    .subscribe();

  notificationChannels.set(userId, channel);
  return channel;
};

// Cleanup function for notification channels
const cleanupNotificationChannel = (userId) => {
  if (notificationChannels.has(userId)) {
    const channel = notificationChannels.get(userId);
    channel.unsubscribe();
    notificationChannels.delete(userId);
    console.log(`🧹 Cleaned up notification channel for user ${userId}`);
  }
};

// Server-Sent Events (SSE) endpoint for real-time notifications per user
app.get('/api/rt/notifications/:userId', (req, res) => {
  const { userId } = req.params;
  if (!userId) return res.status(400).json({ error: 'User ID is required' });

  // SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  // Register client
  if (!sseClientsByUser.has(String(userId))) {
    sseClientsByUser.set(String(userId), new Set());
  }
  const clientSet = sseClientsByUser.get(String(userId));
  clientSet.add(res);

  // Ensure a channel exists for this user
  createNotificationChannel(userId);

  // Send an initial event for readiness
  res.write(`data: ${JSON.stringify({ type: 'ready', userId })}\n\n`);

  // Heartbeat to keep the connection alive behind proxies/LB
  const HEARTBEAT_MS = Number(process.env.SSE_HEARTBEAT_MS || 25000);
  const heartbeat = setInterval(() => {
    try { res.write(': ping\n\n'); } catch (_) {}
  }, HEARTBEAT_MS);

  // Cleanup on close
  req.on('close', () => {
    clearInterval(heartbeat);
    const set = sseClientsByUser.get(String(userId));
    if (set) {
      set.delete(res);
      if (set.size === 0) {
        sseClientsByUser.delete(String(userId));
        // Optionally release Supabase channel to free resources
        cleanupNotificationChannel(userId);
      }
    }
    try { res.end(); } catch (_) {}
  });
});

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

// Create a Stripe Checkout session and a pending booking (online payment)
app.post('/api/client/create-payment-session', async (req, res) => {
  try {
    if (!stripe) return res.status(500).json({ error: 'Stripe not configured on server.' });

    const { userId, email, busId, seats = [], date, totalAmount } = req.body;
    if (!userId || !busId || !email) return res.status(400).json({ error: 'userId, email and busId are required' });

    // Create booking with pending payment
    const bookingPayload = {
      user_id: userId,
      bus_id: busId,
      status: 'pending',
      payment_method: 'online',
      payment_status: 'pending',
      seats: seats || [],
      travel_date: date || null,
      amount: totalAmount || (15 * (seats?.length || 1)),
      email: email,
    };

    const { data: booking, error: bookingErr } = await supabase
      .from('bookings')
      .insert(bookingPayload)
      .select()
      .single();

    if (bookingErr) throw bookingErr;

    const lineAmount = Math.round((bookingPayload.amount || 15) * 100); // cents
    const seatCount = (seats && seats.length) || 1;

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'payment',
      line_items: [
        {
          price_data: {
            currency: 'usd',
            product_data: { name: `AuroRide — ${booking.id}` },
            unit_amount: lineAmount,
          },
          quantity: seatCount,
        }
      ],
      customer_email: email,
      metadata: { bookingId: booking.id },
      success_url: `${process.env.FRONTEND_URL || 'http://localhost:5173'}/booking-success?bookingId=${booking.id}&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.FRONTEND_URL || 'http://localhost:5173'}/booking?bookingId=${booking.id}`,
    });

    // Store session id on booking for webhook correlation
    await supabase
      .from('bookings')
      .update({ checkout_session_id: session.id, payment_intent_id: session.payment_intent || null })
      .eq('id', booking.id);

    res.json({ url: session.url, sessionId: session.id });
  } catch (error) {
    console.error('create-payment-session error', error);
    res.status(500).json({ error: error.message || 'Failed to create payment session' });
  }
});

// Stripe webhook endpoint
app.post('/api/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!stripe || !webhookSecret) {
    return res.status(500).send('Stripe webhook not configured');
  }

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
  } catch (err) {
    console.error('Webhook signature verification failed.', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Handle the checkout.session.completed event
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const bookingId = session.metadata?.bookingId;

    if (bookingId) {
      try {
        // Get booking record
        const { data: booking } = await supabase
          .from('bookings')
          .select('*')
          .eq('id', bookingId)
          .single();

        if (booking && booking.payment_status !== 'paid') {
          // Update booking payment status
          await supabase
            .from('bookings')
            .update({ payment_status: 'paid', status: 'confirmed', payment_intent_id: session.payment_intent || null })
            .eq('id', bookingId);

          // Optionally decrement available seats (if not already handled elsewhere)
          try {
            const { data: bus } = await supabase
              .from('buses')
              .select('available_seats')
              .eq('id', booking.bus_id)
              .single();
            if (bus) {
              const newSeats = Math.max(0, (bus.available_seats || 0) - (booking.seats?.length || 1));
              await supabase
                .from('buses')
                .update({ available_seats: newSeats })
                .eq('id', booking.bus_id);
            }
          } catch (seatErr) {
            console.warn('Failed to adjust seats after payment:', seatErr.message || seatErr);
          }

          // Send receipt email if possible
          try {
            await sendReceiptEmail({
              to: booking.email || session.customer_details?.email,
              booking,
              totalPrice: booking.amount,
              seats: booking.seats || [],
              routeName: booking.route_name || null,
              date: booking.travel_date || null
            });

            await supabase
              .from('bookings')
              .update({ receipt_sent: true })
              .eq('id', bookingId);
          } catch (emailErr) {
            console.warn('Failed to send receipt email:', emailErr.message || emailErr);
          }
        }
      } catch (err) {
        console.error('Failed to process checkout.session.completed:', err);
      }
    }
  }

  res.json({ received: true });
});

// Cancel a client's booking (soft delete via status)
app.delete('/api/client/booking/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { userId } = req.body;

    if (!userId) {
      return res.status(400).json({ error: 'User ID is required' });
    }

    const { data: booking, error: bookingErr } = await supabase
      .from('bookings')
      .select('id, user_id, bus_id, status')
      .eq('id', id)
      .eq('user_id', userId)
      .single();

    if (bookingErr || !booking) {
      return res.status(404).json({ error: 'Booking not found' });
    }

    if (booking.status === 'cancelled') {
      return res.json({ message: 'Booking already cancelled' });
    }

    // Set status to cancelled
    const { error: updateErr } = await supabase
      .from('bookings')
      .update({ status: 'cancelled' })
      .eq('id', id);
    if (updateErr) throw updateErr;

    // Increment available seats by 1 (guard against exceeding total)
    const { data: bus, error: busErr } = await supabase
      .from('buses')
      .select('available_seats, total_seats')
      .eq('id', booking.bus_id)
      .single();
    if (!busErr && bus) {
      const newSeats = Math.min(bus.total_seats, (bus.available_seats || 0) + 1);
      await supabase
        .from('buses')
        .update({ available_seats: newSeats })
        .eq('id', booking.bus_id);
    }

    res.json({ message: 'Booking cancelled' });
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

// Delete client's feedback
app.delete('/api/client/feedback/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { userId } = req.body;

    if (!userId) {
      return res.status(400).json({ error: 'User ID is required' });
    }

    // Ensure feedback belongs to the user
    const { data: feedback, error: fbErr } = await supabase
      .from('feedbacks')
      .select('id, user_id')
      .eq('id', id)
      .eq('user_id', userId)
      .single();

    if (fbErr || !feedback) {
      return res.status(404).json({ error: 'Feedback not found or access denied' });
    }

    const { error } = await supabase
      .from('feedbacks')
      .delete()
      .eq('id', id);

    if (error) throw error;
    res.json({ message: 'Feedback deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/client/contact', async (req, res) => {
  try {
    const { fullName, email, message } = req.body;
    if (!fullName || !email || !message) {
      return res.status(400).json({ error: 'fullName, email, and message are required' });
    }

    const { data: contact, error } = await supabase
      .from('contacts')
      .insert({ full_name: fullName, email, message, status: 'new' })
      .select('id, full_name, email, message, status, created_at')
      .single();
    if (error) throw error;
    res.status(201).json(contact);
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
      type: 'general',
      message: `Your booking for bus ${bus.bus_number} (${bus.route.name}) has been confirmed.`
    });

    // 4. Create notification for the driver
    if (driverId) {
      notifications.push({
        recipient_id: driverId,
        type: 'general',
        message: `New passenger: ${user.profile?.fullName || user.username} has booked a seat on your bus.`
      });
    }

    // 5. Create notification for the conductor
    if (conductorId) {
      notifications.push({
        recipient_id: conductorId,
        type: 'general',
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

// Admin: cancel a booking (soft delete via status)
app.delete('/api/admin/booking/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const { data: booking, error: bookingErr } = await supabase
      .from('bookings')
      .select('id, bus_id, status')
      .eq('id', id)
      .single();

    if (bookingErr || !booking) {
      return res.status(404).json({ error: 'Booking not found' });
    }

    if (booking.status === 'cancelled') {
      return res.json({ message: 'Booking already cancelled' });
    }

    const { error: updateErr } = await supabase
      .from('bookings')
      .update({ status: 'cancelled' })
      .eq('id', id);
    if (updateErr) throw updateErr;

    // Increment available seats by 1 if bus exists
    const { data: bus } = await supabase
      .from('buses')
      .select('available_seats, total_seats')
      .eq('id', booking.bus_id)
      .single();
    if (bus) {
      const newSeats = Math.min(bus.total_seats, (bus.available_seats || 0) + 1);
      await supabase
        .from('buses')
        .update({ available_seats: newSeats })
        .eq('id', booking.bus_id);
    }

    res.json({ message: 'Booking cancelled' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
// ===== NOTIFICATION MANAGEMENT SYSTEM =====

// --- Admin Notification Endpoints ---

// Send notification to specific user(s)
app.post('/api/admin/notification', async (req, res) => {
  try {
    const { recipient_ids, type, message, title } = req.body;
    
    // Validate required fields
    if (!recipient_ids || !type || !message) {
      return res.status(400).json({ 
        error: 'recipient_ids, type, and message are required' 
      });
    }

    // Validate notification type against allowed values
    const allowedTypes = ['delay', 'route_change', 'traffic', 'general', 'announcement', 'maintenance'];
    if (!allowedTypes.includes(type)) {
      return res.status(400).json({ 
        error: 'Invalid notification type',
        allowedTypes 
      });
    }

    // Handle single recipient or multiple recipients
    const recipients = Array.isArray(recipient_ids) ? recipient_ids : [recipient_ids];
    
    // Create notifications for all recipients
    const notifications = recipients.map(recipient_id => ({
      recipient_id,
      type,
      message,
      title: title || null,
      is_read: false,
      priority: type === 'maintenance' || type === 'delay' ? 'high' : 'normal'
    }));

    const { data, error } = await supabase
      .from('notifications')
      .insert(notifications)
      .select();

    if (error) throw error;

    // Create real-time channels for new recipients
    recipients.forEach(recipient_id => {
      createNotificationChannel(recipient_id);
    });

    res.status(201).json({
      message: `Notifications sent to ${recipients.length} recipient(s)`,
      notifications: data
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Send notification to all users of a specific role
app.post('/api/admin/notification/broadcast', async (req, res) => {
  try {
    const { role, type, message, title } = req.body;
    
    if (!role || !type || !message) {
      return res.status(400).json({ 
        error: 'role, type, and message are required' 
      });
    }

    // Get all users with the specified role
    const { data: users, error: usersError } = await supabase
      .from('users')
      .select('id')
      .eq('role', role)
      .eq('status', 'active');

    if (usersError) throw usersError;

    if (!users || users.length === 0) {
      return res.status(404).json({ 
        error: `No active users found with role: ${role}` 
      });
    }

    // Create notifications for all users
    const notifications = users.map(user => ({
      recipient_id: user.id,
      type,
      message,
      title: title || null,
      is_read: false,
      priority: type === 'maintenance' || type === 'delay' ? 'high' : 'normal'
    }));

    const { data, error } = await supabase
      .from('notifications')
      .insert(notifications)
      .select();

    if (error) throw error;

    // Create real-time channels for all recipients
    users.forEach(user => {
      createNotificationChannel(user.id);
    });

    res.status(201).json({
      message: `Broadcast notification sent to ${users.length} ${role}(s)`,
      notifications: data
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get all notifications (admin view)
app.get('/api/admin/notifications', async (req, res) => {
  try {
    const { page = 1, limit = 50, type, recipient_id, is_read } = req.query;
    const offset = (page - 1) * limit;

    let query = supabase
      .from('notifications')
      .select(`
        *,
        recipient:recipient_id(id, username, email, role, profile)
      `)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    // Apply filters
    if (type) query = query.eq('type', type);
    if (recipient_id) query = query.eq('recipient_id', recipient_id);
    if (is_read !== undefined) query = query.eq('is_read', is_read === 'true');

    const { data, error } = await query;
    if (error) throw error;

    // Get total count for pagination
    const { count } = await supabase
      .from('notifications')
      .select('*', { count: 'exact', head: true });

    res.json({
      notifications: data,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: count,
        totalPages: Math.ceil(count / limit)
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get notification statistics
app.get('/api/admin/notifications/stats', async (req, res) => {
  try {
    const { data: notifications, error } = await supabase
      .from('notifications')
      .select('type, is_read, created_at');

    if (error) throw error;

    const stats = {
      total: notifications.length,
      unread: notifications.filter(n => !n.is_read).length,
      read: notifications.filter(n => n.is_read).length,
      byType: {},
      byDate: {}
    };

    // Count by type
    notifications.forEach(notification => {
      stats.byType[notification.type] = (stats.byType[notification.type] || 0) + 1;
    });

    // Count by date (last 7 days)
    const last7Days = Array.from({ length: 7 }, (_, i) => {
      const date = new Date();
      date.setDate(date.getDate() - i);
      return date.toISOString().split('T')[0];
    });

    last7Days.forEach(date => {
      stats.byDate[date] = notifications.filter(n => 
        n.created_at.startsWith(date)
      ).length;
    });

    res.json(stats);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Admin: delete a notification by ID
app.delete('/api/admin/notification/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const { data: exists, error: checkErr } = await supabase
      .from('notifications')
      .select('id')
      .eq('id', id)
      .single();
    if (checkErr || !exists) {
      return res.status(404).json({ error: 'Notification not found' });
    }

    const { error } = await supabase
      .from('notifications')
      .delete()
      .eq('id', id);
    if (error) throw error;

    res.json({ message: 'Notification deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/admin/contacts', async (req, res) => {
  try {
    const { page = 1, limit = 50, status, email } = req.query;
    const offset = (page - 1) * limit;

    let query = supabase
      .from('contacts')
      .select('id, full_name, email, message, status, created_at')
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (status) query = query.eq('status', status);
    if (email) query = query.ilike('email', `%${email}%`);

    const { data, error } = await query;
    if (error) throw error;

    const { count } = await supabase
      .from('contacts')
      .select('*', { count: 'exact', head: true });

    res.json({
      contacts: data,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: count,
        totalPages: Math.ceil(count / limit)
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});



// --- Client Notification Endpoints ---

// Get client's notifications with pagination and filters
app.get('/api/client/notifications', async (req, res) => {
  try {
    const { userId, page = 1, limit = 20, type, is_read, priority } = req.query;
    
    if (!userId) {
      return res.status(400).json({ error: 'User ID is required' });
    }

    const offset = (page - 1) * limit;

    let query = supabase
      .from('notifications')
      .select('*')
      .eq('recipient_id', userId)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    // Apply filters
    if (type) query = query.eq('type', type);
    if (is_read !== undefined) query = query.eq('is_read', is_read === 'true');
    if (priority) query = query.eq('priority', priority);

    const { data, error } = await query;
    if (error) throw error;

    // Get total count for pagination
    const { count } = await supabase
      .from('notifications')
      .select('*', { count: 'exact', head: true })
      .eq('recipient_id', userId);

    // Create real-time channel for this user
    createNotificationChannel(userId);

    res.json({
      notifications: data,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: count,
        totalPages: Math.ceil(count / limit)
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Mark notification as read
app.put('/api/client/notification/:id/read', async (req, res) => {
  try {
    const { id } = req.params;
    const { userId } = req.body;

    if (!userId) {
      return res.status(400).json({ error: 'User ID is required' });
    }

    // Verify the notification belongs to the user
    const { data: notification, error: checkError } = await supabase
      .from('notifications')
      .select('id, recipient_id')
      .eq('id', id)
      .eq('recipient_id', userId)
      .single();

    if (checkError || !notification) {
      return res.status(404).json({ error: 'Notification not found or access denied' });
    }

    // Mark as read
    const { data, error } = await supabase
      .from('notifications')
      .update({ is_read: true, read_at: new Date().toISOString() })
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;

    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Mark all notifications as read for a user
app.put('/api/client/notifications/read-all', async (req, res) => {
  try {
    const { userId } = req.body;

    if (!userId) {
      return res.status(400).json({ error: 'User ID is required' });
    }

    const { data, error } = await supabase
      .from('notifications')
      .update({ 
        is_read: true, 
        read_at: new Date().toISOString() 
      })
      .eq('recipient_id', userId)
      .eq('is_read', false)
      .select();

    if (error) throw error;

    res.json({
      message: `Marked ${data.length} notifications as read`,
      updatedCount: data.length
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Delete a specific notification
app.delete('/api/client/notification/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { userId } = req.body;

    if (!userId) {
      return res.status(400).json({ error: 'User ID is required' });
    }

    // Verify the notification belongs to the user
    const { data: notification, error: checkError } = await supabase
      .from('notifications')
      .select('id, recipient_id')
      .eq('id', id)
      .eq('recipient_id', userId)
      .single();

    if (checkError || !notification) {
      return res.status(404).json({ error: 'Notification not found or access denied' });
    }

    // Delete the notification
    const { error } = await supabase
      .from('notifications')
      .delete()
      .eq('id', id);

    if (error) throw error;

    res.json({ message: 'Notification deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Delete all read notifications for a user
app.delete('/api/client/notifications/delete-read', async (req, res) => {
  try {
    const { userId } = req.body;

    if (!userId) {
      return res.status(400).json({ error: 'User ID is required' });
    }

    const { data, error } = await supabase
      .from('notifications')
      .delete()
      .eq('recipient_id', userId)
      .eq('is_read', true)
      .select();

    if (error) throw error;

    res.json({
      message: `Deleted ${data.length} read notifications`,
      deletedCount: data.length
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get unread notification count for a user
app.get('/api/client/notifications/unread-count', async (req, res) => {
  try {
    const { userId } = req.query;

    if (!userId) {
      return res.status(400).json({ error: 'User ID is required' });
    }

    const { count, error } = await supabase
      .from('notifications')
      .select('*', { count: 'exact', head: true })
      .eq('recipient_id', userId)
      .eq('is_read', false);

    if (error) throw error;

    res.json({ unreadCount: count });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// --- Employee Notification Endpoints ---

// Get employee's notifications
app.get('/api/employee/notifications', async (req, res) => {
  try {
    const { employeeId, page = 1, limit = 20, type, is_read } = req.query;
    
    if (!employeeId) {
      return res.status(400).json({ error: 'Employee ID is required' });
    }

    const offset = (page - 1) * limit;

    let query = supabase
      .from('notifications')
      .select('*')
      .eq('recipient_id', employeeId)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    // Apply filters
    if (type) query = query.eq('type', type);
    if (is_read !== undefined) query = query.eq('is_read', is_read === 'true');

    const { data, error } = await query;
    if (error) throw error;

    // Get total count for pagination
    const { count } = await supabase
      .from('notifications')
      .select('*', { count: 'exact', head: true })
      .eq('recipient_id', employeeId);

    // Create real-time channel for this employee
    createNotificationChannel(employeeId);

    res.json({
      notifications: data,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: count,
        totalPages: Math.ceil(count / limit)
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Mark employee notification as read
app.put('/api/employee/notification/:id/read', async (req, res) => {
  try {
    const { id } = req.params;
    const { employeeId } = req.body;

    if (!employeeId) {
      return res.status(400).json({ error: 'Employee ID is required' });
    }

    // Verify the notification belongs to the employee
    const { data: notification, error: checkError } = await supabase
      .from('notifications')
      .select('id, recipient_id')
      .eq('id', id)
      .eq('recipient_id', employeeId)
      .single();

    if (checkError || !notification) {
      return res.status(404).json({ error: 'Notification not found or access denied' });
    }

    // Mark as read
    const { data, error } = await supabase
      .from('notifications')
      .update({ is_read: true, read_at: new Date().toISOString() })
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;

    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Delete an employee's notification
app.delete('/api/employee/notification/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { employeeId } = req.body;

    if (!employeeId) {
      return res.status(400).json({ error: 'Employee ID is required' });
    }

    // Verify the notification belongs to the employee
    const { data: notification, error: checkError } = await supabase
      .from('notifications')
      .select('id, recipient_id')
      .eq('id', id)
      .eq('recipient_id', employeeId)
      .single();

    if (checkError || !notification) {
      return res.status(404).json({ error: 'Notification not found or access denied' });
    }

    const { error } = await supabase
      .from('notifications')
      .delete()
      .eq('id', id);
    if (error) throw error;

    res.json({ message: 'Notification deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// --- Utility Endpoints ---

// Test endpoint to verify routing
app.get('/api/admin/notification/test', (req, res) => {
  console.log('🧪 Test endpoint hit!');
  res.json({ message: 'Notification routing is working!' });
});

// Get notifications by recipient ID (admin view)
app.get('/api/admin/notification/recipient/:recipient_id', async (req, res) => {
  try {
    const { recipient_id } = req.params;
    const { type, is_read, page = 1, limit = 20 } = req.query;
    const offset = (page - 1) * limit;
    
    if (!recipient_id) {
      return res.status(400).json({ error: 'Recipient ID is required' });
    }

    let query = supabase
      .from('notifications')
      .select('*')
      .eq('recipient_id', recipient_id)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (type) query = query.eq('type', type);
    if (is_read !== undefined) query = query.eq('is_read', is_read === 'true');

    const { data, error } = await query;
    if (error) throw error;

    // Get total count for pagination
    const { count } = await supabase
      .from('notifications')
      .select('*', { count: 'exact', head: true })
      .eq('recipient_id', recipient_id);

    res.json({
      notifications: data,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: count,
        totalPages: Math.ceil(count / limit)
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get a specific notification by ID (admin view)
app.get('/api/admin/notification/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    if (!id) {
      return res.status(400).json({ error: 'Notification ID is required' });
    }

    const { data: notification, error } = await supabase
      .from('notifications')
      .select(`
        *,
        recipient:recipient_id(id, username, email, role, profile)
      `)
      .eq('id', id)
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return res.status(404).json({ error: 'Notification not found' });
      }
      throw error;
    }

    res.json(notification);
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

// Admin: delete a report by ID
app.delete('/api/admin/report/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const { data: report, error: checkErr } = await supabase
      .from('reports')
      .select('id')
      .eq('id', id)
      .single();
    if (checkErr || !report) {
      return res.status(404).json({ error: 'Report not found' });
    }

    const { error } = await supabase
      .from('reports')
      .delete()
      .eq('id', id);
    if (error) throw error;

    res.json({ message: 'Report deleted successfully' });
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
    console.log('Fetching all terminals...');
    
    const { data, error } = await supabase
      .from('terminals')
      .select('*');
      
    if (error) {
      console.error('Error fetching terminals:', error);
      return res.status(500).json({ error: 'Error fetching terminals', details: error.message });
    }
    
    console.log('Terminals fetched:', data);
    res.json(data);
  } catch (error) {
    console.error('Unexpected error in terminals fetch:', error);
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
    
    console.log('Creating route with data:', { name, start_terminal_id, end_terminal_id, stops });
    
    // Validate required fields
    if (!name || !start_terminal_id || !end_terminal_id) {
      return res.status(400).json({ 
        error: 'Missing required fields', 
        required: ['name', 'start_terminal_id', 'end_terminal_id'],
        received: { name, start_terminal_id, end_terminal_id }
      });
    }

    // Check if terminals exist
    const { data: terminals, error: terminalsError } = await supabase
      .from('terminals')
      .select('id, name')
      .in('id', [start_terminal_id, end_terminal_id]);

    if (terminalsError) {
      console.error('Error checking terminals:', terminalsError);
      return res.status(500).json({ error: 'Error checking terminals', details: terminalsError.message });
    }

    if (terminals.length !== 2) {
      return res.status(400).json({ 
        error: 'Start or end terminal not found',
        found_terminals: terminals,
        requested_terminals: [start_terminal_id, end_terminal_id]
      });
    }

    // Create route
    const { data: route, error: routeError } = await supabase
      .from('routes')
      .insert([{ name, start_terminal_id, end_terminal_id }])
      .select()
      .single();
    
    if (routeError) {
      console.error('Error creating route:', routeError);
      return res.status(500).json({ error: 'Error creating route', details: routeError.message });
    }

    console.log('Route created successfully:', route);

    // Insert stops if provided
    if (Array.isArray(stops) && stops.length > 0) {
      const stopsData = stops.map((terminal_id, idx) => ({
        route_id: route.id,
        terminal_id,
        stop_order: idx + 1
      }));
      
      console.log('Creating stops:', stopsData);
      
      const { data: createdStops, error: stopsError } = await supabase
        .from('route_stops')
        .insert(stopsData)
        .select();
        
      if (stopsError) {
        console.error('Error creating stops:', stopsError);
        return res.status(500).json({ error: 'Error creating route stops', details: stopsError.message });
      }
      
      console.log('Stops created successfully:', createdStops);
    }
    
    res.status(201).json(route);
  } catch (error) {
    console.error('Unexpected error in route creation:', error);
    res.status(500).json({ error: error.message });
  }
});

// List Routes (with stops)
app.get('/api/admin/routes', async (req, res) => {
  try {
    console.log('Fetching all routes...');
    
    // Get all routes
    const { data: routes, error: routesError } = await supabase
      .from('routes')
      .select('*');
      
    if (routesError) {
      console.error('Error fetching routes:', routesError);
      return res.status(500).json({ error: 'Error fetching routes', details: routesError.message });
    }
    
    console.log('Routes fetched:', routes);

    // Get all stops
    const { data: stops, error: stopsError } = await supabase
      .from('route_stops')
      .select('*');
      
    if (stopsError) {
      console.error('Error fetching stops:', stopsError);
      return res.status(500).json({ error: 'Error fetching stops', details: stopsError.message });
    }
    
    console.log('Stops fetched:', stops);

    // Attach stops to routes
    const routesWithStops = routes.map(route => ({
      ...route,
      stops: stops.filter(stop => stop.route_id === route.id)
    }));
    
    console.log('Routes with stops:', routesWithStops);
    
    res.json(routesWithStops);
  } catch (error) {
    console.error('Unexpected error in routes fetch:', error);
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

// Get single Bus by ID (admin)
app.get('/api/admin/bus/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const { data: bus, error } = await supabase
      .from('buses')
      .select('*')
      .eq('id', id)
      .single();

    if (error) {
      return res.status(404).json({ error: 'Bus not found' });
    }

    res.json(bus);
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

// Update Bus (admin)
app.put('/api/admin/bus/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const {
      bus_number,
      total_seats,
      available_seats,
      terminal_id,
      route_id,
      status,
      current_location,
      driver_id,
      conductor_id
    } = req.body;

    // Ensure bus exists
    const { data: existingBus, error: existingError } = await supabase
      .from('buses')
      .select('id, available_seats, total_seats')
      .eq('id', id)
      .single();
    if (existingError || !existingBus) {
      return res.status(404).json({ error: 'Bus not found' });
    }

    // Optional validations
    if (typeof total_seats === 'number' && total_seats < 0) {
      return res.status(400).json({ error: 'total_seats must be >= 0' });
    }
    if (typeof available_seats === 'number' && available_seats < 0) {
      return res.status(400).json({ error: 'available_seats must be >= 0' });
    }

    const effectiveTotalSeats = typeof total_seats === 'number' ? total_seats : existingBus.total_seats;
    const effectiveAvailableSeats = typeof available_seats === 'number' ? available_seats : existingBus.available_seats;
    if (effectiveAvailableSeats > effectiveTotalSeats) {
      return res.status(400).json({ error: 'available_seats cannot exceed total_seats' });
    }

    // Validate terminal/route existence if provided
    if (terminal_id) {
      const { data: term, error: termErr } = await supabase
        .from('terminals')
        .select('id')
        .eq('id', terminal_id)
        .single();
      if (termErr || !term) return res.status(400).json({ error: 'Invalid terminal_id' });
    }
    if (route_id) {
      const { data: route, error: routeErr } = await supabase
        .from('routes')
        .select('id')
        .eq('id', route_id)
        .single();
      if (routeErr || !route) return res.status(400).json({ error: 'Invalid route_id' });
    }

    // If bus_number is changing, ensure uniqueness
    if (bus_number) {
      const { data: dupCheck, error: dupErr } = await supabase
        .from('buses')
        .select('id')
        .eq('bus_number', bus_number)
        .neq('id', id);
      if (dupErr) throw dupErr;
      if (Array.isArray(dupCheck) && dupCheck.length > 0) {
        return res.status(400).json({ error: 'bus_number already exists' });
      }
    }

    const updatePayload = {
      ...(bus_number !== undefined ? { bus_number } : {}),
      ...(total_seats !== undefined ? { total_seats } : {}),
      ...(available_seats !== undefined ? { available_seats } : {}),
      ...(terminal_id !== undefined ? { terminal_id } : {}),
      ...(route_id !== undefined ? { route_id } : {}),
      ...(status !== undefined ? { status } : {}),
      ...(current_location !== undefined ? { current_location } : {}),
      ...(driver_id !== undefined ? { driver_id } : {}),
      ...(conductor_id !== undefined ? { conductor_id } : {}),
    };

    const { data: updated, error } = await supabase
      .from('buses')
      .update(updatePayload)
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;
    res.json(updated);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Delete Bus (admin)
app.delete('/api/admin/bus/:id', async (req, res) => {
  try {
    const { id } = req.params;

    // Ensure bus exists
    const { data: bus, error: busErr } = await supabase
      .from('buses')
      .select('id, bus_number')
      .eq('id', id)
      .single();
    if (busErr || !bus) {
      return res.status(404).json({ error: 'Bus not found' });
    }

    // Detach any users assigned to this bus to avoid FK constraint
    await supabase
      .from('users')
      .update({ assigned_bus_id: null })
      .eq('assigned_bus_id', id);

    // Check dependent records that would block deletion
    const [{ count: bookingsCount }, { count: feedbacksCount }, { count: reportsCount }] = await Promise.all([
      supabase.from('bookings').select('*', { count: 'exact', head: true }).eq('bus_id', id),
      supabase.from('feedbacks').select('*', { count: 'exact', head: true }).eq('bus_id', id),
      supabase.from('reports').select('*', { count: 'exact', head: true }).eq('bus_id', id),
    ]);

    if ((bookingsCount || 0) > 0 || (feedbacksCount || 0) > 0 || (reportsCount || 0) > 0) {
      return res.status(400).json({
        error: 'Cannot delete bus. It has dependent records.',
        details: {
          bookings: bookingsCount || 0,
          feedbacks: feedbacksCount || 0,
          reports: reportsCount || 0
        }
      });
    }

    const { error } = await supabase
      .from('buses')
      .delete()
      .eq('id', id);

    if (error) throw error;
    res.json({ message: `Bus ${bus.bus_number} deleted successfully` });
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

// Employee: delete own report
app.delete('/api/employee/report/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { employeeId } = req.body;

    if (!employeeId) {
      return res.status(400).json({ error: 'Employee ID is required' });
    }

    // Verify report belongs to employee
    const { data: report, error: checkErr } = await supabase
      .from('reports')
      .select('id, employee_id')
      .eq('id', id)
      .eq('employee_id', employeeId)
      .single();

    if (checkErr || !report) {
      return res.status(404).json({ error: 'Report not found or access denied' });
    }

    const { error } = await supabase
      .from('reports')
      .delete()
      .eq('id', id);
    if (error) throw error;

    res.json({ message: 'Report deleted successfully' });
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
    console.error('Login error:', error);

    // Detect network / DNS errors (e.g., ENOTFOUND) coming from underlying fetch
    const cause = error && error.cause ? error.cause : null;
    const isNetworkError = cause && (cause.code === 'ENOTFOUND' || cause.code === 'EAI_AGAIN' || cause.errno === -3008);

    if (isNetworkError) {
      // 503 indicates upstream service unavailable
      return res.status(503).json({
        error: 'Unable to reach Supabase. Check SUPABASE_URL, internet connection, and DNS settings.'
      });
    }

    // Fallback - return generic server error
    return res.status(500).json({ error: (error && error.message) ? error.message : String(error) });
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

// Delete a user (admin can delete any user, including own account)
app.delete('/api/admin/user/:id', async (req, res) => {
  try {
    const { id } = req.params;

    // Ensure user exists
    const { data: user, error: userErr } = await supabase
      .from('users')
      .select('id, username, email, role')
      .eq('id', id)
      .single();
    if (userErr || !user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Detach bus role assignments if the user is a driver/conductor
    await supabase
      .from('buses')
      .update({ driver_id: null })
      .eq('driver_id', id);
    await supabase
      .from('buses')
      .update({ conductor_id: null })
      .eq('conductor_id', id);

    // Nullify created_by references to this user
    await supabase
      .from('users')
      .update({ created_by: null })
      .eq('created_by', id);

    // Delete notifications for this user (safe to hard-delete)
    await supabase
      .from('notifications')
      .delete()
      .eq('recipient_id', id);

    // Block deletion if there are dependent business records
    const [
      { count: bookingsCount },
      { count: feedbacksCount },
      { count: reportsCount }
    ] = await Promise.all([
      supabase.from('bookings').select('*', { count: 'exact', head: true }).eq('user_id', id),
      supabase.from('feedbacks').select('*', { count: 'exact', head: true }).eq('user_id', id),
      supabase.from('reports').select('*', { count: 'exact', head: true }).eq('employee_id', id)
    ]);

    if ((bookingsCount || 0) > 0 || (feedbacksCount || 0) > 0 || (reportsCount || 0) > 0) {
      return res.status(400).json({
        error: 'Cannot delete user due to dependent records',
        details: {
          bookings: bookingsCount || 0,
          feedbacks: feedbacksCount || 0,
          reports: reportsCount || 0
        },
        note: 'Cancel/delete dependent records first, or consider a soft delete (status=inactive)'
      });
    }

    // Finally, delete the user
    const { error } = await supabase
      .from('users')
      .delete()
      .eq('id', id);
    if (error) throw error;

    res.json({ message: `User ${user.username || user.email} deleted successfully` });
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

// Admin: delete a feedback by ID
app.delete('/api/admin/feedback/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const { data: fb, error: checkErr } = await supabase
      .from('feedbacks')
      .select('id')
      .eq('id', id)
      .single();
    if (checkErr || !fb) {
      return res.status(404).json({ error: 'Feedback not found' });
    }

    const { error } = await supabase
      .from('feedbacks')
      .delete()
      .eq('id', id);
    if (error) throw error;

    res.json({ message: 'Feedback deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Start server
const PORT = process.env.PORT || 3000;
// Render/Proxies
app.enable('trust proxy');

const server = app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));

// Tune HTTP server timeouts for long-lived SSE connections
try {
  server.requestTimeout = 0; // Disable per-request timeout
  server.keepAliveTimeout = Number(process.env.KEEP_ALIVE_TIMEOUT_MS || 65000);
  server.headersTimeout = Number(process.env.HEADERS_TIMEOUT_MS || 66000);
} catch (_) {
  // Best-effort only
}

// Graceful shutdown handling
process.on('SIGTERM', () => {
  console.log('🔄 SIGTERM received, shutting down gracefully...');
  
  // Cleanup all notification channels
  notificationChannels.forEach((channel, userId) => {
    cleanupNotificationChannel(userId);
  });
  
  server.close(() => {
    console.log('✅ Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('🔄 SIGINT received, shutting down gracefully...');
  
  // Cleanup all notification channels
  notificationChannels.forEach((channel, userId) => {
    cleanupNotificationChannel(userId);
  });
  
  server.close(() => {
    console.log('✅ Server closed');
    process.exit(0);
  });
});
