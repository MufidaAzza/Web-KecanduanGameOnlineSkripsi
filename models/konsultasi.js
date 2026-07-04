const mongoose = require("mongoose");

const KonsultasiSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User"
  },
  jawaban: {
    q1: Number, q2: Number, q3: Number, q4: Number, q5: Number,
    q6: Number, q7: Number, q8: Number, q9: Number, q10: Number,
    q11: Number, q12: Number, q13: Number, q14: Number, q15: Number,
    q16: Number, q17: Number, q18: Number, q19: Number, q20: Number,
  },
  bobot: Object,
  prosesFuzzy: Object,
  nilaiAkhir: Number,
  tingkat: String,
  createdAt: {
    type: Date,
    default: Date.now
  }
});

module.exports = mongoose.model("Konsultasi", KonsultasiSchema);
