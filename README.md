# QA Test Scenario Tool

A small internal tool for the Product Engineering QA flow: every time a new enhancement,
customization or feature comes in, create it under its product and upload the test scenario
CSV/XLSX. The dashboard then shows the scenarios one per row with clean serial numbers.

Theme: white + deep blue `#0129ac`.

## Run it

```bash
npm install      # once
npm start        # http://localhost:4310
```

Use a different port with `PORT=5000 npm start` (PowerShell: `$env:PORT=5000; npm start`).

That is enough to run it: scenarios are stored in `server/data/db.json` and
nothing else needs setting up.

For the AI features (the Test Cases button, and asking the assistant to draft
scenarios) or to store the data in MongoDB instead, copy the template and fill
in what you need:

```bash
copy .env.sample .env     # macOS/Linux: cp .env.sample .env
```

`.env.sample` lists every setting with a note on what it does. `.env` itself is
gitignored — it holds live keys, so never commit it.

## How it works

```
Dashboard
 └── Products:  Message  |  Email  |  Content
      └── click a product  →  list of enhancements / features for it
           └── click an enhancement name  →  its test scenarios
                S.No | Test Scenario | (extra columns from your file) | Action

 Documents:  Enhancement Documents
              └── click a document  →  its matter and screenshots, shown in the tool
```

- **+ New Enhancement** — pick the product, type the enhancement/feature name, then attach the
  scenario CSV/XLSX, the enhancement document, or both. Both files are optional; at least one is
  needed. One enhancement name per product (duplicates are rejected).
- **Upload CSV** (inside an enhancement) — re-upload for the same enhancement, either
  *replacing* the scenarios or *appending* to them (serial numbers are re-generated so the
  list stays 1..N).
- **Add a test scenario in the tool** — the box under the table appends one typed scenario as the
  next numbered row, without any file.
- **Delete** on a scenario row — asks *Yes, delete / No, cancel* first, then removes that row and
  renumbers the rest 1..N.
- **Test Cases** on a scenario row — expands a panel under that row with detailed test cases
  (Test Case / Test Scenario / Preconditions / Test Steps / Expected Result), written by OpenAI or Claude
  from that scenario. Cached after the first run; **Regenerate** writes a fresh set. Needs an API
  key — see below.
- **Export CSV** — download the stored scenarios back as a clean CSV.
- **Enhancement document** — attach the write-up while creating an enhancement, or upload one from
  **Enhancement Documents** in the left panel. Word files are shown inside the tool with their
  screenshots, PDFs open in the built-in viewer, images show as a single screenshot, and
  .md/.txt are formatted as text. Inside an enhancement, **View document** opens its write-up.
- **Documents tabs** — inside Documents, one tab per product (Message / Email / Content) so each
  product keeps its own write-ups. A document panel has **Edit** to rename it or move it to
  another product tab.
- **Edit** next to an enhancement name renames it in place.
- **Search** — filter enhancements, filter scenarios inside one enhancement, or filter documents
  within the active tab.

## Database

The tool stores everything in MongoDB. Put the connection string in `.env` in this folder:

```
# Atlas:        mongodb+srv://user:pass@cluster.mongodb.net
# Local server: mongodb://127.0.0.1:27017
MONGODB_URI=mongodb+srv://user:pass@cluster.mongodb.net

# optional — defaults to the database named in the URI, else cf_test_scenarios
MONGODB_DB=cf_test_scenarios
```

Two collections:

| Collection | Holds |
|---|---|
| `enhancements` | One per enhancement, with its scenarios embedded — they are always read and written together |
| `documents` | One per uploaded write-up, with its rendered HTML |

The uploaded files themselves (the .docx/.pdf and the screenshots pulled out of them) stay on
disk under `server/uploads/`; only their metadata and rendered text live in the database.

### Coming from the old JSON store

Earlier versions kept everything in `server/data/db.json`. To move that into MongoDB, set
`MONGODB_URI` and run once:

```
node server/migrate.js
```

It refuses to run if the collections already hold data — pass `--replace` to overwrite them.
`db.json` is left untouched, so keep it until you are happy the migration worked.

## AI key for the Test Cases button (OpenAI or Claude)

Everything else works without a key. To generate test cases, copy `.env.sample` to `.env` in this
folder, put in **one** key, and restart the server:

```
# OpenAI / ChatGPT — https://platform.openai.com/api-keys
OPENAI_API_KEY=sk-your-key-here
OPENAI_MODEL=gpt-4o           # optional; any chat model your account can use

# or Anthropic / Claude — https://console.anthropic.com/settings/keys
ANTHROPIC_API_KEY=sk-ant-your-key-here
```

Whichever key is present is used. If both are set OpenAI wins; `AI_PROVIDER=openai` or
`AI_PROVIDER=anthropic` forces one. `GET /api/ai-status` reports the active provider and model,
and each generated panel shows the model that produced it. Results are cached on the
scenario row in MongoDB, so re-opening a panel costs nothing.

A key set as a Windows environment variable also works and takes priority over `.env`.
`.env` holds a live secret — do not commit or share it.

## Accepted file formats

`.csv`, `.xlsx`, `.xls`, `.xlsm`, `.txt` — up to 10 MB.

The parser looks for a header row containing a scenario column named any of:
`Test Scenario`, `Test Scenarios`, `Scenario`, `Test Case`, `Test Description`, `Description`, `Test`.
An `S.No` / `Sr No` / `Serial No` / `#` / `No` column is recognised and re-numbered.
Every other named column (Expected Result, Priority, Status, Steps, …) is kept and shown as an
extra column in the dashboard.

If there is no header row at all, a plain one-scenario-per-line list also works
(with or without `1.` / `-` prefixes).

Blank rows are skipped, and quoted fields containing commas or newlines are handled.
With *Split multi-line cells* ticked (default), a cell holding several numbered lines becomes
several scenario rows.

See [samples/sample-test-scenarios.csv](samples/sample-test-scenarios.csv) for the expected shape.

## Layout

| Path | What it is |
| --- | --- |
| `server/index.js` | Express app, upload endpoints, CSV export |
| `server/parse.js` | CSV (RFC 4180) + XLSX reader, scenario normalisation |
| `server/documents.js` | Document intake: .docx to HTML + screenshot extraction, PDF/image/text |
| `server/testcases.js` | OpenAI / Claude call that turns a scenario into detailed test cases |
| `server/assistant.js` | The chat assistant: answering, drafting, reading write-ups |
| `server/commands.js` | Reading an instruction — delete, rename, mark, generate |
| `server/words.js` | Correcting the words an instruction is made of |
| `server/walkthrough.js` | Turning a screen recording into a step-by-step guide |
| `server/guides.js` | Writing a guide into the tool as a write-up |
| `server/video.js` | Pulling the screens out of a recording |
| `server/pointing.js` | Reading a screenshot to find which thing was meant |
| `server/paths.js` | Where data and uploads live (CF_DATA_DIR, CF_UPLOAD_DIR) |
| `server/store.js` | MongoDB data access, product definitions |
| `server/db.js` | MongoDB connection and indexes |
| `server/migrate.js` | One-off import of the old `db.json` into MongoDB |
| `server/uploads/` | Original uploaded scenario sheets |
| `server/uploads/docs/` | Uploaded documents and the screenshots pulled out of them |
| `public/` | Dashboard UI (plain HTML/CSS/JS — no build step) |

## API

| Method | Route | Purpose |
| --- | --- | --- |
| GET | `/api/products` | Products with enhancement + scenario counts |
| GET | `/api/products/:product/enhancements` | Enhancements of a product |
| POST | `/api/enhancements` | New enhancement + scenario file (multipart: `product`, `name`, `description`, `file`, `splitLines`) |
| GET | `/api/enhancements/:id` | One enhancement with all scenarios |
| POST | `/api/enhancements/:id/scenarios` | Re-upload scenarios (`mode=replace\|append`) |
| POST | `/api/enhancements/:id/scenario` | Add one scenario typed in the tool (JSON: `scenario`, `extra`) |
| DELETE | `/api/enhancements/:id/scenarios/:sno` | Delete one scenario row, renumber the rest |
| POST | `/api/enhancements/:id/scenarios/:sno/testcases` | Test cases for one scenario (JSON: `regenerate`); cached unless `regenerate: true` |
| GET | `/api/documents` | All stored enhancement documents |
| POST | `/api/documents` | Upload a document (multipart: `name`, `description`, `file`) |
| GET | `/api/documents/:id` | One document, with its converted HTML |
| GET | `/api/documents/:id/file` | The original file (`?download=1` to save it) |
| GET | `/api/documents/:id/assets/:name` | A screenshot extracted from a .docx |
| PATCH | `/api/documents/:id` | Rename a document or move it to another product |
| DELETE | `/api/documents/:id` | Delete a document and its files |
| GET | `/api/ai-status` | Whether a key is configured, plus the active provider and model |
| PATCH | `/api/enhancements/:id` | Rename / edit notes |
| DELETE | `/api/enhancements/:id` | Delete an enhancement |
| GET | `/api/enhancements/:id/export.csv` | Download scenarios as CSV |

## Notes

- Storage is MongoDB, so several QA engineers can share one instance. Every write goes
  straight to the database rather than through an in-process copy, so two servers pointed at
  the same database will not overwrite each other.
- There is no authentication; run it on your machine or behind an internal network.

## Tests

```bash
npm test                 # everything, about half a minute
npm test commands        # one suite, by name
npm test typos documents # several
```

Each suite starts the tool on a port of its own against an empty data folder in
the system temp directory, so none of it touches the enhancements, scenarios or
write-ups on this machine. Where the assistant needs a model, a stub in
`tests/stubs/` stands in — the stubs answer from whichever part of the turn a
model would answer from, so a change that sends the wrong thing shows up as the
wrong answer rather than passing quietly. No API key is used and nothing is
spent.

| Suite | What it holds to |
| --- | --- |
| `commandtest.js` | An instruction means the same thing every time it is given |
| `typotest.js` | Typed in a hurry, still understood — and never silently turned into something else |
| `deltest.js` | Say document and a document goes; say scenarios and scenarios go |
| `pointtest.js` | "This one", said while pointing at a screenshot |
| `filetest.js` | Asked to keep a write-up, it keeps the write-up — where you said, and nothing more |
| `sourcetest.js` | The write-up you attached is the one it drafts from |
| `insidetest.js` | Scenarios come from what the write-up says, not from what the tool does with it |
| `persetest.js` | A set each, when a set each is asked for |
| `agenttest.js` | Everything the tool does can be asked for in the chat |
| `guidetest.js` | A recording, written up as a guide with its screenshots |
| `toolstest.js` | Copy and edit under a message (drives a real Chrome; skipped if none) |

Every line in these was got wrong once. Run `npm test` before committing: a
change that breaks one of them is a regression, and the point is to find that
out here rather than in the chat panel a day later.
