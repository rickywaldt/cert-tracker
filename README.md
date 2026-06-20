# ITQ Certification Tracker

A self-hosted web app that scrapes all Credly badges earned by ITQ'ers and presents them in a searchable, filterable overview.

## What it does

- Scrapes the [ITQ team page](https://itq.eu/meet-our-team/) to discover all employees and their office/country
- Resolves each person's Credly profile and fetches all their public badges
- Stores everything in PostgreSQL
- Serves a plain HTML/JS frontend with filters for country, issuer, cert status, and person search
- Caches badge images server-side to avoid hotlinking Credly
- Protected by HTTP Basic Auth (all info is publicly available)

## Architecture

    ┌─────────────┐     on demand / weekly     ┌─────────────┐     ┌──────────────┐
    │   Scraper   │ ─────────────────────────► │  PostgreSQL  │ ◄── │     API      │
    │  (Node.js)  │                            │             │     │  (Express)   │
    └─────────────┘                            └─────────────┘     └──────┬───────┘
                                                                          │
                                                                   ┌──────▼───────┐
                                                                   │   Frontend   │
                                                                   │   (nginx)    │
                                                                   └──────────────┘

## Prerequisites

- Docker and Docker Compose
- (Optional) [DevPod](https://devpod.sh/) + [mise](https://mise.jdx.dev/) for development inside a devcontainer

## Quick start

### 1. Clone the repo

    git clone https://github.com/rickywaldt/cert-tracker.git
    cd cert-tracker

### 2. Start the stack

    docker compose up -d --build

This starts three services:

| Service    | URL                   |
|------------|-----------------------|
| Frontend   | <http://localhost:8080> |
| API        | <http://localhost:3000> |
| PostgreSQL | localhost:5432        |

### 3. Run the scraper

    docker compose --profile scraper up --build scraper

This scrapes itq.eu and Credly, populates the database, and exits. On first run expect 5–10 minutes (242 people, ~3000 badges). Watch the logs to follow progress.

### 4. Open the app

Navigate to <http://localhost:8080> and log in.

> **Running inside DevPod?** Forward the port first:
>
>     devpod ssh cert-tracker -- -L 8080:localhost:8080

### 5. Subsequent runs

The database is **persistent** — data survives container restarts. You only need to re-run the scraper when you want fresh data.

    # Stop and restart without losing data
    docker compose down
    docker compose up -d

    # Wipe everything including the database and start completely fresh
    docker compose down -v
    docker compose up -d --build
    docker compose --profile scraper up --build scraper

## Development with DevPod

Open the repo in DevPod to get a fully configured devcontainer with Node 22 pre-installed via mise:

    devpod up .

The post-create hook runs `scripts/setup` which installs all npm dependencies for both `scraper/` and `api/`. Docker-in-Docker is included so you can run `docker compose` commands from inside the devcontainer.

## Filters

| Filter  | Description |
|---------|-------------|
| Country | Netherlands, Germany, Belgium, France, Luxembourg, Sweden, Denmark |
| Issuer  | Red Hat, Broadcom, The Linux Foundation, Microsoft, GitHub, etc. |
| Status  | All / Active / Expired / Expiring within 3 months |
| Person  | Autocomplete — type a name to filter badges by individual |
| Search  | Keyword search across badge name, issuer, and description |

## Project structure

    cert-tracker/
    ├── scraper/                   # One-shot Node.js scraper
    │   ├── Dockerfile
    │   ├── package.json
    │   └── src/
    │       ├── index.js           # Entry point — orchestrates the full scrape
    │       ├── itq.js             # Scrapes itq.eu/meet-our-team via FacetWP API
    │       ├── credly.js          # Resolves Credly slugs and fetches badge data
    │       └── db.js              # PostgreSQL schema and upsert helpers
    ├── api/                       # Express REST API
    │   ├── Dockerfile
    │   ├── package.json
    │   └── src/
    │       └── index.js           # /api/badges, /api/people, /api/meta, /api/image
    ├── frontend/                  # Static site served by nginx
    │   ├── Dockerfile
    │   ├── nginx.conf
    │   ├── index.html
    │   ├── style.css
    │   └── app.js
    ├── scripts/
    │   └── setup                  # DevPod post-create: mise trust + npm install
    ├── .devcontainer/
    │   ├── Dockerfile
    │   └── devcontainer.json
    ├── docker-compose.yaml
    └── mise.toml

## How scraping works

### ITQ team page (itq.eu)

The ITQ team page is powered by [FacetWP](https://facetwp.com/), a WordPress filtering plugin. Rather than scraping rendered HTML (which requires a headless browser), the scraper calls the FacetWP API directly:

    POST https://itq.eu/meet-our-team/
    Content-Type: application/json

    {
      "action": "facetwp_refresh",
      "data": {
        "facets": { "offices": ["6011"], "departments": [], "employees_load_more": [] },
        "template": "wp",
        "paged": 1
      }
    }

The response contains rendered HTML for the matching employee cards. The scraper iterates over each of the nine office locations (Netherlands Beverwijk, Netherlands Amersfoort, Germany, Belgium, France, Luxembourg, Sweden, Denmark) and fetches all pages for each office separately. This is the only way to associate each person with their office and country, since that metadata is not embedded in the card HTML — it only exists as a filter dimension in the FacetWP response.

Names and job titles are extracted from the HTML using regex on the `employee-card__name` and `employee-card__function` CSS classes. The office label is mapped to a normalised country name using a lookup table in `itq.js`.

### Credly profiles

Credly does not offer a public user search API. Instead, the scraper derives a URL slug from each person's name (e.g. `Ricky Waldt` → `ricky-waldt`) and sends a HEAD request to:

    HEAD https://www.credly.com/users/<slug>

HTTP 200 means the profile exists; HTTP 404 means it does not. A no-hyphen variant (e.g. `stijnvermoesen`) is also tried as a fallback.

Once a valid slug is confirmed, all badges are fetched via the Credly badges API:

    GET https://www.credly.com/users/<slug>/badges?page=1&page_size=48&sort=most_popular
    Accept: application/json

The response includes badge name, issuer organisation, issue date, expiry date, badge image URL, and a link back to the Credly badge page. Multiple pages are fetched in parallel if a person has more than 48 badges. The issuer name (e.g. "Red Hat", "Broadcom", "The Linux Foundation") is read from `badge.issuer.entities[].entity.name` where `primary === true`.

## Known limitation: missing Credly profiles

Some people cannot be found automatically because their Credly slug uses a **disambiguation suffix** — an 8-character hex string Credly appends when multiple accounts share the same base slug. For example:

| Person           | Derived slug       | Actual slug                        |
|------------------|--------------------|------------------------------------|
| Davy van de Laar | davy-van-de-laar   | davy-van-de-laar.906902d4          |
| Frank Sengewald  | frank-sengewald    | frank-sengewald.76d85ba8           |
| Andreas Diemer   | andreas-diemer     | andreas-diemer.ae4216a6            |

Since `HEAD /users/davy-van-de-laar` returns 404, the scraper skips this person entirely. There is no public API to discover the suffix — Credly's user search requires authentication.

### How to fix a missing person

1. Go to <https://www.credly.com> and search for the person's name manually, or ask them directly for their profile URL
2. Copy the slug from the URL — for `https://www.credly.com/users/davy-van-de-laar.906902d4` the slug is `davy-van-de-laar.906902d4`
3. Open `scraper/src/credly.js` and add an entry to the `SLUG_OVERRIDES` map at the top of the file:

       const SLUG_OVERRIDES = {
         'davy van de laar':  ['davy-van-de-laar.906902d4'],
         'frank sengewald':   ['frank-sengewald.76d85ba8'],
         'andreas diemer':    ['andreas-diemer.ae4216a6'],
         'ricky waldt':       ['ricky-waldt', 'ricky-waldt.f87f9886'],
         'stijn vermoesen':   ['stijnvermoesen'],
         // Add new entries here — key is full name in lowercase:
         'new person name':   ['new-person-slug.xxxxxxxx'],
       };

4. Commit the change and re-run the scraper (no need to wipe the database — upserts are safe):

       docker compose --profile scraper up --build scraper

### People with multiple Credly accounts

Some people have two separate Credly accounts (e.g. a personal and a work account). List both slugs in the array — the scraper fetches badges from all of them and merges them under one person record:

    'ricky waldt': ['ricky-waldt', 'ricky-waldt.f87f9886'],

## API endpoints

All endpoints require HTTP Basic Auth.

| Method | Endpoint           | Description |
|--------|--------------------|-------------|
| GET    | /api/badges        | Paginated badge list. Query params: `country`, `issuer`, `status`, `q`, `person_id`, `page`, `per_page` |
| GET    | /api/people        | All people with at least one badge. Query param: `country` |
| GET    | /api/meta          | Distinct filter values: countries, issuers, offices |
| GET    | /api/image?url=    | Server-side image proxy for Credly badge images (24h cache) |
| GET    | /api/scrape-status | Last 5 scrape run records |

## Environment variables

| Variable              | Service        | Description                           |
|-----------------------|----------------|---------------------------------------|
| DATABASE_URL          | api, scraper   | PostgreSQL connection string          |
| BASIC_AUTH_USER       | api            | Username for HTTP Basic Auth          |
| BASIC_AUTH_PASSWORD   | api            | Password for HTTP Basic Auth          |
| PORT                  | api            | Port to listen on (default: 3000)     |
| RUN_ONCE              | scraper        | Set to "true" to exit after one run   |

The `docker-compose.yaml` provides hardcoded development values for all of these. For production deployments, inject secrets via your preferred secrets manager.

## TODO

- CSV export
- Badge expiry notification
- Leaderboard

## License

MIT
