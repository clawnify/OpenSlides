-- Decks: a reveal.js presentation authored as designed HTML slides, separated
-- by a line containing `---`. `theme` is a reveal.js theme name (white, black,
-- league, …) used as the base under the brand's token overrides.
CREATE TABLE IF NOT EXISTS decks (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  title TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  theme TEXT NOT NULL DEFAULT 'black',
  -- per-presentation pagination: a single mode — "dots" (centered, default),
  -- "arrows" (arrows + progress bar), "numbers" (page numbers), or "none".
  nav TEXT NOT NULL DEFAULT '{"mode":"dots"}',
  -- which brand from the library this deck uses (NULL = the first/default brand)
  brand_id TEXT,
  -- page format: '16:9' (presentation) or 'a4-portrait' (A4 document). Drives
  -- the design canvas size, the editor aspect ratio and the PDF page size.
  format TEXT NOT NULL DEFAULT '16:9',
  -- deck-level "agent.md": general, free-form instructions for this deck that the
  -- AI follows on every generate (audience, tone, must-say points, do/don'ts).
  instructions TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Brand library: each brand is an agent-authored DESIGN.md. The prose guides
-- generation; a fenced `clawnify-brand` tokens block drives reveal.js theme
-- variables, fonts and the logo. A deck picks one brand to inherit.
CREATE TABLE IF NOT EXISTS brands (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  name TEXT NOT NULL DEFAULT 'Brand',
  design_md TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Media: images/video uploaded into a slide and brand logos. Stored in R2 under
-- `key`; referenced from deck content / brand DESIGN.md as `assets/<key>` (e.g.
-- ![](assets/logo.png)). There is no library — a `media` asset lives only while
-- it's referenced; the server garbage-collects orphans when the last reference
-- goes. `reference` assets are a brand's original source files (the PDF/images a
-- brand was replicated from) — provenance + a fidelity oracle for later edits.
-- They are never swept; they live until their brand is deleted.
CREATE TABLE IF NOT EXISTS assets (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  content_type TEXT NOT NULL DEFAULT 'application/octet-stream',
  size INTEGER NOT NULL DEFAULT 0,
  -- 'media' (GC'd when unreferenced) or 'reference' (kept while its brand lives)
  role TEXT NOT NULL DEFAULT 'media',
  -- for role='reference': the brand this original belongs to
  brand_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
