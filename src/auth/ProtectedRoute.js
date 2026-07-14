const express = require("express");
const authMiddleware = require("./authMiddleware");

const router = express.Router();

router.get("/profile", authMiddleware, (req, res) => {
  res.json({
    user: req.auth,
  });
});

module.exports = router;