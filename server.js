const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const multer = require("multer");
const Database = require("better-sqlite3");
const helmet = require("helmet");
const compression = require("compression");
const rateLimit = require("express-rate-limit");
const { imageSize } = require("image-size");
require("dotenv").config();

const config = buildConfig();
const app = express();

fs.mkdirSync(config.dataDir, { recursive: true });
fs.mkdirSync(config.uploadsDir, { recursive: true });

const db = setupDatabase(config.dbPath);
normalizeLegacyEditKeys(db, config);
seedDataIfNeeded(db, config);

if (config.trustProxy) {
  app.set("trust proxy", 1);
}
app.disable("x-powered-by");

app.use(
  helmet({
    crossOriginResourcePolicy: { policy: "cross-origin" }
  })
);
app.use(compression());
app.use(express.json({ limit: `${config.maxJsonMb}mb` }));
app.use(express.urlencoded({ extended: false, limit: `${config.maxJsonMb}mb` }));

const readLimiter = rateLimit({
  windowMs: config.rateLimitWindowMs,
  limit: config.rateLimitRead,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: "Too many requests. Please retry later." }
});

const writeLimiter = rateLimit({
  windowMs: config.rateLimitWindowMs,
  limit: config.rateLimitWrite,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: "Too many write operations. Please retry later." }
});

const uploadLimiter = rateLimit({
  windowMs: config.rateLimitWindowMs,
  limit: config.rateLimitUpload,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: "Too many uploads. Please retry later." }
});

const allowedImageExtensions = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif", ".avif", ".bmp", ".tif", ".tiff"]);

const uploadStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, config.uploadsDir),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname || "").toLowerCase();
    const safeExt = allowedImageExtensions.has(ext) ? ext : ".jpg";
    cb(null, `${Date.now()}-${crypto.randomBytes(6).toString("hex")}${safeExt}`);
  }
});

const upload = multer({
  storage: uploadStorage,
  limits: { fileSize: config.maxUploadMb * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname || "").toLowerCase();
    if (!file.mimetype || !file.mimetype.startsWith("image/") || !allowedImageExtensions.has(ext)) {
      cb(new Error("Only image files are allowed."));
      return;
    }
    cb(null, true);
  }
});

app.get("/healthz", (_req, res) => {
  const entryCount = db.prepare("SELECT COUNT(*) AS count FROM entries").get().count;
  res.json({
    status: "ok",
    uptimeSeconds: Math.floor(process.uptime()),
    entryCount
  });
});

app.use(
  "/uploads",
  express.static(config.uploadsDir, {
    maxAge: "7d",
    etag: true
  })
);
app.use(
  express.static(path.join(config.rootDir, "public"), {
    maxAge: "1h",
    etag: true
  })
);

app.use("/api", readLimiter);

app.get("/api/authors", (_req, res) => {
  const rows = db
    .prepare(
      `SELECT author, COUNT(*) AS count
       FROM entries
       GROUP BY author
       ORDER BY count DESC, author COLLATE NOCASE ASC`
    )
    .all();
  res.json(rows);
});

app.get("/api/albums", (req, res) => {
  const author = sanitizeText(req.query.author, 80);
  let sql = "SELECT album, COUNT(*) AS count FROM entries";
  const params = [];

  if (author && author !== "__ALL__") {
    sql += " WHERE author = ?";
    params.push(author);
  }

  sql += " GROUP BY album ORDER BY count DESC, album COLLATE NOCASE ASC";
  const rows = db.prepare(sql).all(...params);
  res.json(rows);
});

app.get("/api/entries", (req, res) => {
  const author = sanitizeText(req.query.author, 80);
  const album = sanitizeText(req.query.album, 80);
  const where = [];
  const params = [];

  if (author && author !== "__ALL__") {
    where.push("e.author = ?");
    params.push(author);
  }
  if (album && album !== "__ALL__") {
    where.push("e.album = ?");
    params.push(album);
  }

  const whereClause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const rows = db
    .prepare(
      `SELECT
         e.id,
         e.author,
         e.album,
         e.title,
         e.location,
         e.travel_date AS travelDate,
         e.note,
         e.image_path AS imagePath,
         e.image_width AS imageWidth,
         e.image_height AS imageHeight,
         e.created_at AS createdAt,
         e.updated_at AS updatedAt,
         (SELECT COUNT(*) FROM comments c WHERE c.entry_id = e.id) AS commentCount
       FROM entries e
       ${whereClause}
       ORDER BY e.travel_date DESC, e.created_at DESC`
    )
    .all(...params)
    .map((item) => ({
      ...item,
      imageRatio: item.imageWidth / item.imageHeight
    }));

  res.json(rows);
});

app.get("/api/entries/:id/comments", (req, res) => {
  const entryId = toPositiveInt(req.params.id);
  if (!entryId) {
    res.status(400).json({ error: "Invalid entry id." });
    return;
  }

  const exists = db.prepare("SELECT 1 FROM entries WHERE id = ?").get(entryId);
  if (!exists) {
    res.status(404).json({ error: "Entry not found." });
    return;
  }

  const comments = db
    .prepare(
      `SELECT id, commenter, content, created_at AS createdAt
       FROM comments
       WHERE entry_id = ?
       ORDER BY created_at ASC, id ASC`
    )
    .all(entryId);
  res.json(comments);
});

app.post("/api/entries", writeLimiter, uploadLimiter, upload.single("image"), (req, res) => {
  const author = sanitizeText(req.body.author, 80);
  const album = sanitizeText(req.body.album, 80);
  const title = sanitizeText(req.body.title, 120);
  const location = sanitizeText(req.body.location, 120);
  const travelDate = sanitizeDate(req.body.travelDate);
  const note = sanitizeText(req.body.note, 1500);
  const editKey = sanitizeText(req.body.editKey, 64);

  if (!author || !album || !title || !location || !travelDate || !note || !editKey) {
    cleanupUploadedFile(req.file);
    res.status(400).json({ error: "author, album, title, location, travelDate, note, editKey are required." });
    return;
  }
  if (editKey.length < 8) {
    cleanupUploadedFile(req.file);
    res.status(400).json({ error: "editKey must be at least 8 characters." });
    return;
  }
  if (!req.file) {
    res.status(400).json({ error: "Please upload an image file." });
    return;
  }

  let dimensions;
  try {
    dimensions = imageSize(fs.readFileSync(req.file.path));
  } catch (_error) {
    cleanupUploadedFile(req.file);
    res.status(400).json({ error: "Cannot parse image dimensions." });
    return;
  }

  const imageWidth = dimensions.width || 0;
  const imageHeight = dimensions.height || 0;
  if (imageWidth <= 0 || imageHeight <= 0) {
    cleanupUploadedFile(req.file);
    res.status(400).json({ error: "Invalid image dimensions." });
    return;
  }

  const now = new Date().toISOString();
  const imagePath = `/uploads/${req.file.filename}`;
  const editKeyHash = hashEditKey(editKey, config.editKeyPepper);

  const result = db
    .prepare(
      `INSERT INTO entries (
         author, album, title, location, travel_date, note,
         image_path, image_width, image_height, edit_key_hash, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(author, album, title, location, travelDate, note, imagePath, imageWidth, imageHeight, editKeyHash, now, now);

  const created = db
    .prepare(
      `SELECT
         id, author, album, title, location, travel_date AS travelDate, note,
         image_path AS imagePath, image_width AS imageWidth, image_height AS imageHeight,
         created_at AS createdAt, updated_at AS updatedAt,
         0 AS commentCount
       FROM entries WHERE id = ?`
    )
    .get(result.lastInsertRowid);

  res.status(201).json({
    ...created,
    imageRatio: created.imageWidth / created.imageHeight
  });
});

app.put("/api/entries/:id", writeLimiter, (req, res) => {
  const entryId = toPositiveInt(req.params.id);
  if (!entryId) {
    res.status(400).json({ error: "Invalid entry id." });
    return;
  }

  const existing = db.prepare("SELECT id, edit_key_hash AS editKeyHash FROM entries WHERE id = ?").get(entryId);
  if (!existing) {
    res.status(404).json({ error: "Entry not found." });
    return;
  }

  const currentEditKey = sanitizeText(req.body.currentEditKey, 64);
  if (!currentEditKey) {
    res.status(400).json({ error: "currentEditKey is required for edit." });
    return;
  }

  const currentEditHash = hashEditKey(currentEditKey, config.editKeyPepper);
  if (!existing.editKeyHash || existing.editKeyHash !== currentEditHash) {
    res.status(403).json({ error: "Invalid edit key." });
    return;
  }

  const updates = [];
  const params = [];
  const author = sanitizeText(req.body.author, 80);
  const album = sanitizeText(req.body.album, 80);
  const title = sanitizeText(req.body.title, 120);
  const location = sanitizeText(req.body.location, 120);
  const travelDate = req.body.travelDate === undefined ? undefined : sanitizeDate(req.body.travelDate);
  const note = sanitizeText(req.body.note, 1500);
  const nextEditKey = sanitizeText(req.body.nextEditKey, 64);

  if (req.body.author !== undefined) {
    if (!author) {
      res.status(400).json({ error: "author cannot be empty." });
      return;
    }
    updates.push("author = ?");
    params.push(author);
  }
  if (req.body.album !== undefined) {
    if (!album) {
      res.status(400).json({ error: "album cannot be empty." });
      return;
    }
    updates.push("album = ?");
    params.push(album);
  }
  if (req.body.title !== undefined) {
    if (!title) {
      res.status(400).json({ error: "title cannot be empty." });
      return;
    }
    updates.push("title = ?");
    params.push(title);
  }
  if (req.body.location !== undefined) {
    if (!location) {
      res.status(400).json({ error: "location cannot be empty." });
      return;
    }
    updates.push("location = ?");
    params.push(location);
  }
  if (req.body.travelDate !== undefined) {
    if (!travelDate) {
      res.status(400).json({ error: "travelDate must use YYYY-MM-DD." });
      return;
    }
    updates.push("travel_date = ?");
    params.push(travelDate);
  }
  if (req.body.note !== undefined) {
    if (!note) {
      res.status(400).json({ error: "note cannot be empty." });
      return;
    }
    updates.push("note = ?");
    params.push(note);
  }
  if (req.body.nextEditKey !== undefined) {
    if (nextEditKey.length < 8) {
      res.status(400).json({ error: "nextEditKey must be at least 8 characters." });
      return;
    }
    updates.push("edit_key_hash = ?");
    params.push(hashEditKey(nextEditKey, config.editKeyPepper));
  }

  if (!updates.length) {
    res.status(400).json({ error: "No updatable fields found." });
    return;
  }

  updates.push("updated_at = ?");
  params.push(new Date().toISOString(), entryId);

  db.prepare(`UPDATE entries SET ${updates.join(", ")} WHERE id = ?`).run(...params);

  const updated = db
    .prepare(
      `SELECT
         id, author, album, title, location, travel_date AS travelDate, note,
         image_path AS imagePath, image_width AS imageWidth, image_height AS imageHeight,
         created_at AS createdAt, updated_at AS updatedAt,
         (SELECT COUNT(*) FROM comments c WHERE c.entry_id = entries.id) AS commentCount
       FROM entries WHERE id = ?`
    )
    .get(entryId);

  res.json({
    ...updated,
    imageRatio: updated.imageWidth / updated.imageHeight
  });
});

app.post("/api/entries/:id/comments", writeLimiter, (req, res) => {
  const entryId = toPositiveInt(req.params.id);
  if (!entryId) {
    res.status(400).json({ error: "Invalid entry id." });
    return;
  }

  const exists = db.prepare("SELECT 1 FROM entries WHERE id = ?").get(entryId);
  if (!exists) {
    res.status(404).json({ error: "Entry not found." });
    return;
  }

  const commenter = sanitizeText(req.body.commenter, 80);
  const content = sanitizeText(req.body.content, 800);
  if (!commenter || !content) {
    res.status(400).json({ error: "commenter and content are required." });
    return;
  }

  const now = new Date().toISOString();
  const result = db
    .prepare("INSERT INTO comments (entry_id, commenter, content, created_at) VALUES (?, ?, ?, ?)")
    .run(entryId, commenter, content, now);

  const comment = db
    .prepare("SELECT id, commenter, content, created_at AS createdAt FROM comments WHERE id = ?")
    .get(result.lastInsertRowid);

  res.status(201).json(comment);
});

app.use((error, _req, res, _next) => {
  if (error instanceof multer.MulterError) {
    if (error.code === "LIMIT_FILE_SIZE") {
      res.status(400).json({ error: `Image is too large. Max ${config.maxUploadMb}MB.` });
      return;
    }
    res.status(400).json({ error: `Upload failed: ${error.message}` });
    return;
  }
  if (error) {
    console.error(error);
    res.status(500).json({ error: "Internal server error." });
    return;
  }
  res.status(500).json({ error: "Unknown error." });
});

app.use((_req, res) => {
  res.sendFile(path.join(config.rootDir, "public", "index.html"));
});

app.listen(config.port, config.host, () => {
  console.log(`Travel journal app listening on http://${config.host}:${config.port}`);
  if (config.nodeEnv === "production" && config.editKeyPepper === "change-me-edit-key-pepper") {
    console.warn("WARNING: EDIT_KEY_PEPPER is default. Set a strong custom value in production.");
  }
});

function setupDatabase(dbPath) {
  const database = new Database(dbPath);
  database.pragma("journal_mode = WAL");
  database.pragma("foreign_keys = ON");
  database.pragma("busy_timeout = 5000");

  database.exec(`
    CREATE TABLE IF NOT EXISTS entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      author TEXT NOT NULL,
      album TEXT NOT NULL,
      title TEXT NOT NULL,
      location TEXT NOT NULL,
      travel_date TEXT NOT NULL,
      note TEXT NOT NULL,
      image_path TEXT NOT NULL,
      image_width INTEGER NOT NULL,
      image_height INTEGER NOT NULL,
      edit_key_hash TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entry_id INTEGER NOT NULL,
      commenter TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY(entry_id) REFERENCES entries(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_entries_author ON entries(author);
    CREATE INDEX IF NOT EXISTS idx_entries_album ON entries(album);
    CREATE INDEX IF NOT EXISTS idx_entries_travel_date ON entries(travel_date DESC);
    CREATE INDEX IF NOT EXISTS idx_comments_entry_id ON comments(entry_id);
  `);

  const columns = database.prepare("PRAGMA table_info(entries)").all();
  const hasEditKeyHash = columns.some((col) => col.name === "edit_key_hash");
  if (!hasEditKeyHash) {
    database.exec("ALTER TABLE entries ADD COLUMN edit_key_hash TEXT NOT NULL DEFAULT ''");
  }
  return database;
}

function seedDataIfNeeded(database, runtimeConfig) {
  if (!runtimeConfig.seedDemoData) {
    return;
  }
  const count = database.prepare("SELECT COUNT(*) AS count FROM entries").get().count;
  if (count > 0) {
    return;
  }

  const demoEditKeyHash = hashEditKey("demo12345", runtimeConfig.editKeyPepper);
  const now = new Date().toISOString();
  const seeds = [
    {
      author: "Lin Zhou",
      album: "Hokkaido Winter",
      title: "Harbor in Morning Mist",
      location: "Japan · Otaru",
      travelDate: "2025-12-14",
      note: "Cold breeze, empty harbor and soft fog made the walk feel very slow and quiet.",
      imagePath: "https://images.unsplash.com/photo-1473116763249-2faaef81ccda?auto=format&fit=crop&w=1400&q=80",
      imageWidth: 1400,
      imageHeight: 900
    },
    {
      author: "Chen Ye",
      album: "Northwest Road",
      title: "Salt Lake Wind Marks",
      location: "China · Qinghai",
      travelDate: "2025-10-02",
      note: "Patterns on the lakeside were carved by wind. The whole place sounded distant and hollow.",
      imagePath: "https://images.unsplash.com/photo-1519904981063-b0cf448d479e?auto=format&fit=crop&w=1200&q=80",
      imageWidth: 1200,
      imageHeight: 820
    },
    {
      author: "Song Jia",
      album: "Iceland Ring",
      title: "Waves on Black Sand",
      location: "Iceland · Vik",
      travelDate: "2025-04-06",
      note: "Strong wind and dark sand made the coastline feel minimal and dramatic.",
      imagePath: "https://images.unsplash.com/photo-1503264116251-35a269479413?auto=format&fit=crop&w=1400&q=80",
      imageWidth: 1400,
      imageHeight: 930
    }
  ];

  const insert = database.prepare(
    `INSERT INTO entries (
       author, album, title, location, travel_date, note,
       image_path, image_width, image_height, edit_key_hash, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  const tx = database.transaction(() => {
    for (const item of seeds) {
      insert.run(
        item.author,
        item.album,
        item.title,
        item.location,
        item.travelDate,
        item.note,
        item.imagePath,
        item.imageWidth,
        item.imageHeight,
        demoEditKeyHash,
        now,
        now
      );
    }
  });
  tx();
}

function buildConfig() {
  const rootDir = __dirname;
  const nodeEnv = process.env.NODE_ENV || "development";
  const dbPath = path.resolve(process.env.DB_PATH || path.join(rootDir, "data", "travel.db"));
  const dataDir = path.dirname(dbPath);
  const uploadsDir = path.resolve(process.env.UPLOADS_DIR || path.join(rootDir, "uploads"));

  return {
    rootDir,
    nodeEnv,
    host: process.env.HOST || "0.0.0.0",
    port: toNumber(process.env.PORT, 3000),
    dbPath,
    dataDir,
    uploadsDir,
    maxUploadMb: toNumber(process.env.MAX_UPLOAD_MB, 15),
    maxJsonMb: toNumber(process.env.MAX_JSON_MB, 1),
    trustProxy: parseBoolean(process.env.TRUST_PROXY, false),
    rateLimitWindowMs: toNumber(process.env.RATE_LIMIT_WINDOW_MS, 15 * 60 * 1000),
    rateLimitRead: toNumber(process.env.RATE_LIMIT_READ, 300),
    rateLimitWrite: toNumber(process.env.RATE_LIMIT_WRITE, 80),
    rateLimitUpload: toNumber(process.env.RATE_LIMIT_UPLOAD, 24),
    editKeyPepper: process.env.EDIT_KEY_PEPPER || "change-me-edit-key-pepper",
    seedDemoData: parseBoolean(process.env.SEED_DEMO_DATA, nodeEnv !== "production"),
    legacyEditKey: process.env.LEGACY_EDIT_KEY || "demo12345"
  };
}

function sanitizeText(value, maxLen) {
  if (value === null || value === undefined) {
    return "";
  }
  return String(value).trim().slice(0, maxLen);
}

function sanitizeDate(value) {
  const raw = sanitizeText(value, 20);
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    return "";
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    Number.isNaN(date.getTime()) ||
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return "";
  }
  return raw;
}

function toPositiveInt(value) {
  const num = Number(value);
  if (!Number.isInteger(num) || num <= 0) {
    return 0;
  }
  return num;
}

function toNumber(value, fallback) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function parseBoolean(value, fallback) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  const normalized = String(value).toLowerCase();
  return normalized === "true" || normalized === "1" || normalized === "yes";
}

function hashEditKey(rawKey, pepper) {
  return crypto.scryptSync(rawKey, pepper, 64).toString("hex");
}

function normalizeLegacyEditKeys(database, runtimeConfig) {
  const emptyCount = database
    .prepare("SELECT COUNT(*) AS count FROM entries WHERE edit_key_hash IS NULL OR edit_key_hash = ''")
    .get().count;
  if (emptyCount < 1) {
    return;
  }

  const legacyHash = hashEditKey(runtimeConfig.legacyEditKey, runtimeConfig.editKeyPepper);
  database
    .prepare("UPDATE entries SET edit_key_hash = ? WHERE edit_key_hash IS NULL OR edit_key_hash = ''")
    .run(legacyHash);

  console.warn(
    `Applied legacy edit key to ${emptyCount} entries. Current legacy key: ${runtimeConfig.legacyEditKey}.`
  );
}

function cleanupUploadedFile(file) {
  if (!file || !file.path) {
    return;
  }
  try {
    fs.unlinkSync(file.path);
  } catch (_error) {
    // ignore cleanup errors
  }
}
