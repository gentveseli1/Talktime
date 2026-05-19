# Proxmox Deployment Plan

This document describes how the distributed chat application is deployed on
**Proxmox VE**, the target infrastructure for the thesis demonstration. The
goal is to show that the same logical architecture used for local development
maps cleanly to a real virtualized environment running across multiple
isolated nodes.

## 1. Why Docker Compose for local development

During development we use a single `docker-compose.yml` file that boots
Postgres, Redis, three backend Node.js nodes, and an Nginx load balancer on
the developer's laptop. The reasons:

- **Reproducibility.** One command (`docker compose up --build`) gives every
  developer (and every CI run) the exact same versions of Postgres, Redis,
  Nginx, and Node.
- **Fast iteration.** Source code is bind-mounted, so changes to the backend
  are picked up immediately by `tsx watch`.
- **Tight feedback loop on the distributed behavior.** The full topology
  (3 backend nodes behind Nginx, sharing Postgres and Redis) is reproduced
  on a single machine, so the load-balancing and failover stories can be
  exercised long before any real VM is provisioned.
- **No infrastructure cost.** New contributors do not need access to the
  Proxmox cluster to develop or run tests.

Docker Compose is therefore a **development convenience**, not the production
deployment target. The thesis demonstration runs on Proxmox.

## 2. How the same architecture maps to Proxmox

The mental model is one-to-one — every Compose service becomes a Proxmox
guest (either an LXC container or a small VM), and the Docker bridge network
is replaced by a dedicated Proxmox private bridge.

| Compose service          | Proxmox guest      | Purpose                                  |
|--------------------------|--------------------|------------------------------------------|
| `nginx`                  | `chat-lb`          | Public entry point, load balancer        |
| `backend-1`              | `chat-node-1`      | Stateless Node.js + Socket.IO instance   |
| `backend-2`              | `chat-node-2`      | Stateless Node.js + Socket.IO instance   |
| `backend-3`              | `chat-node-3`      | Stateless Node.js + Socket.IO instance   |
| `postgres` + `redis`     | `chat-data`        | Shared state (DB + pub/sub broker)       |
| `frontend` (optional)    | `chat-frontend`    | Static React build served by Nginx       |

Two properties carry over directly:

- The backend nodes remain **stateless** — every node trusts the same
  `JWT_SECRET`, reads/writes the same Postgres, and joins the same Socket.IO
  Redis adapter channel. A request can land on any node.
- The Socket.IO Redis adapter is what turns three independent processes into
  one logical messaging plane. The need for Redis is identical in Docker
  Compose and on Proxmox.

## 3. Recommended VM/LXC layout

**LXC is preferred for all six guests.** Node.js, Postgres, and Redis all run
cleanly in an unprivileged LXC, the memory footprint is small, and snapshots
+ migration are fast. Use VMs only if your Proxmox storage backend or
networking policy requires it.

| Guest             | Type | vCPU | RAM    | Disk  | OS template          |
|-------------------|------|------|--------|-------|----------------------|
| `chat-lb`         | LXC  | 1    | 512 MB | 4 GB  | Debian 12            |
| `chat-node-1`     | LXC  | 2    | 1 GB   | 8 GB  | Debian 12 + Node 20  |
| `chat-node-2`     | LXC  | 2    | 1 GB   | 8 GB  | Debian 12 + Node 20  |
| `chat-node-3`     | LXC  | 2    | 1 GB   | 8 GB  | Debian 12 + Node 20  |
| `chat-data`       | LXC  | 2    | 2 GB   | 20 GB | Debian 12            |
| `chat-frontend`   | LXC  | 1    | 256 MB | 2 GB  | Debian 12 + Nginx    |

Notes:

- `chat-frontend` is **optional**. The React app is a static bundle (`npm run
  build` in `frontend/`), and it can be served either from its own LXC (clean
  separation) or from the same Nginx instance on `chat-lb` (one less guest to
  manage). For the thesis demo the second option is usually simpler.
- To keep the demo realistic, run `chat-node-1/2/3` on **different physical
  Proxmox hosts** if the cluster has more than one node. That way pulling the
  network cable on one host kills only one backend, demonstrating real
  hardware-level failover, not just process-level.
- `chat-data` is a single point of failure in this layout. Making Postgres
  and Redis themselves HA (Patroni, Redis Sentinel) is **out of scope for
  this thesis** — the thesis claims failover at the *application tier*, not
  at the *data tier*. The scope is documented honestly in the report.

## 4. Example private network / IP plan

Create a dedicated private bridge (e.g. `vmbr1`) on the Proxmox host(s) so
the backend nodes and the database are not reachable from the outside
network. Only `chat-lb` (and optionally `chat-frontend`) bridges to `vmbr0`
(the public/LAN bridge).

| Guest             | Bridge       | IP             | Reachable from        |
|-------------------|--------------|----------------|-----------------------|
| `chat-lb`         | vmbr0, vmbr1 | LAN + 10.10.10.10/24 | Public + private |
| `chat-frontend`*  | vmbr0        | LAN IP         | Public (optional)     |
| `chat-node-1`     | vmbr1        | 10.10.10.11/24 | Private only          |
| `chat-node-2`     | vmbr1        | 10.10.10.12/24 | Private only          |
| `chat-node-3`     | vmbr1        | 10.10.10.13/24 | Private only          |
| `chat-data`       | vmbr1        | 10.10.10.20/24 | Private only          |

Firewall (Proxmox `pve-firewall` or `ufw` inside each guest):

- `chat-lb` accepts `:80`/`:443` from the public LAN; only it can reach the
  backends on `:3000`.
- `chat-node-1/2/3` accept `:3000` only from `chat-lb` (10.10.10.10).
- `chat-data` accepts `:5432` and `:6379` only from `chat-node-1/2/3`.

This mirrors a realistic production posture: the database and backends have
no public IPs, the load balancer is the only ingress.

## 5. Environment variables for each backend node

Each backend LXC ships an `/etc/chat-backend.env` file (loaded by a
systemd unit — see step 6). The only value that differs between nodes is
`NODE_ID`.

`chat-node-1` (`/etc/chat-backend.env`):

```ini
NODE_ID=node-1
PORT=3000
DATABASE_URL=postgresql://chat:<password>@10.10.10.20:5432/chat
REDIS_URL=redis://10.10.10.20:6379
JWT_SECRET=<long-random-string-IDENTICAL-on-all-three-nodes>
CORS_ORIGIN=https://chat.example.edu
LOG_LEVEL=info
```

`chat-node-2`: same as above but `NODE_ID=node-2`.
`chat-node-3`: same as above but `NODE_ID=node-3`.

`chat-lb` (`/etc/nginx/sites-enabled/chat.conf`): same shape as
`nginx/nginx.conf` in this repo, with the upstream block replaced by IPs:

```nginx
upstream chat_backend {
  ip_hash;
  server 10.10.10.11:3000 max_fails=3 fail_timeout=10s;
  server 10.10.10.12:3000 max_fails=3 fail_timeout=10s;
  server 10.10.10.13:3000 max_fails=3 fail_timeout=10s;
}
```

`chat-data` (Postgres `pg_hba.conf` + `redis.conf`): allow connections from
the `10.10.10.0/24` private subnet only.

> Treat `JWT_SECRET` and the Postgres password as secrets — generate with
> `openssl rand -hex 32` and store them in Proxmox's encrypted secrets store
> (or at minimum a root-only file with `chmod 600`).

## 6. Deployment steps (high level)

1. **Provision the bridge.** Create `vmbr1` on each Proxmox host as a host-
   local private bridge with no uplink.
2. **Create the LXC templates.** Pull `debian-12-standard` from the Proxmox
   template store. Build a "node-base" template with Node.js 20 + git
   pre-installed to speed up node provisioning.
3. **Provision `chat-data`.** Install Postgres 16 + Redis 7 from the Debian
   repos, create the `chat` user and database, lock down `pg_hba.conf` /
   `redis.conf` to the private subnet.
4. **Provision `chat-node-1/2/3`.** Clone the repo, `cd backend && npm ci &&
   npx prisma generate && npm run build`. Drop `/etc/chat-backend.env` (see
   §5) and a systemd unit (`/etc/systemd/system/chat-backend.service`) that
   runs `node dist/index.js`.
5. **Run the migration once.** From any one backend node:
   `DATABASE_URL=... npx prisma migrate deploy`.
6. **Provision `chat-lb`.** Install Nginx, deploy the config from §5,
   `systemctl enable --now nginx`.
7. **(Optional) Provision `chat-frontend`.** `cd frontend && npm ci && npm
   run build`, copy `dist/` to `/var/www/chat-frontend`, configure Nginx to
   serve it.
8. **Smoke test.** `curl http://<chat-lb>/health` from outside, watch
   `nodeId` confirm a backend answered.
9. **TLS (recommended even for a thesis demo).** Add a Let's Encrypt
   certificate on `chat-lb` with `certbot --nginx`.

A systemd unit example for the backend nodes:

```ini
# /etc/systemd/system/chat-backend.service
[Unit]
Description=Chat backend (node-1)
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/chat-app/backend
EnvironmentFile=/etc/chat-backend.env
ExecStart=/usr/bin/node dist/index.js
Restart=on-failure
User=chat

[Install]
WantedBy=multi-user.target
```

## 7. How failover is tested on Proxmox

Three escalating scenarios, all visible from a browser pointed at
`https://<chat-lb>/` and from `curl <chat-lb>/health`:

1. **Process kill.** `systemctl stop chat-backend` on `chat-node-2`. Nginx's
   `proxy_next_upstream` retries the next node; clients pinned to node-2 are
   re-pinned on their next request. **Expected:** zero user-visible errors
   for clients on node-1 / node-3, a one-request reconnect for clients
   previously on node-2.
2. **VM/LXC shutdown.** From the Proxmox UI, *Stop* the `chat-node-2`
   container. Same outcome as scenario 1 — proves the failover does not
   depend on the OS shutting down cleanly.
3. **Host pull.** If the three backend LXCs are spread across multiple
   physical Proxmox hosts (recommended), simulate a host failure by
   pulling its network cable or `qm stop`-ing all guests on that host.
   **Expected:** the remaining two nodes continue to serve, demonstrating
   true cross-host failover.

For each scenario, record:

- The `nodeId` returned by `/health` before and after.
- Whether already-connected WebSocket clients had to reconnect (they will,
  if they were pinned to the failed node), and how quickly they recovered.
- Whether any 5xx response was observed by the load tester (`hey`, `wrk`,
  or a small Node script). Goal: zero sustained 5xx.

## 8. Thesis explanation

In the thesis report, present Proxmox as the bridge between *theory* (a
distributed system in the abstract) and *practice* (real virtualized
hardware). The narrative arc:

1. **Motivation.** A modern chat application must survive single-node
   failures and scale horizontally. We test these properties by physically
   separating components onto independent guests.
2. **Architecture.** Six guests, two networks (public + private), three
   stateless backends behind one load balancer, one shared data plane.
   Include the diagram from §2 / §3.
3. **Stateless backends.** The reason three identical backend nodes can
   serve the same client interchangeably is that all session state lives
   either in the JWT (issued and verifiable from `JWT_SECRET`, no server-
   side session store) or in Postgres / Redis. This is the canonical
   "twelve-factor" property and is the *enabling condition* for horizontal
   scaling.
4. **Coordination through Redis.** Show that without the Socket.IO Redis
   adapter, a message produced on node-1 would never reach a recipient
   connected to node-3. The adapter is the smallest possible cross-node
   coordination primitive and is justifiable on those grounds.
5. **Failover.** Describe the three test scenarios from §7 with timing
   data (e.g. "after `systemctl stop`, the next `/health` request returned
   in 38 ms from a surviving node").
6. **Honest scope.** State plainly that the data plane (`chat-data`) is a
   single point of failure in v1, and outline what would be needed to
   close it (Patroni for Postgres, Sentinel for Redis). This honesty is
   itself a thesis-quality stance.
7. **Reproducibility.** Note that the same architecture runs unchanged
   under `docker compose up` for developer machines, which is what
   permitted the test suite and the failover scenarios to be developed
   iteratively before any Proxmox guest existed.

The thesis defence can lean on a live demo: open the chat in a browser,
show `/health` returning a node id, then `qm stop` that node from the
Proxmox UI and watch the next `/health` come back from a surviving node
without a user-visible error. That single moment is the entire
distributed-systems claim of the project, made concrete.
