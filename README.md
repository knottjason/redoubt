# Redoubt

One screen for a home network: Suricata alerts with a decision to make, and every machine's bandwidth, connections and "have we seen this before?".

Early days. Overview, Alerts, Machines and History work; Rules lists what fired. Decisions (allow, silence, request a block) are **recorded only**; nothing is changed in Suricata or on a firewall yet.

TypeScript, Hono, React, react-query, Mantine, TanStack Table. Reads ClickHouse (read-only), keeps decisions in SQLite.

## Run it

    cp .env.example .env    # then edit
    npm ci && npm run build && npm start

Put it behind a reverse proxy that signs people in and sets `Remote-User`, and list that proxy in `TRUSTED_PROXIES`. Everything else is refused.

Apache 2.0.
