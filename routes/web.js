const express = require('express');
const router = express.Router();

// =====================
// HALAMAN KONSULTASI (GET)
// =====================
router.get('/konsultasi', (req, res) => {
    res.render('user_konsultasi');
});

// =====================
// PROSES FORM (POST)
// =====================
router.post('/submit', (req, res) => {

    const jawaban = req.body.jawaban;

    if (!jawaban) {
        return res.send("Jawaban tidak ditemukan");
    }

    // Hitung total skor
    const totalSkor = jawaban.reduce((a, b) => a + parseInt(b), 0);

    // Contoh kategori sederhana dulu
    let kategori = "";

    if (totalSkor < 50) kategori = "Rendah";
    else if (totalSkor >= 50 && totalSkor < 75) kategori = "Sedang";
    else kategori = "Tinggi";

    res.render('user_hasil', {
        totalSkor,
        kategori
    });
});

module.exports = router;