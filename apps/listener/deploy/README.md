# Listener on Google Compute Engine (e2-micro)

Deploy **`@app/listener`** without running **`pnpm install`** or **`pnpm build`** on the VM (too heavy for **e2-micro**).  
You **build a Linux bundle on your Mac** (Docker) and **rsync** it to the VM; **PM2** runs the process.

---

## Step-by-step (first deploy)

### 0. Prerequisites

- **GCP**: VM with **Ubuntu**, **external IP**, firewall allows **TCP 22** (SSH) and **TCP 3001** (listener).
- **Mac**: **Docker Desktop** running (for `bundle-for-vm.sh`).
- Know your **SSH login** on the VM (e.g. `ubuntu`, **`atent_office`**, etc.).
- **Supabase**, **Postgres `DATABASE_URL`**, **Upstash Redis**, **`CREDENTIALS_ENCRYPTION_KEY`**, GitHub Pages **`CLIENT_ORIGIN`**.

### 1. One-time: prepare the VM

On the VM (browser SSH or `gcloud compute ssh`), put this repo’s **`apps/listener/deploy/`** folder somewhere (e.g. clone the repo or copy only `deploy/`).

Then:

```bash
cd /path/to/deploy   # folder that contains vm-bootstrap.sh and env.example
chmod +x vm-bootstrap.sh
sudo ./vm-bootstrap.sh
```

If your login user is **not** picked up automatically (rare), pass it explicitly:

```bash
sudo ./vm-bootstrap.sh atent_office
```

This installs **Node 20**, **PM2**, creates **`/opt/atent/listener`**, and seeds **`/etc/atent/listener.env`** when missing.

Edit secrets:

```bash
sudo nano /etc/atent/listener.env
```

Replace every placeholder; **`CLIENT_ORIGIN`** must match your GitHub Pages origin exactly (scheme + host, no trailing slash).

### 2. Mac: create the Linux bundle

From the **monorepo root** on your Mac (**Docker must be running**):

```bash
./apps/listener/deploy/bundle-for-vm.sh
```

Or:

```bash
pnpm --filter @app/listener bundle:vm
```

Output: **`apps/listener/deploy/bundle/`** (gitignored).

### 3. Mac: copy bundle to the VM and restart PM2

Use **`USER@EXTERNAL_IP`** (your real VM user, e.g. **`atent_office@x.x.x.x`**):

```bash
./apps/listener/deploy/sync-to-vm.sh atent_office@YOUR_EXTERNAL_IP
```

The script uses **`~/.ssh/google_compute_engine`** automatically if it exists (same key as **`gcloud compute ssh`**).  
If rsync still fails with **`Permission denied (publickey)`**, run once on your Mac:

```bash
gcloud compute ssh YOUR_INSTANCE_NAME --zone=YOUR_ZONE --project=YOUR_PROJECT
```

accept the host key, then retry **`sync-to-vm.sh`**.

Override identity if needed:

```bash
export GCP_SSH_IDENTITY=~/.ssh/id_ed25519
./apps/listener/deploy/sync-to-vm.sh atent_office@YOUR_EXTERNAL_IP
```

### 4. VM: PM2 on boot (once)

SSH as your app user and run:

```bash
pm2 startup
```

Run the **single `sudo env PATH=...`** line it prints (one-time).

### 5. Verify

From your laptop (if firewall allows **3001**):

```bash
curl -sS "http://YOUR_EXTERNAL_IP:3001/api/health"
```

Expect **`{"ok":true}`**.

On the VM:

```bash
curl -sS http://127.0.0.1:3001/api/health
pm2 logs atent-listener
```

---

## Later deploys (updates only)

On the Mac:

```bash
./apps/listener/deploy/bundle-for-vm.sh
./apps/listener/deploy/sync-to-vm.sh YOUR_USER@YOUR_EXTERNAL_IP
```

No need to re-run **`vm-bootstrap.sh`** unless you rebuild the VM.

---

## Architecture

| Piece | Where |
|--------|--------|
| Web client | GitHub Pages — build with **`VITE_LISTENER_API_URL`** = listener base URL |
| Listener | GCP VM — **`/opt/atent/listener`** (rsync’d bundle) |
| Process manager | **PM2** (`ecosystem.config.cjs` in bundle; reads **`/etc/atent/listener.env`**) |
| Auth | Supabase JWT |
| DB | Postgres **`DATABASE_URL`** |
| Redis | Upstash REST |

---

## Why Docker on the Mac?

**`sharp`** and **Prisma** binaries are **Linux-specific** on GCP.  
**`bundle-for-vm.sh`** builds inside **`linux/amd64` Docker** by default.

Quick macOS-only bundle (never rsync to Linux):

```bash
MAC_BUNDLE_ONLY=1 ./apps/listener/deploy/bundle-for-vm.sh
```

---

## GitHub Pages client

```bash
VITE_LISTENER_API_URL=http://YOUR_EXTERNAL_IP:3001 pnpm exec turbo run build --filter=@app/client
```

Use **`https://`** if you terminate TLS in front of the VM.

---

## Memory (e2-micro)

**1 GiB** is tight; PM2 sets **`max_memory_restart`** ~850M. Add **swap** or a larger machine type if the process OOMs.

---

## Files in this directory

| File | Role |
|------|------|
| **`bundle-for-vm.sh`** | Mac: Docker **linux/amd64** build → **`deploy/bundle/`** |
| **`sync-to-vm.sh`** | Mac: **rsync** + **PM2 reload** (uses **`google_compute_engine`** key if present) |
| **`vm-bootstrap.sh`** | VM once: Node, PM2, dirs, **`/etc/atent/listener.env`** template |
| **`ecosystem.config.cjs`** | Shipped inside bundle; loads **`/etc/atent/listener.env`** |
| **`env.example`** | Template for **`/etc/atent/listener.env`** |

---

You may see a **Prisma CLI bin** warning during **`pnpm deploy`**; runtime uses the generated client in the bundle — safe to ignore.
