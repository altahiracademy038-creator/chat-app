const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const User = require('../models/User');
const Conversation = require('../models/Conversation');
const Message = require('../models/Message');

module.exports = function configureChat(io) {
  const onlineUsers = new Map(); // userId -> Set(socketId), supports multiple tabs/devices

  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth && socket.handshake.auth.token;
      if (!token) return next(new Error('Authentication required'));
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      const user = await User.findById(decoded.userId).select('_id name avatar');
      if (!user) return next(new Error('User not found'));
      socket.user = user;
      next();
    } catch { next(new Error('Invalid or expired token')); }
  });

  io.on('connection', async (socket) => {
    const userId = socket.user._id.toString();
    const sockets = onlineUsers.get(userId) || new Set();
    sockets.add(socket.id);
    onlineUsers.set(userId, sockets);
    socket.join(`user:${userId}`);
    io.emit('presence:update', { userId, online: true });

    const memberships = await Conversation.find({ participants: socket.user._id }).select('_id');
    memberships.forEach(c => socket.join(`conversation:${c._id}`));
    socket.emit('presence:snapshot', { userIds: [...onlineUsers.keys()] });

    socket.on('conversation:join', async ({ conversationId } = {}, ack = () => {}) => {
      try {
        if (!mongoose.isValidObjectId(String(conversationId || ''))) return ack && ack({ ok: false });
        const member = await Conversation.exists({ _id: conversationId, participants: socket.user._id });
        if (!member) return ack && ack({ ok: false });
        socket.join(`conversation:${conversationId}`);
        if (ack) ack({ ok: true });
      } catch { if (ack) ack({ ok: false }); }
    });

    socket.on('message:send', async (payload = {}, ack = () => {}) => {
      try {
        const conversationId = String(payload.conversationId || '');
        const text = String(payload.text || '').trim();
        if (!mongoose.isValidObjectId(conversationId) || !text || text.length > 4000) return ack({ ok: false, message: 'Message must be 1–4000 characters' });
        const conversation = await Conversation.findOne({ _id: conversationId, participants: socket.user._id });
        if (!conversation) return ack({ ok: false, message: 'Conversation not found or access denied' });
        const message = await Message.create({ conversation: conversation._id, sender: socket.user._id, text, readBy: [{ user: socket.user._id, readAt: new Date() }] });
        conversation.lastMessage = message._id;
        conversation.updatedAt = new Date();
        await conversation.save();
        const populated = await Message.findById(message._id).populate('sender', 'name avatar');
        io.to(`conversation:${conversationId}`).emit('message:new', populated);
        ack({ ok: true, messageId: message._id.toString() });
      } catch (err) { console.error('message:send error', err); ack({ ok: false, message: 'Could not send message' }); }
    });

    socket.on('typing:start', async ({ conversationId } = {}) => {
      if (!mongoose.isValidObjectId(String(conversationId || ''))) return;
      const member = await Conversation.exists({ _id: conversationId, participants: socket.user._id });
      if (member) socket.to(`conversation:${conversationId}`).emit('typing:update', { conversationId, userId, name: socket.user.name, typing: true });
    });
    socket.on('typing:stop', ({ conversationId } = {}) => {
      if (mongoose.isValidObjectId(String(conversationId || ''))) socket.to(`conversation:${conversationId}`).emit('typing:update', { conversationId, userId, typing: false });
    });

    socket.on('message:read', async ({ conversationId } = {}, ack = () => {}) => {
      try {
        if (!mongoose.isValidObjectId(String(conversationId || ''))) return ack({ ok: false });
        const conversation = await Conversation.findOne({ _id: conversationId, participants: socket.user._id });
        if (!conversation) return ack({ ok: false });
        await Message.updateMany({ conversation: conversationId, sender: { $ne: socket.user._id }, 'readBy.user': { $ne: socket.user._id } }, { $push: { readBy: { user: socket.user._id, readAt: new Date() } } });
        io.to(`conversation:${conversationId}`).emit('conversation:read', { conversationId, userId });
        ack({ ok: true });
      } catch { ack({ ok: false }); }
    });

    socket.on('message:react', async ({ messageId, emoji } = {}, ack = () => {}) => {
      try {
        if (!mongoose.isValidObjectId(String(messageId || '')) || !/^(\p{Extended_Pictographic}|❤️|👍|😂|😮|😢|🙏){1,2}$/u.test(String(emoji || ''))) return ack({ ok: false, message: 'Invalid reaction' });
        const message = await Message.findById(messageId);
        if (!message) return ack({ ok: false, message: 'Message not found' });
        const conversation = await Conversation.findOne({ _id: message.conversation, participants: socket.user._id });
        if (!conversation) return ack({ ok: false, message: 'Access denied' });
        message.reactions = message.reactions.filter(r => r.user.toString() !== userId);
        message.reactions.push({ user: socket.user._id, emoji });
        await message.save();
        io.to(`conversation:${message.conversation}`).emit('message:reaction', { messageId, reactions: message.reactions });
        ack({ ok: true });
      } catch { ack({ ok: false, message: 'Could not react' }); }
    });

    socket.on('disconnect', async () => {
      const current = onlineUsers.get(userId);
      if (current) {
        current.delete(socket.id);
        if (current.size === 0) {
          onlineUsers.delete(userId);
          await User.findByIdAndUpdate(userId, { lastSeen: new Date() }).catch(() => {});
          io.emit('presence:update', { userId, online: false, lastSeen: new Date() });
        }
      }
    });
  });
};
