const mongoose = require("mongoose");

const hasilSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "user",
    required: true
  },
  hasil: {
    type: String,
    required: true
  },
  jawaban: {
    type: Object,
    required: true
  },
  total: {
    type: Number,
    required: false
  },
  nilaiZ: {
    type: Number,
    required: false
  },
  tanggal: {
    type: Date,
    default: Date.now
  }
});

module.exports = mongoose.model("hasil", hasilSchema);
