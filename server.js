require("dotenv").config();
const multer = require("multer");
const express = require("express");
const session = require("express-session");
const MongoStore = require("connect-mongo");
const bcrypt = require("bcryptjs");
const path = require("path");
const fs = require("fs");

const User = require("./models/user");
const Hasil = require("./models/hasil");
const connectDB = require("./lib/mongodb");

const app = express();
const PORT = process.env.PORT || 3000;
const isProd = process.env.NODE_ENV === "production";
const SESSION_SECRET = process.env.SESSION_SECRET || (isProd ? "" : "dev-secret");
const SESSION_DEBUG = process.env.SESSION_DEBUG === "true";
const DB_DEBUG = process.env.DB_DEBUG === "true";
if (isProd && !process.env.SESSION_SECRET) {
  throw new Error("Missing SESSION_SECRET. Set it in environment variables.");
}
const uploadDir = process.env.VERCEL
  ? path.join("/tmp", "uploads")
  : path.join(__dirname, "public/uploads");

/* ================= MIDDLEWARE ================= */

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.set("trust proxy", 1);

app.use(session({
  name: "sid",
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  rolling: true,
  proxy: true,
  store: MongoStore.create({
    clientPromise: connectDB().then((conn) => {
      if (!conn) throw new Error("MongoDB belum connect");
      return conn.connection.getClient();
    }),
    collectionName: "sessions",
    touchAfter: 24 * 3600,
    ttl: 60 * 60 * 24 * 7
  }),
  cookie: {
    httpOnly: true,
    secure: isProd,
    sameSite: "lax",
    maxAge: 1000 * 60 * 60 * 24 * 7
  }
}));

app.use((req, res, next) => {
  if (SESSION_DEBUG) {
    console.log("[SESSION]", {
      path: req.path,
      sid: req.sessionID,
      userId: req.session?.userId || null,
      role: req.session?.role || null
    });
  }
  next();
});

function isApiRequest(req) {
  const accept = req.headers.accept || "";
  return req.path.startsWith("/api")
    || req.xhr
    || accept.includes("application/json")
    || req.headers["x-requested-with"] === "XMLHttpRequest";
}

function logDb(req, label, extra) {
  if (!DB_DEBUG) return;
  console.log("[DB]", label, {
    path: req.path,
    userId: req.session?.userId || null,
    ...extra
  });
}

function isLogin(req, res, next) {
  if (!req.session.userId) {
    if (isApiRequest(req)) {
      return res.status(401).json({ message: "Unauthorized" });
    }
    return res.redirect("/login");
  }
  next();
}

/* =================================================================
   FUZZY TSUKAMOTO (24 ATURAN)
   ----------------------------------------------------------------
   INPUT  : 4 variabel crisp terpisah (TIDAK digabung jadi 1 rata-rata)
     - Durasi Bermain     (q1+q2+q3)   rentang 0-32
     - Frekuensi Bermain  (q4+q5+q6)   rentang 0-22
     - Penurunan Akademik (q7+q8+q9)   rentang 0-34
     - Kontrol Diri       (q10+q11+q12) rentang 0-25

   Tiap variabel difuzzifikasi sendiri-sendiri menjadi 3 himpunan,
   lalu dikombinasikan lewat 24 aturan (operator MIN) untuk
   menghasilkan alpha-predikat tiap aturan, baru didefuzzifikasi
   dengan weighted average.

   Himpunan fuzzy OUTPUT:
     Ringan : turun dari 1 (z=0) ke 0 (z=40)    → Monoton Turun, a=0,b=40
     Sedang : naik 0→1 (z=30-50), turun 1→0 (z=50-70) → Segitiga, a=30,b=50,c=70
     Berat  : naik dari 0 (z=60) ke 1 (z=100)   → Monoton Naik, a=60,b=100

   Fungsi z invers (dipakai untuk defuzzifikasi Tsukamoto):
     zRendah(α) = 40 - α × 40        (invers Monoton Turun, domain 0-40)
     zSedang(α) = 30 + α × 20        (invers sisi naik Sedang, puncak di 50!)
     zTinggi(α) = 60 + α × 40        (invers Monoton Naik, domain 60-100)

   PENTING: zSedang menggunakan ×20 (bukan ×40), karena sisi naik segitiga
   Sedang membentang dari a=30 ke b=50 (lebar = 20), bukan ke c=70.

   Defuzzifikasi (Weighted Average):
     z* = Σ(αi·zi) / Σαi

   Klasifikasi akhir:
     0  - 40  → Ringan
     41 - 70  → Sedang
     71 - 100 → Berat
================================================================= */

// ---------- Fungsi keanggotaan INPUT per variabel ----------

// Durasi Bermain: Rendah(0,0,12) trapesium turun, Sedang(8,16,24) segitiga, Tinggi(18,32) trapesium naik
function fuzzifyDurasi(x) {
  const rendah = x <= 0 ? 1 : (x < 12 ? (12 - x) / 12 : 0);
  let sedang = 0;
  if (x > 8 && x < 16) sedang = (x - 8) / 8;
  else if (x >= 16 && x < 24) sedang = (24 - x) / 8;
  const tinggi = x <= 18 ? 0 : (x < 32 ? (x - 18) / 14 : 1);
  return { Rendah: rendah, Sedang: sedang, Tinggi: tinggi };
}

// Frekuensi Bermain: Jarang(0,0,9) trapesium turun, Sering(6,11,16) segitiga, SangatSering(13,22) trapesium naik
function fuzzifyFrekuensi(x) {
  const jarang = x <= 0 ? 1 : (x < 9 ? (9 - x) / 9 : 0);
  let sering = 0;
  if (x > 6 && x < 11) sering = (x - 6) / 5;
  else if (x >= 11 && x < 16) sering = (16 - x) / 5;
  const sangatSering = x <= 13 ? 0 : (x < 22 ? (x - 13) / 9 : 1);
  return { Jarang: jarang, Sering: sering, SangatSering: sangatSering };
}

// Penurunan Akademik: Kecil(0,0,12) trapesium turun, Sedang(9,17,25) segitiga, Besar(20,34) trapesium naik
function fuzzifyAkademik(x) {
  const kecil = x <= 0 ? 1 : (x < 12 ? (12 - x) / 12 : 0);
  let sedang = 0;
  if (x > 9 && x < 17) sedang = (x - 9) / 8;
  else if (x >= 17 && x < 25) sedang = (25 - x) / 8;
  const besar = x <= 20 ? 0 : (x < 34 ? (x - 20) / 14 : 1);
  return { Kecil: kecil, Sedang: sedang, Besar: besar };
}

// Kontrol Diri: Baik(0,0,8) trapesium turun, Sedang(5,12,20) segitiga, Buruk(17,25) trapesium naik
function fuzzifyKontrol(x) {
  const baik = x <= 0 ? 1 : (x < 8 ? (8 - x) / 8 : 0);
  let sedang = 0;
  if (x > 5 && x < 12) sedang = (x - 5) / 7;
  else if (x >= 12 && x < 20) sedang = (20 - x) / 8;
  const buruk = x <= 17 ? 0 : (x < 25 ? (x - 17) / 8 : 1);
  return { Baik: baik, Sedang: sedang, Buruk: buruk };
}

// ---------- Fungsi z invers OUTPUT (defuzzifikasi Tsukamoto) ----------

function zRingan(a) {
  return 40 - (a * 40);
}

function zSedang(a) {
  // Sisi naik segitiga: a=30 menuju puncak b=50 → lebar 20
  return 30 + (a * 20);
}

function zBerat(a) {
  return 60 + (a * 40);
}

// ---------- 24 Aturan Fuzzy (Rule Base) ----------
// Format: [Durasi, Frekuensi, Akademik, KontrolDiri, Output]
const RULES = [
  ["Sedang", "SangatSering", "Sedang", "Sedang", "Sedang"],
  ["Sedang", "Sering", "Kecil", "Sedang", "Sedang"],
  ["Rendah", "Sering", "Kecil", "Baik", "Ringan"],
  ["Tinggi", "SangatSering", "Sedang", "Sedang", "Berat"],
  ["Sedang", "Jarang", "Sedang", "Sedang", "Sedang"],
  ["Rendah", "Sering", "Kecil", "Buruk", "Sedang"],
  ["Sedang", "SangatSering", "Kecil", "Baik", "Sedang"],
  ["Sedang", "Sering", "Sedang", "Buruk", "Sedang"],
  ["Sedang", "SangatSering", "Kecil", "Sedang", "Sedang"],
  ["Rendah", "Sering", "Sedang", "Sedang", "Sedang"],
  ["Sedang", "SangatSering", "Sedang", "Buruk", "Berat"],
  ["Tinggi", "SangatSering", "Kecil", "Buruk", "Berat"],
  ["Sedang", "SangatSering", "Sedang", "Baik", "Sedang"],
  ["Rendah", "SangatSering", "Kecil", "Sedang", "Sedang"],
  ["Sedang", "Jarang", "Kecil", "Buruk", "Sedang"],
  ["Rendah", "Sering", "Kecil", "Sedang", "Ringan"],
  ["Rendah", "Jarang", "Kecil", "Sedang", "Ringan"],
  ["Tinggi", "Jarang", "Sedang", "Baik", "Sedang"],
  ["Sedang", "Sering", "Kecil", "Baik", "Ringan"],
  ["Sedang", "Sering", "Kecil", "Buruk", "Sedang"],
  ["Sedang", "Jarang", "Kecil", "Sedang", "Ringan"],
  ["Sedang", "Sering", "Sedang", "Sedang", "Sedang"],
  ["Rendah", "SangatSering", "Sedang", "Sedang", "Sedang"],
  ["Tinggi", "Sering", "Kecil", "Buruk", "Sedang"],
];

const Z_FUNCTIONS = { Ringan: zRingan, Sedang: zSedang, Berat: zBerat };

/**
 * Jalankan inferensi Fuzzy Tsukamoto penuh (24 aturan) untuk 4 variabel crisp.
 * @returns { skorFuzzy, nilaiZ, hasil, detailAturan: [{rule, alpha, z}] }
 */
function fuzzyTsukamoto(durasi, frekuensi, akademik, kontrol) {
  const mD = fuzzifyDurasi(durasi);
  const mF = fuzzifyFrekuensi(frekuensi);
  const mA = fuzzifyAkademik(akademik);
  const mK = fuzzifyKontrol(kontrol);

  const aktif = [];

  for (const rule of RULES) {
    const [dKey, fKey, aKey, kKey, outKey] = rule;
    const alpha = Math.min(mD[dKey] || 0, mF[fKey] || 0, mA[aKey] || 0, mK[kKey] || 0);
    if (alpha > 0) {
      const z = Z_FUNCTIONS[outKey](alpha);
      aktif.push({ rule, alpha, z, output: outKey });
    }
  }

  let skorFuzzy = 0;
  if (aktif.length > 0) {
    const numerator = aktif.reduce((sum, r) => sum + (r.alpha * r.z), 0);
    const denominator = aktif.reduce((sum, r) => sum + r.alpha, 0);
    skorFuzzy = denominator === 0 ? 0 : numerator / denominator;
  }
  // Fallback: jika tidak ada aturan yang aktif sama sekali (seharusnya tidak
  // terjadi karena 24 aturan sudah mencakup seluruh kombinasi data uji),
  // skorFuzzy tetap 0 dan akan dianggap "Ringan".

  const nilaiZ = Number(skorFuzzy.toFixed(2));
  let hasil = "Ringan";
  if (nilaiZ > 70) hasil = "Berat";
  else if (nilaiZ > 40) hasil = "Sedang";

  return { skorFuzzy, nilaiZ, hasil, detailAturan: aktif };
}

/* ================= DATABASE ================= */

async function initDatabase() {
  try {
    await connectDB();
    console.log("MongoDB terhubung");
    await createAdmin();
  } catch (err) {
    console.log("MongoDB error:", err);
  }
}

initDatabase();

app.use(async (req, res, next) => {
  try {
    await connectDB();
    return next();
  } catch (err) {
    console.log("MongoDB error:", err);
    return res.status(500).json({ message: "Database connection error" });
  }
});

/* ================= BUAT ADMIN DEFAULT ================= */

async function createAdmin() {
  const adminExist = await User.findOne({ email: "admin@gmail.com" });

  if (!adminExist) {
    const hashedPassword = await bcrypt.hash("123456", 10);

    await User.create({
      nama: "Administrator",
      email: "admin@gmail.com",
      password: hashedPassword,
      role: "admin"
    });

    console.log("Admin default dibuat");
  }
}

/* ================= ROUTES ================= */

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "views/home.html"));
});

app.get("/register", (req, res) => {
  res.sendFile(path.join(__dirname, "views/register.html"));
});

app.get("/login", (req, res) => {
  res.sendFile(path.join(__dirname, "views/login.html"));
});

app.get("/gejala", (req, res) => {
  res.sendFile(path.join(__dirname, "views/gejala.html"));
});

app.get("/konsultasi", (req, res) => {
  res.sendFile(path.join(__dirname, "views/konsultasi.html"));
});

app.get("/tentang", (req, res) => {
  res.sendFile(path.join(__dirname, "views/tentang.html"));
});

app.get("/hasil", (req, res) => {
  res.sendFile(path.join(__dirname, "views/hasil.html"));
});

/* ================= API ================= */

app.get("/api/hasil", isLogin, async (req, res) => {
  try {
    const dataHasil = await Hasil.find({ userId: req.session.userId })
      .select("hasil nilaiZ tanggal userId")
      .populate("userId", "nama")
      .sort({ tanggal: -1 });

    logDb(req, "hasil:list", { count: dataHasil.length });
    res.json(dataHasil);
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
});

app.get("/api/user", isLogin, async (req, res) => {
  try {
    const user = await User.findById(req.session.userId);

    logDb(req, "user:get", { userId: req.session.userId });
    res.json({
      nama: user.nama,
      email: user.email,
      foto: user.foto || null,
      role: user.role
    });

  } catch (error) {
    res.status(500).json({ message: "Server error" });
  }
});

app.get("/api/admins", isLogin, isAdmin, async (req, res) => {
  try {
    const admins = await User.find({ role: "admin" })
      .select("nama email foto createdAt");
    logDb(req, "admins:list", { count: admins.length });
    res.json(admins);
  } catch (error) {
    res.status(500).json({ message: "Server error" });
  }
});

app.get("/api/users", isLogin, isAdmin, async (req, res) => {
  try {
    const users = await User.find({ role: "user" })
      .select("nama email foto createdAt");
    logDb(req, "users:list", { count: users.length });
    res.json(users);
  } catch (error) {
    res.status(500).json({ message: "Server error" });
  }
});

app.get("/api/hasil/admin", isLogin, isAdmin, async (req, res) => {
  try {
    const dataHasil = await Hasil.find({})
      .populate("userId", "nama email")
      .sort({ tanggal: -1 });
    logDb(req, "hasil:admin", { count: dataHasil.length });
    res.json(dataHasil);
  } catch (error) {
    res.status(500).json({ message: "Server error" });
  }
});

app.post("/api/admins", isLogin, isAdmin, async (req, res) => {
  try {
    const { nama, email, foto, password } = req.body;

    if (!nama || !email) {
      return res.status(400).json({ message: "Nama dan email wajib diisi" });
    }
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ message: "Format email tidak valid" });
    }

    const existing = await User.findOne({ email });
    if (existing) {
      return res.status(400).json({ message: "Email sudah terdaftar" });
    }

    const rawPassword = password && String(password).trim() ? password : "123456";
    const hashedPassword = await bcrypt.hash(rawPassword, 10);
    const admin = await User.create({
      nama,
      email,
      password: hashedPassword,
      role: "admin",
      foto: foto || null
    });

    res.status(201).json({
      _id: admin._id,
      nama: admin.nama,
      email: admin.email,
      foto: admin.foto,
      createdAt: admin.createdAt
    });
  } catch (error) {
    res.status(500).json({ message: "Server error" });
  }
});

app.put("/api/admins/:id", isLogin, isAdmin, async (req, res) => {
  try {
    const { nama, email, foto, password } = req.body;

    if (!nama || !email) {
      return res.status(400).json({ message: "Nama dan email wajib diisi" });
    }
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ message: "Format email tidak valid" });
    }

    const existing = await User.findOne({
      email,
      _id: { $ne: req.params.id }
    });
    if (existing) {
      return res.status(400).json({ message: "Email sudah digunakan" });
    }

    const updateData = { nama, email };
    if (foto) updateData.foto = foto;
    if (password && String(password).trim()) {
      updateData.password = await bcrypt.hash(password, 10);
    }

    const updated = await User.findByIdAndUpdate(
      req.params.id,
      updateData,
      { new: true }
    );

    if (!updated) {
      return res.status(404).json({ message: "Admin tidak ditemukan" });
    }

    res.json({
      _id: updated._id,
      nama: updated.nama,
      email: updated.email,
      foto: updated.foto,
      createdAt: updated.createdAt
    });
  } catch (error) {
    res.status(500).json({ message: "Server error" });
  }
});

app.delete("/api/admins/:id", isLogin, isAdmin, async (req, res) => {
  try {
    if (req.params.id === String(req.session.userId)) {
      return res.status(400).json({ message: "Tidak bisa menghapus akun sendiri" });
    }

    const deleted = await User.findByIdAndDelete(req.params.id);
    if (!deleted) {
      return res.status(404).json({ message: "Admin tidak ditemukan" });
    }

    res.json({ message: "Admin dihapus" });
  } catch (error) {
    res.status(500).json({ message: "Server error" });
  }
});

app.delete("/api/hasil/:id", isLogin, isAdmin, async (req, res) => {
  try {
    const deleted = await Hasil.findByIdAndDelete(req.params.id);
    if (!deleted) {
      return res.status(404).json({ message: "Data tidak ditemukan" });
    }
    res.json({ message: "Data dihapus" });
  } catch (error) {
    res.status(500).json({ message: "Server error" });
  }
});

/* ================= REGISTER ================= */

app.post("/register", async (req, res) => {
  try {
    const { nama, email, password, confirm_password } = req.body;

    if (password !== confirm_password) {
      return res.send("Password tidak cocok");
    }

    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.send("Email sudah terdaftar");
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const user = new User({
      nama,
      email,
      password: hashedPassword,
      role: "user"
    });

    await user.save();
    res.redirect("/login");

  } catch (error) {
    console.log(error);
    res.send("Terjadi kesalahan");
  }
});

/* ================= LOGIN ================= */

app.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.redirect("/login");
    }

    const user = await User.findOne({ email });
    if (!user) {
      return res.redirect("/login");
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.redirect("/login");
    }

    req.session.userId = user._id;
    req.session.role = user.role;

    req.session.save((err) => {
      if (err) {
        console.log("SESSION SAVE ERROR:", err);
        return res.redirect("/login");
      }

      if (SESSION_DEBUG) {
        console.log("[SESSION] login", {
          userId: String(user._id),
          role: user.role
        });
      }

      if (user.role === "admin") {
        return res.redirect("/admin");
      }

      return res.redirect("/dashboard");
    });

  } catch (error) {
    console.log("LOGIN ERROR:", error);
    return res.redirect("/login");
  }
});

// API detail hasil user
app.get("/api/hasil/:id", isLogin, async (req, res) => {
  try {
    const detail = await Hasil.findOne({
      _id: req.params.id,
      userId: req.session.userId
    }).select("hasil nilaiZ tanggal total jawaban");

    if (!detail) {
      return res.status(404).json({ message: "Data tidak ditemukan" });
    }

    return res.json(detail);
  } catch (error) {
    return res.status(500).json({ message: "Server error" });
  }
});

/* ================= SUBMIT KONSULTASI ================= */

app.post("/submit", isLogin, async (req, res) => {
  try {
    const jawaban = {};
    const nilai = [];

    // Batas maksimal per soal sesuai kuesioner
    const batas = {
      1: 12,  // q1: jam bermain per hari (0-12)
      2: 8,   // q2: jam bermain saat sekolah (0-8)
      3: 12,  // q3: jam bermain hari libur (0-12)
      4: 7,   // q4: hari bermain per minggu (0-7)
      5: 8,   // q5: jam tidur per hari (1-8)
      6: 7,   // q6: kali bermain saat tugas (0-7)
      7: 7,   // q7: kali tidak kerjakan tugas (0-7)
      8: 7,   // q8: kali ditegur guru (0-7)
      9: 20,  // q9: penurunan nilai (0-20)
      10: 8,  // q10: jam tambahan bermain (0-8)
      11: 7,  // q11: kali merasa gelisah (0-7)
      12: 10  // q12: kali coba berhenti (0-10)
    };

    for (let i = 1; i <= 12; i += 1) {
      const key = `q${i}`;
      const raw = req.body[key];
      const parsed = parseFloat(raw);

      if (Number.isNaN(parsed)) {
        return res.status(400).send("Jawaban belum lengkap.");
      }

      const minVal = i === 5 ? 1 : 0;
      if (parsed < minVal || parsed > batas[i]) {
        return res.status(400).send(`Soal ${i}: nilai harus antara ${minVal}–${batas[i]}.`);
      }

      jawaban[key] = parsed;
      nilai.push(parsed);
    }

    const total = nilai.reduce((a, b) => a + b, 0);

    // -------------------------------------------------------
    // Kelompok variabel (TIDAK digabung jadi 1 rata-rata)
    // Durasi      : q1+q2+q3     → max 12+8+12 = 32
    // Frekuensi   : q4+q5+q6     → max 7+8+7   = 22
    // Akademik    : q7+q8+q9     → max 7+7+20  = 34
    // Kontrol Diri: q10+q11+q12  → max 8+7+10  = 25
    // -------------------------------------------------------
    const durasi    = nilai[0] + nilai[1] + nilai[2];
    const frekuensi = nilai[3] + nilai[4] + nilai[5];
    const akademik  = nilai[6] + nilai[7] + nilai[8];
    const kontrol   = nilai[9] + nilai[10] + nilai[11];

    // -------------------------------------------------------
    // Fuzzifikasi 4 variabel + Inferensi 24 Aturan (MIN) +
    // Defuzzifikasi (Weighted Average) — semua dilakukan oleh
    // fuzzyTsukamoto(), TIDAK ada normalisasi/rata-rata gabungan.
    // -------------------------------------------------------
    const { nilaiZ, hasil, detailAturan } = fuzzyTsukamoto(durasi, frekuensi, akademik, kontrol);

    await Hasil.create({
      userId: req.session.userId,
      hasil,
      jawaban,
      total,
      nilaiZ
    });

    const wantsJson =
      (req.headers.accept && req.headers.accept.includes("application/json")) ||
      req.headers["x-requested-with"] === "XMLHttpRequest";

    if (wantsJson) {
      return res.json({
        hasil,
        nilaiZ,
        total,
        skorFuzzy: nilaiZ,
        aturanAktif: detailAturan.length,
        pesan:
          hasil === "Berat"
            ? "Tingkat kecanduan tergolong tinggi. Pertimbangkan pengaturan waktu dan dukungan aktivitas positif."
            : hasil === "Sedang"
              ? "Tingkat kecanduan tergolong sedang. Jaga konsistensi pola bermain dan istirahat."
              : "Tingkat kecanduan tergolong rendah. Pertahankan kebiasaan sehat yang sudah berjalan."
      });
    }

    return res.redirect("/user_hasil");
  } catch (error) {
    console.log("SUBMIT ERROR:", error);
    return res.status(500).send("Terjadi kesalahan.");
  }
});

/* ================= HALAMAN USER ================= */

app.get("/dashboard", isLogin, (req, res) => {
  res.sendFile(path.join(__dirname, "views/user_dashboard.html"));
});

app.get("/user_konsultasi", isLogin, (req, res) => {
  res.sendFile(path.join(__dirname, "views/user_konsultasi.html"));
});

app.get("/user_gejala", isLogin, (req, res) => {
  res.sendFile(path.join(__dirname, "views/user_gejala.html"));
});

app.get("/user_solusi", isLogin, (req, res) => {
  res.sendFile(path.join(__dirname, "views/user_solusi.html"));
});

app.get("/user_hasil", isLogin, (req, res) => {
  res.sendFile(path.join(__dirname, "views/user_hasil.html"));
});

app.get("/profil", isLogin, (req, res) => {
  res.sendFile(path.join(__dirname, "views/profil.html"));
});

/* ================= ADMIN ================= */

function isAdmin(req, res, next) {
  if (req.session.role !== "admin") {
    if (isApiRequest(req)) {
      return res.status(403).json({ message: "Forbidden" });
    }
    return res.redirect("/dashboard");
  }
  next();
}

app.get("/admin", isLogin, isAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, "views/admin.html"));
});

app.get("/admin_manajemen", isLogin, isAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, "views/admin_manajemen.html"));
});

app.get("/admin_pengguna", isLogin, isAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, "views/admin_pengguna.html"));
});

app.get("/admin_riwayat", isLogin, isAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, "views/admin_riwayat.html"));
});

app.get("/admin_detail", isLogin, isAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, "views/admin_detail.html"));
});

/* ================= LOGOUT ================= */

app.get("/logout", (req, res) => {
  req.session.destroy(err => {
    if (err) console.log("LOGOUT ERROR:", err);
    res.redirect("/");
  });
});

/* ================= UPLOAD FOTO ================= */

if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

app.use("/uploads", express.static(uploadDir));

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, uploadDir);
  },
  filename: function (req, file, cb) {
    const ext = path.extname(file.originalname);
    cb(null, Date.now() + ext);
  }
});

const upload = multer({ storage: storage });

/* ================= UPDATE PROFIL ================= */

app.post("/profil/update", isLogin, upload.single("foto"), async (req, res) => {
  try {
    const { nama } = req.body;

    const updateData = { nama };

    if (req.file) {
      updateData.foto = req.file.filename;
    }

    await User.findByIdAndUpdate(req.session.userId, updateData);

    res.redirect("/profil");

  } catch (error) {
    console.log("UPDATE PROFIL ERROR:", error);
    res.redirect("/profil");
  }
});

/* ================= SERVER ================= */

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Server berjalan di http://localhost:${PORT}`);
  });
}

module.exports = app;
