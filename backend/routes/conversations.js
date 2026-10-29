const express = require('express');
const mongoose = require('mongoose');
const Conversation = require('../models/Conversation');
const Message = require('../models/Message');
const requireAuth = require('../middleware/auth');
const router = express.Router();
router.use(requireAuth);

router.get('/', async (req, res, next) => {
  try {
    const conversations = await Conversation.find({ participants: req.user._id })
      .populate('participants', 'name email avatar lastSeen')
      .populate({ path: 'lastMessage', populate: { path: 'sender', select: 'name' } })
      .sort({ updatedAt: -1 }).limit(100);
    res.json({ conversations });
  } catch (err) { next(err); }
});

router.post('/direct', async (req, res, next) => {
  try {
    const { userId } = req.body;
    if (!mongoose.isValidObjectId(userId) || userId === req.user.id) return res.status(400).json({ message: 'Valid other userId is required' });
    let conversation = await Conversation.findOne({ type: 'direct', participants: { $all: [req.user._id, userId], $size: 2 } });
    if (!conversation) conversation = await Conversation.create({ type: 'direct', participants: [req.user._id, userId], createdBy: req.user._id });
    conversation = await conversation.populate('participants', 'name email avatar lastSeen');
    res.status(201).json({ conversation });
  } catch (err) { next(err); }
});

router.post('/group', async (req, res, next) => {
  try {
    const title = String(req.body.title || '').trim();
    const ids = Array.isArray(req.body.participantIds) ? req.body.participantIds : [];
    if (!title) return res.status(400).json({ message: 'Group title is required' });
    if (ids.length < 1 || ids.length > 49 || ids.some(id => !mongoose.isValidObjectId(id))) return res.status(400).json({ message: 'Choose 1 to 49 valid members' });
    const participants = [...new Set([req.user.id, ...ids])];
    const conversation = await Conversation.create({ type: 'group', title, participants, createdBy: req.user._id });
    await conversation.populate('participants', 'name email avatar');
    res.status(201).json({ conversation });
  } catch (err) { next(err); }
});

router.get('/:id/messages', async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Invalid conversation id' });
    const conversation = await Conversation.findOne({ _id: req.params.id, participants: req.user._id });
    if (!conversation) return res.status(404).json({ message: 'Conversation not found' });
    const before = req.query.before && mongoose.isValidObjectId(req.query.before) ? req.query.before : null;
    const filter = { conversation: conversation._id };
    if (before) {
      const cursor = await Message.findById(before).select('createdAt');
      if (cursor) filter.createdAt = { $lt: cursor.createdAt };
    }
    const messages = await Message.find(filter).populate('sender', 'name avatar').sort({ createdAt: -1 }).limit(50);
    res.json({ messages: messages.reverse() });
  } catch (err) { next(err); }
});
module.exports = router;
