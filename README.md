# 📈 TradeLog — Trading Journal

A professional trading journal built with React. Track trades, analyze performance, and import directly from Fidelity or Robinhood CSV exports.

## ✨ Features

- **Dashboard** — Equity curve, P&L stats, win rate, profit factor
- **Trade Log** — Filterable/sortable table with search
- **Analytics** — Performance by setup, ticker, best/worst trades
- **Psychology** — Emotion tracker correlated with P&L
- **P&L Calendar** — Daily heatmap of profits and losses
- **CSV Import** — Auto-detect and import Fidelity & Robinhood exports
  - Drag & drop or paste CSV
  - FIFO trade matching (buy/sell pairs)
  - Duplicate detection
  - Preview & select before import

## 🚀 Getting Started

### Prerequisites
- Node.js 18+
- npm or yarn

### Installation

```bash
# Clone the repo
git clone https://github.com/itsurday/trading-journal.git
cd trading-journal

# Install dependencies
npm install

# Start dev server
npm start
```

Opens at [http://localhost:3000](http://localhost:3000)

### Build for Production

```bash
npm run build
```

### Deploy to Vercel (free)

```bash
npm install -g vercel
vercel
```

## 📁 Project Structure

```
trading-journal/
├── public/
│   └── index.html
├── src/
│   ├── App.jsx              # App root
│   ├── index.js             # React entry point
│   └── TradingJournal.jsx   # Full journal component (all-in-one)
├── sample-data/
│   ├── fidelity-sample.csv  # Test Fidelity CSV import
│   └── robinhood-sample.csv # Test Robinhood CSV import
├── .gitignore
├── package.json
└── README.md
```

## 📊 CSV Import Formats

### Fidelity
Export from: **Accounts & Trade → Activity & Orders → History → Download CSV**

Expected headers:
```
Run Date, Account, Action, Symbol, Description, Type, Quantity, Price ($), Commission ($), Fees ($), Amount ($)
```

Supported actions: `YOU BOUGHT`, `YOU SOLD`, `YOU SOLD SHORT`, `YOU BOUGHT TO COVER`

### Robinhood
Export from: **Account → Statements & History → History → Export CSV**

Expected headers:
```
symbol, date, order type, side, fees, quantity, average price
```

## 🗺️ Roadmap

| Phase | Status | Description |
|-------|--------|-------------|
| Phase 1 | ✅ Done | Core journal UI — manual trade logging |
| Phase 1b | ✅ Done | CSV import — Fidelity & Robinhood |
| Phase 2 | 🔜 Next | Backend — FastAPI + Supabase (persistent storage) |
| Phase 3 | 📋 Planned | Auto-sync — Robinhood API + Fidelity OAuth |
| Phase 4 | 📋 Planned | Mobile app — React Native |

## 🛠️ Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 18 |
| Charts | Pure SVG (no library) |
| State | React useState / useMemo |
| Styling | Inline styles + CSS-in-JS |
| Backend (Phase 2) | FastAPI + Python |
| Database (Phase 2) | Supabase (PostgreSQL) |
| Hosting | Vercel (frontend) + Render (backend) |

## 📝 License

MIT
