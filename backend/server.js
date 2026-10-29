require('dotenv').config();
const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');
const rateLimit = require('express-rate-limit');
const connectDB = require('./config/db');
const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/users');
const conversationRoutes = require('./routes/conversations');
const configureChat = require('./sockets/chat');

const app = express();
const server = http.createServer(app);
const allowedOrigin = process.env.CLIENT_URL || 'http://127.0.0.1:5500';
app.use(cors({ origin: allowedOrigin }));
app.use(express.json({ limit: '1mb' }));
app.use('/api/auth', rateLimit({ windowMs: 15 * 60 * 1000, limit: 100, standardHeaders: true, legacyHeaders: false }), authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/conversations', conversationRoutes);
app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'advanced-chat-api' }));
app.use((err, _req, res, _next) => {
  console.error(err);
  if (err && err.code === 11000) return res.status(409).json({ message: 'This email is already registered' });
  res.status(500).json({ message: 'Internal server error' });
});

const io = new Server(server, { cors: { origin: allowedOrigin, methods: ['GET', 'POST'] } });
configureChat(io);
const PORT = process.env.PORT || 3000;
connectDB().then(() => server.listen(PORT, () => console.log(`API + Socket.IO running at http://localhost:${PORT}`))).catch(err => { console.error('Database connection failed:', err.message); process.exit(1); });
