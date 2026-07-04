const FuzzyResult = require('../models/fuzzyresult');

exports.hitungFuzzy = async (req, res) => {
const { durasi, frekuensi, kontrol } = req.body;


// Contoh sederhana fungsi keanggotaan
const muDurasiTinggi = durasi >= 5 ? 1 : durasi / 5;
const muFrekuensiSering = frekuensi >= 5 ? 1 : frekuensi / 5;
const muKontrolRendah = kontrol <= 5 ? 1 : (10 - kontrol) / 5;


// Aturan fuzzy (AND → MIN)
const alpha = Math.min(muDurasiTinggi, muFrekuensiSering, muKontrolRendah);


// Defuzzifikasi (Tsukamoto – monoton)
const z = 50 + (alpha * 50); // range 50–100


let kategori = 'Rendah';
if (z > 80) kategori = 'Tinggi';
else if (z > 60) kategori = 'Sedang';


const hasil = { nilai: z.toFixed(2), kategori };


await FuzzyResult.create({ durasi, frekuensi, kontrol, hasil: z, kategori });


res.render('index', { hasil });
};

