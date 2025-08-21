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

// (metin ekleme, listeleme, silme; okuma gönderme, listeleme; öğrenci metin+durum sorgusu)
// Burada ayrıntılı API uçları tanımlanacak (kısaltıldı)

app.listen(PORT, ()=>console.log("Server running at http://localhost:"+PORT));
