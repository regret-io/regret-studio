# Regret Studio

Web UI for [Regret](https://github.com/regret-io/regret) — the distributed system correctness testing platform.

## Features

- Manage hypothesis templates, generators, and adapters
- View real-time run progress with operation details
- Chaos scenario management (pod kill, network delay, rolling updates)
- Read-only mode with admin login for write operations
- Event timeline with expandable batch and checkpoint details

## Docker

```bash
docker run -e API_URL=http://regret-pilot:8080 -p 3000:3000 regretio/studio:latest
```

## Development

```bash
npm install
NEXT_PUBLIC_API_URL=http://localhost:8080 npm run dev
```
