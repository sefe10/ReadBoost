
/* AI Reading Platform - Node.js/Express + SQLite
 * Features:
 * - Teacher sets text + duration
 * - Student reads; client uses Web Speech API for free STT
 * - Server computes word-level diff and stores results
 */
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(bodyParser.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// --- DB Setup ---
const dbFile = path.join(__dirname, 'data.sqlite');
const db = new sqlite3.Database(dbFile);
db.serialize(() => {
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
});

// Tokenize to basic words (letters+digits) lowercased
function tokenize(s) {
  return s
    .replace(/[^\p{L}\p{N}\s']/gu, ' ') // keep letters/numbers/apostrophes
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
}

// Diff using dynamic programming (Levenshtein with ops)
function diffWords(refWords, hypWords) {
  const n = refWords.length;
  const m = hypWords.length;
  const dp = Array.from({length: n+1}, () => Array(m+1).fill(0));
  const bt = Array.from({length: n+1}, () => Array(m+1).fill(null));

  for (let i=0;i<=n;i++){ dp[i][0]=i; bt[i][0]='del'; }
  for (let j=0;j<=m;j++){ dp[0][j]=j; bt[0][j]='ins'; }
  bt[0][0] = 'ok';

  for (let i=1;i<=n;i++){
    for (let j=1;j<=m;j++){
      const cost = refWords[i-1] === hypWords[j-1] ? 0 : 1;
      const del = dp[i-1][j] + 1;
      const ins = dp[i][j-1] + 1;
      const sub = dp[i-1][j-1] + cost;

      let best = sub, op = cost === 0 ? 'match' : 'sub';
      if (del < best){ best = del; op = 'del'; }
      if (ins < best){ best = ins; op = 'ins'; }
      dp[i][j] = best;
      bt[i][j] = op;
    }
  }

  // backtrack
  const ops = [];
  let i=n, j=m;
  while (i>0 || j>0){
    const op = bt[i][j];
    if (op === 'match' || op === 'sub'){
      ops.push({op, ref: refWords[i-1] ?? '', hyp: hypWords[j-1] ?? ''});
      i--; j--;
    } else if (op === 'del'){
      ops.push({op, ref: refWords[i-1] ?? '', hyp: ''});
      i--;
    } else if (op === 'ins'){
      ops.push({op, ref: '', hyp: hypWords[j-1] ?? ''});
      j--;
    } else {
      break;
    }
  }
  ops.reverse();
  return ops;
}

function renderDetailHTML(ref, hyp){
  const refW = tokenize(ref);
  const hypW = tokenize(hyp);
  const ops = diffWords(refW, hypW);
  const pieces = ops.map(o => {
    if (o.op === 'match') return `<span class="w ok">${o.ref}</span>`;
    if (o.op === 'sub') return `<span class="w sub" title="said: ${o.hyp}">${o.ref}</span>`;
    if (o.op === 'del') return `<span class="w del" title="missed">${o.ref}</span>`;
    if (o.op === 'ins') return `<span class="w ins" title="extra">${o.hyp}</span>`;
  });
  const refCount = refW.length;
  const hypCount = hypW.length;
  const errors = ops.filter(o => o.op !== 'match').length;
  return {
    html: `<div class="diff">${pieces.join(' ')}</div>`,
    words_read: hypCount,
    errors
  };
}

// --- API Routes ---

// Create text (teacher)
app.post('/api/texts', (req, res) => {
  const { title, content, duration_sec } = req.body;
  if (!title || !content || !duration_sec) return res.status(400).json({ error: 'Missing fields' });
  db.run(`INSERT INTO texts (title, content, duration_sec) VALUES (?,?,?)`,
    [title, content, duration_sec],
    function(err){
      if (err) return res.status(500).json({ error: err.message });
      return res.json({ id: this.lastID });
    });
});

// List texts
app.get('/api/texts', (req,res) => {
  db.all(`SELECT * FROM texts ORDER BY created_at DESC`, [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// Latest text
app.get('/api/texts/latest', (req,res) => {
  db.get(`SELECT * FROM texts ORDER BY created_at DESC LIMIT 1`, [], (err,row) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!row) return res.json(null);
    res.json(row);
  });
});

// Submit reading (student)
app.post('/api/readings', (req,res) => {
  const { student_name, text_id, transcript, duration_sec } = req.body;
  if (!student_name || !text_id || !transcript || !duration_sec) {
    return res.status(400).json({ error: 'Missing fields' });
  }
  db.get(`SELECT * FROM texts WHERE id=?`, [text_id], (err, textRow) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!textRow) return res.status(404).json({ error: 'Text not found' });

    const { html, words_read, errors } = renderDetailHTML(textRow.content, transcript);
    const wpm = (words_read / (duration_sec/60)).toFixed(1);

    db.run(`INSERT INTO readings (student_name, text_id, transcript, words_read, errors, wpm, detail_html)
            VALUES (?,?,?,?,?,?,?)`,
      [student_name, text_id, transcript, words_read, errors, wpm, html],
      function(err2){
        if (err2) return res.status(500).json({ error: err2.message });
        return res.json({ id: this.lastID, words_read, errors, wpm, detail_html: html });
      });
  });
});

// List readings (teacher dashboard)
app.get('/api/readings', (req,res) => {
  const { student_name, text_id } = req.query;
  let sql = `SELECT r.*, t.title FROM readings r JOIN texts t ON r.text_id=t.id`;
  const params = [];
  const cond = [];
  if (student_name){ cond.push(`r.student_name = ?`); params.push(student_name); }
  if (text_id){ cond.push(`r.text_id = ?`); params.push(text_id); }
  if (cond.length) sql += ` WHERE ` + cond.join(' AND ');
  sql += ` ORDER BY r.created_at DESC`;
  db.all(sql, params, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// Get student's history of texts
app.get('/api/student/:name/history', (req,res) => {
  const name = req.params.name;
  db.all(`SELECT r.id, r.text_id, r.created_at, r.words_read, r.errors, r.wpm, t.title
          FROM readings r JOIN texts t ON r.text_id=t.id
          WHERE r.student_name=?
          ORDER BY r.created_at DESC`, [name], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// Detailed diff page for a reading
app.get('/api/reading/:id/detail', (req,res) => {
  const id = req.params.id;
  db.get(`SELECT r.detail_html, t.content AS ref_text, r.transcript, r.student_name, r.wpm, r.errors, r.words_read, t.title, r.created_at
          FROM readings r JOIN texts t ON r.text_id=t.id WHERE r.id=?`, [id], (err,row) => {
    if (err) return res.status(500).send('Error');
    if (!row) return res.status(404).send('Not found');
    res.json(row);
  });
});

// Serve app
app.get('/', (req,res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
