// AI Reading Platform v2 - with teacher login, student panel, delete options
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

const app = express();
const PORT = process.env.PORT || 3000;
const SECRET = "supersecretkey";

app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

const dbFile = path.join(__dirname, 'data.sqlite');
const db = new sqlite3.Database(dbFile);

// tablolar
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS teachers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE,
    password_hash TEXT
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS texts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    duration_sec INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS readings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    student_name TEXT NOT NULL,
    text_id INTEGER NOT NULL,
    transcript TEXT NOT NULL,
    words_read INTEGER NOT NULL,
    errors INTEGER NOT NULL,
    wpm REAL NOT NULL,
    detail_html TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(text_id) REFERENCES texts(id)
  )`);

  // varsayılan öğretmen ekle
  db.get("SELECT * FROM teachers WHERE username=?", ["ogretmen"], (err,row)=>{
    if(!row){
      bcrypt.hash("Etathlon!2025", 10, (err,hash)=>{
        db.run("INSERT INTO teachers (username,password_hash) VALUES (?,?)", ["ogretmen", hash]);
        console.log("Varsayılan öğretmen: ogretmen / Etathlon!2025");
      });
    }
  });
});

// auth middleware
function auth(req,res,next){
  const header = req.headers["authorization"];
  if(!header) return res.status(401).json({error:"No token"});
  const token = header.split(" ")[1];
  jwt.verify(token, SECRET, (err,user)=>{
    if(err) return res.status(403).json({error:"Invalid token"});
    req.user = user; next();
  });
}

// login
app.post("/api/auth/login",(req,res)=>{
  const {username,password} = req.body;
  db.get("SELECT * FROM teachers WHERE username=?",[username],(err,row)=>{
    if(!row) return res.status(400).json({error:"User not found"});
    bcrypt.compare(password,row.password_hash,(err,same)=>{
      if(!same) return res.status(400).json({error:"Wrong password"});
      const token = jwt.sign({username:row.username}, SECRET, {expiresIn:"6h"});
      res.json({token});
    });
  });
});

// Metin ekleme
app.post("/api/texts", auth, (req, res) => {
  const {title, content, duration_sec} = req.body;
  if(!title || !content || !duration_sec) {
    return res.status(400).json({error: "Missing fields"});
  }

  db.run("INSERT INTO texts (title, content, duration_sec) VALUES (?,?,?)", 
    [title, content, duration_sec], 
    function(err) {
      if(err) return res.status(500).json({error: err.message});
      res.json({id: this.lastID});
    }
  );
});

// Metinleri listeleme
app.get("/api/texts", (req, res) => {
  db.all("SELECT * FROM texts ORDER BY created_at DESC", (err, rows) => {
    if(err) return res.status(500).json({error: err.message});
    res.json(rows);
  });
});

// Metin silme
app.delete("/api/texts/:id", auth, (req, res) => {
  const id = req.params.id;
  db.run("DELETE FROM texts WHERE id = ?", [id], function(err) {
    if(err) return res.status(500).json({error: err.message});
    // İlgili okumaları da sil
    db.run("DELETE FROM readings WHERE text_id = ?", [id], (err) => {
      if(err) console.error("Error deleting related readings:", err);
    });
    res.json({deleted: this.changes});
  });
});

// Okumaları listeleme (en son okumalar)
app.get("/api/readings", (req, res) => {
  const query = `
    SELECT r.*, t.title, t.content, t.duration_sec
    FROM readings r
    JOIN texts t ON r.text_id = t.id
    ORDER BY r.created_at DESC
  `;
  db.all(query, (err, rows) => {
    if(err) return res.status(500).json({error: err.message});
    res.json(rows);
  });
});

// Okuma detayı
app.get("/api/reading/:id/detail", (req, res) => {
  const id = req.params.id;
  const query = `
    SELECT r.*, t.title, t.content
    FROM readings r
    JOIN texts t ON r.text_id = t.id
    WHERE r.id = ?
  `;
  db.get(query, [id], (err, row) => {
    if(err) return res.status(500).json({error: err.message});
    if(!row) return res.status(404).json({error: "Reading not found"});
    res.json(row);
  });
});

// Öğrenci haftalık/aylık istatistikleri
app.get("/api/student/:name/weekly-monthly", (req, res) => {
  const name = req.params.name;
  const weekAgo = new Date();
  weekAgo.setDate(weekAgo.getDate() - 7);
  const monthAgo = new Date();
  monthAgo.setDate(monthAgo.getDate() - 30);

  // Haftalık veriler
  const weeklyQuery = `
    SELECT 
      COUNT(*) as readings,
      SUM(words_read) as total_words,
      AVG(wpm) as avg_wpm
    FROM readings 
    WHERE student_name = ? AND created_at >= ?
  `;

  // Aylık veriler
  const monthlyQuery = `
    SELECT 
      COUNT(*) as readings,
      SUM(words_read) as total_words,
      AVG(wpm) as avg_wpm
    FROM readings 
    WHERE student_name = ? AND created_at >= ?
  `;

  db.get(weeklyQuery, [name, weekAgo.toISOString()], (err, weekly) => {
    if(err) return res.status(500).json({error: err.message});

    db.get(monthlyQuery, [name, monthAgo.toISOString()], (err, monthly) => {
      if(err) return res.status(500).json({error: err.message});

      res.json({
        weekly: weekly || {},
        monthly: monthly || {}
      });
    });
  });
});

// YENİ: Belirli bir metni okuyan öğrencilerin listesi
app.get("/api/text/:textId/students", (req, res) => {
  const textId = req.params.textId;

  const query = `
    SELECT 
      r.student_name,
      r.wpm,
      r.errors,
      r.words_read,
      r.created_at,
      r.id as reading_id,
      COUNT(r.student_name) as reading_count
    FROM readings r
    WHERE r.text_id = ?
    GROUP BY r.student_name
    ORDER BY r.wpm DESC, r.created_at DESC
  `;

  db.all(query, [textId], (err, rows) => {
    if(err) return res.status(500).json({error: err.message});

    // Her öğrenci için en iyi performansı al
    const detailedQuery = `
      SELECT 
        r.student_name,
        MAX(r.wpm) as best_wpm,
        MIN(r.errors) as best_errors,
        COUNT(*) as total_attempts,
        MAX(r.created_at) as last_attempt,
        r.id as best_reading_id
      FROM readings r
      WHERE r.text_id = ?
      GROUP BY r.student_name
      ORDER BY best_wpm DESC, last_attempt DESC
    `;

    db.all(detailedQuery, [textId], (err, detailedRows) => {
      if(err) return res.status(500).json({error: err.message});
      res.json(detailedRows);
    });
  });
});

// Okuma kaydetme (öğrenci tarafından kullanılacak)
app.post("/api/readings", (req, res) => {
  const {student_name, text_id, transcript, words_read, errors, wpm, detail_html} = req.body;

  if(!student_name || !text_id || !transcript) {
    return res.status(400).json({error: "Missing required fields"});
  }

  db.run(`INSERT INTO readings 
    (student_name, text_id, transcript, words_read, errors, wpm, detail_html) 
    VALUES (?,?,?,?,?,?,?)`, 
    [student_name, text_id, transcript, words_read||0, errors||0, wpm||0, detail_html||''],
    function(err) {
      if(err) return res.status(500).json({error: err.message});
      res.json({id: this.lastID});
    }
  );
});

// YENİ: Öğrenci için metinleri getir (önceki deneme bilgisiyle birlikte)
app.get("/api/student/:name/texts", (req, res) => {
  const studentName = req.params.name;

  const query = `
    SELECT 
      t.*,
      r.best_wpm,
      r.best_errors,
      r.total_attempts,
      r.last_attempt
    FROM texts t
    LEFT JOIN (
      SELECT 
        text_id,
        MAX(wpm) as best_wpm,
        MIN(errors) as best_errors,
        COUNT(*) as total_attempts,
        MAX(created_at) as last_attempt
      FROM readings 
      WHERE student_name = ?
      GROUP BY text_id
    ) r ON t.id = r.text_id
    ORDER BY t.created_at DESC
  `;

  db.all(query, [studentName], (err, rows) => {
    if(err) return res.status(500).json({error: err.message});
    res.json(rows);
  });
});

// YENİ: Öğrenci için tek bir metin detayı getir
app.get("/api/text/:id", (req, res) => {
  const textId = req.params.id;

  db.get("SELECT * FROM texts WHERE id = ?", [textId], (err, row) => {
    if(err) return res.status(500).json({error: err.message});
    if(!row) return res.status(404).json({error: "Text not found"});
    res.json(row);
  });
});

// YENİ: Öğrenci için okuma geçmişini getir
app.get("/api/student/:name/readings", (req, res) => {
  const studentName = req.params.name;

  const query = `
    SELECT r.*, t.title
    FROM readings r
    JOIN texts t ON r.text_id = t.id
    WHERE r.student_name = ?
    ORDER BY r.created_at DESC
    LIMIT 10
  `;

  db.all(query, [studentName], (err, rows) => {
    if(err) return res.status(500).json({error: err.message});
    res.json(rows);
  });
});

app.listen(PORT, ()=>console.log("Server running at http://localhost:"+PORT));