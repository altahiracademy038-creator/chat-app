const express = require('express');
const User = require('../models/User');
const requireAuth = require('../middleware/auth');
const router = express.Router();

router.use(requireAuth);
router.get('/', async (req, res, next) => {
  try {
    const q = String(req.query.q || '').trim().slice(0, 60);
    const filter = { _id: { $ne: req.user._id } };
    if (q) {
      const safe = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      filter.$or = [{ name: { $regex: safe, $options: 'i' } }, { email: { $regex: safe, $options: 'i' } }];
    }
    const users = await User.find(filter).select('name email avatar bio lastSeen').sort({ name: 1 }).limit(30);
    res.json({ users });
  } catch (err) { next(err); }
});
module.exports = router;
