# WealthTrack

A self-hosted family net worth tracker with dead-simple data entry and beautiful visualizations. No cloud, no subscriptions — your data stays on your machine.

![Docker](https://img.shields.io/badge/docker-ready-blue)
![License](https://img.shields.io/github/license/sasa-fajkovic/family-wealth-tracker)

## Preview

| Overview (light) | Projections (dark) |
|---|---|
| ![WealthTrack overview in light theme](docs/demo/overview-light.gif) | ![WealthTrack projections in dark theme](docs/demo/projections-dark.gif) |

| Income (light) | Monthly update and admin (dark) |
|---|---|
| ![Income dashboard in light theme](docs/demo/cash-inflow-light.gif) | ![Monthly update and admin screens in dark theme](docs/demo/monthly-admin-dark.gif) |

## Features

- 📊 Track net worth across categories (stocks, real estate, crypto, cash, liabilities, …)
- 📈 Interactive charts — area, line, bar, and pie
- 🔮 Projections page with configurable growth rates and milestones
- 💸 Income tracking
- 🌙 Dark / light theme
- 🗃️ Data stored in plain YAML + CSV files — easy to back up and edit
- 🐳 Single Docker image, single port

## Quick Start (Docker)

```bash
# Pull and run
docker run -d \
  --name wealthtrack \
  -p 8080:8080 \
  -v $(pwd)/data:/data \
  ghcr.io/sasa-fajkovic/family-wealth-tracker:latest

# Open in browser
open http://localhost:8080
```

Or with Docker Compose:

```yaml
# docker-compose.yml
services:
  wealthtrack:
    image: ghcr.io/sasa-fajkovic/family-wealth-tracker:latest
    ports:
      - "8080:8080"
    volumes:
      - ./data:/data
    restart: unless-stopped
```

```bash
docker compose up -d
```

Data is persisted in `./data/` on the host (created automatically on first run).

### Permissions

The container runs the app as the non-root `node` user (uid 1000). On startup, the entrypoint runs briefly as root to `chown` `/data` to that user, so most bind-mount setups work out of the box.

If you edit files inside the data volume manually (e.g. via SSH as root), they may end up owned by a uid the container can't read. If startup fails with `EACCES`, fix the ownership on the host:

```bash
chown -R 1000:1000 /path/to/data
```

## Development

### Prerequisites

- Node.js 24 recommended (supported: 20.19+ on Node 20, or 22.12+)
- npm

### Install dependencies

```bash
make install
```

### Start dev servers

```bash
make dev
```

This starts the Hono API server on **:3000** and the Vite dev server on **:5173**.  
Open [http://localhost:5173](http://localhost:5173).

### Verify changes locally

```bash
npm --prefix server test
npm --prefix server run typecheck
npm --prefix server run lint
npm --prefix web run typecheck
npm --prefix web run lint
npm --prefix web run test:harness
npm --prefix web run test:e2e
make build
```

The browser suite creates disposable local data and starts its own production
server. It performs writes: never point it at your real data. To test an
already-running local server with disposable data, set `BASE_URL` to its loopback
origin and `E2E_ALLOW_SYNTHETIC_DATA=1`. Remote targets are rejected.

### Build for production

```bash
make build
```

### Build Docker image locally

```bash
make docker-build
```

### Run Docker image locally

```bash
make docker-run
```

Open [http://localhost:8080](http://localhost:8080).

## Makefile reference

| Target | Description |
|---|---|
| `make install` | Install npm dependencies (server + web) |
| `make dev` | Start server and web in watch/dev mode |
| `make build` | TypeScript-compile server + Vite-build web |
| `make docker-build` | Build Docker image tagged `wealthtrack:latest` |
| `make docker-run` | Run the Docker image on port 8080 |
| `make docker-stop` | Stop and remove the running container |
| `make clean` | Remove build artefacts |

## Data directory

All persistent data lives in `/data` inside the container (mounted as a Docker volume):

| File | Description |
|---|---|
| `database.yaml` | Categories, people, assets, growth assumptions and visibility windows |
| `datapoints.csv` | Granular data point entries |
| `logs/` | Audit log of mutations |
| `snapshots/` | Prior file versions retained before writes |
| `database.yaml.transaction.json` | Temporary durable journal for paired YAML/CSV updates; recovered before serving requests |

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `8080` | HTTP port |
| `DATA_FILE` | `/data/database.yaml` | Path to the YAML database |
| `DATA_POINTS_FILE` | `/data/datapoints.csv` | Path to the CSV data points file |
| `LOGS_DIR` | `/data/logs` | Directory for audit logs |
| `WEB_DIST` | `/app/web/dist` | Path to built web assets |
| `AUDIT_LOG_RETENTION_MONTHS` | `24` | Number of monthly audit log files to retain. `0` disables pruning. |

## Schema

The on-disk format is intentionally human-readable. The single source of truth
for shapes is [`server/src/models/index.ts`](server/src/models/index.ts).

### `database.yaml`

```yaml
categories:
  - id: stocks                       # URL-safe slug, immutable after create
    name: Stocks
    projected_yearly_growth: 0.08    # decimal, e.g. 0.08 = 8% / yr
    color: '#6366f1'
    type: asset                      # 'asset' | 'cash-inflow' | 'liability'
    include_in_current_wealth: true
    include_in_projections: true
persons:
  - id: alice
    name: Alice
assets:
  - id: vanguard-vti
    name: Vanguard VTI
    category_id: stocks
    person_id: alice
    projected_yearly_growth: null    # null = inherit from category; 0 is a valid override
    include_in_current_wealth: null
    include_in_projections: null
    closed_at: null
    notes: ''                        # optional
    created_at: 2024-01-15T10:00:00Z
```

### `datapoints.csv`

`id,asset_id,year_month,value,notes,created_at,updated_at`

- `id` is a UUID v4 (one per data point).
- `year_month` is `YYYY-MM`. The frontend builds it from local-time integer
  parts via `toMonthKey(year, month)` — never `toISOString().slice(0,7)`,
  which UTC-shifts at local midnight for users in non-UTC timezones.
- `value` is the EUR amount as a float. Liability values must be ≤ 0.

### Invariants

- All writes go through `writeFileAtomic` (temp file + POSIX `rename(2)`).
- A single global mutex (`server/src/storage/mutex.ts`) serialises all
  reads and writes — concurrent requests are safe.
- Projection growth uses `(1+r)^(1/12) - 1` (compound monthly), not `r/12`.
- Projections use balances carried forward to the current month and start next
  month. Planned balances are used exactly; intermediate months interpolate
  linearly between known balances. Compound growth resumes after the last plan.
  Future-only assets remain zero until their first planned month.
- `asset.projected_yearly_growth !== null` overrides the category default.
  `0` is a valid override; do not check with truthiness.

## Wealth and projection inclusion

Categories have independent `include_in_current_wealth` and
`include_in_projections` settings. Missing category settings mean `true`.
Assets inherit each setting when its override is missing or `null`; explicit
`true` or `false` overrides the category independently.

| Current wealth | Projections | Behavior |
|---|---|---|
| Yes | Yes | Count recorded balances in wealth; project from the latest balance carried to the current month. |
| Yes | No | Count balances in wealth and historical charts; exclude future projections. |
| No | Yes | Exclude wealth estimates; projection starts at the first strictly future recorded value. |
| No | No | Keep the records without contributing to wealth or projections. |

Current-wealth inclusion classifies all recorded months, so changing it also
recalculates historical wealth charts, allocation and period changes. Inventory,
Monthly Update and data-point history remain accessible. The wealth chart's
planned timeline follows current-wealth membership too.

Projection-only assets ignore every past and current-month estimate. Their
contribution stays zero until the first future point, with no interpolation
before it. No future point means no projected contribution. Later planned values
interpolate normally, then compound growth resumes. Availability metadata keeps
these gaps distinct from an explicitly recorded zero. The same rules apply to
liabilities. Income remains outside net worth and projections, and these settings
do not change income history. Existing files need no migration.

"Future" is relative to the current month. Past and current-month entries on a
projection-only asset remain estimates. Once the holding is actually received,
include it in current wealth or record the received cash as appropriate; avoid
counting both representations. Planned entries do not automatically become
current wealth, and settings are never reclassified as time passes.

## Closing an item

`asset.closed_at` is an optional `YYYY-MM` closing month; missing or `null`
means open. An item stays active through its closing month and disappears from
current wealth breakdowns, active monthly entry and projection assumptions in
the next month. Its raw records and historical series remain available.
Inclusion settings stay unchanged, so closing a paid-off liability preserves its
historical debt instead of removing it from past wealth calculations.

Assets and liabilities require an explicitly recorded zero in the exact closing
month. A carried-forward zero does not qualify. Closing never creates a balance
or deletes observations. Income can close with nonzero final-month income;
selected-period totals and source breakdowns still include that historical income.
No item may have nonzero observations after closure, including planned values.

A future closing month is allowed with a recorded planned zero for assets or
liabilities. Forecasts run through that month and stop afterward. Reopen by
clearing `closed_at` before changing/removing a required closing zero or recording
later activity. These rules apply equally to edits, imports and startup checks.

## Observation and import behavior

Balances carry forward until the next recorded observation. Income does not:
missing months contribute no recorded income. The interface distinguishes missing
observations from explicitly entered zeroes. Income averages use observed months,
including recorded zero and negative amounts, and exclude future planned months.
Monthly completion covers items visible in the selected month, including income;
visibility windows do not remove historical balances from net worth.

Imports must pass validation before application. Preview shows counts and
conflicts without replacing data. Conflicting duplicate observations require
explicit repair. Omitting notes when updating a value preserves existing notes;
an explicit empty string clears them. Startup refuses malformed data rather than
reinitializing it, and reports existing duplicate keys and orphan observations.

Back up `database.yaml` and `datapoints.csv` as a consistent pair while the app is
stopped. Restore them together with the app stopped. An interrupted paired write
is recovered from its transaction journal before requests are served; a damaged
journal or unexpected file edits stop recovery for manual inspection. Preserve
the journal and both files when diagnosing recovery failures.

## License

[MIT](LICENSE)
