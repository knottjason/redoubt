# Redoubt

One screen for a home network: Suricata alerts with a decision to make, and every machine's bandwidth, connections and "have we seen this before?".

Early days. Overview, Alerts, Machines, Rules, History and Plugins work. Blocking is **recorded only**: no plugin does it yet.

TypeScript, Hono, React, react-query, Mantine, TanStack Table. Reads ClickHouse (read-only), keeps decisions in SQLite.

## Run it

    cp .env.example .env    # then edit
    npm ci && npm run build && npm start

Put it behind a reverse proxy that signs people in and sets `Remote-User`, and list that proxy in `TRUSTED_PROXIES`. Everything else is refused.

## Plugins

Redoubt never touches a device itself. A plugin is a small HTTP service, usually its own container, that holds the login for one kind of device and is added on the Plugins page by its address and a shared key. Redoubt never needs the Docker socket.

Redoubt sends each plugin the full list of what should be true (`apply`), keeps trying until it is answered, and compares with what the plugin says is in place (`list`). Requests and replies are signed with the shared key. `src/shared/plugin.ts` is the protocol and `plugins/lib/serve.ts` does everything but the device work; `plugins/suricata` is an example. Any language will do.

The Suricata plugin turns rules on and off and silences a rule for one machine, then reloads rules without restarting the sensor. Start Suricata with `--set threshold-file=/var/lib/suricata/redoubt/threshold.config` and share `/var/lib/suricata` and its control socket with the plugin. It puts back the previous rules if the sensor can't load the new ones.

    docker build -f plugins/suricata/Dockerfile -t redoubt-suricata .

Apache 2.0.
