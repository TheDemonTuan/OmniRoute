# OmniRoute — Production CI/CD (fork riêng)

Triển khai `TheDemonTuan/OmniRoute` lên 1 VPS theo kiến trúc:

```
GitHub Actions → GHCR → VPS → Docker Blue/Green → Caddy → Cloudflare Tunnel
```

Thư mục này là toàn bộ phần hạ tầng **do fork thêm vào**. Không có file nào của
upstream bị sửa, nên việc merge code mới từ upstream gần như không bao giờ conflict.

> **Dựng hạ tầng lần đầu?** → [SETUP.md](./SETUP.md) — checklist theo thứ tự, có ô tick.
> **Ngồi vào một máy dev mới?** → [DEV-MACHINE.md](./DEV-MACHINE.md).
> File này là phần giải thích kiến trúc và tra cứu khi vận hành.
>
> Quản trị riêng qua Telegram: xem [`docs/ops/TELEGRAM_OPS_BOT.md`](../docs/ops/TELEGRAM_OPS_BOT.md).

---

## 1. Ba điểm khác plan gốc — và lý do

Plan `production-cicd-blue-green-caddy-cloudflare.md` giả định một app Node.js
stateless nghe port 3000. OmniRoute không phải vậy, nên có 3 chỗ phải đổi.

### 1.1 SQLite ⇒ không có hot standby

OmniRoute lưu **toàn bộ** state trong `$DATA_DIR/storage.sqlite`. Không có
adapter Postgres/MySQL (`src/lib/db/adapters/` chỉ có better-sqlite3, node:sqlite,
bun:sqlite, sql.js) và không có leader election.

Nếu để blue + green **cùng sống lâu dài** trên một volume như plan gốc, sẽ có
**hai bản** của mọi background job cùng chạy trên một file: auto-backup, cleanup,
quota monitor, circuit breaker. SQLite chịu được multi-process ở tầng khoá file,
nhưng logic ứng dụng thì không.

Vì vậy `deploy.sh` chỉ cho hai slot chồng nhau trong **cửa sổ warm-up +
stabilization (~60–90 giây)**, xong là **stop slot cũ**. Trạng thái ổn định luôn
đúng một writer.

**Đánh đổi, và nói thẳng:** không còn hot standby để tự failover. Lưới an toàn
còn lại là — Caddy không switch cho tới khi bản mới chứng minh healthy, và
switch ngược lại ngay nếu bản mới hỏng trong lúc slot cũ vẫn đang chạy.

### 1.2 Port 20128, không phải 3000

OmniRoute chạy single-port mode: dashboard + API OpenAI-compatible dùng chung
`PORT=20128` (`src/lib/runtime/ports.ts`). `API_PORT` / `DASHBOARD_PORT` chỉ dùng
khi muốn tách.

### 1.3 Health endpoint

Plan gốc dùng `/health` + `/ready`. OmniRoute có sẵn hai cái tương đương:

| Endpoint                 | Bản chất                                    | Dùng ở đâu                                         |
| ------------------------ | ------------------------------------------- | -------------------------------------------------- |
| `/healthz`               | Liveness thuần in-memory, **không đụng DB** | Docker HEALTHCHECK + active health check của Caddy |
| `/api/monitoring/health` | Deep check: SQLite + các subsystem          | Cổng readiness trong `deploy.sh`                   |

Upstream cố tình **không** dùng `/api/monitoring/health` làm Docker healthcheck:
nó đọc SQLite đồng bộ, event loop bận là probe timeout và container bị đánh
unhealthy giữa phiên (issue #10052, #10311). `deploy.sh` dùng nó đúng một lần —
lúc quyết định bản mới có được nhận traffic không — nên không dính vấn đề đó.

Ngoài ra `read_only: true` trong compose bị bỏ: OmniRoute ghi ra ngoài data volume
lúc runtime (chuỗi fallback driver SQLite cài better-sqlite3 vào
`~/.omniroute/runtime`). `cap_drop: ALL` và `no-new-privileges` vẫn giữ.

---

## 2. Deploy theo ref nào?

Upstream dùng mô hình parallel-cycle (`docs/ops/BRANCHING_MODEL.md`):

| Ref              | Vai trò                                | Docker channel      |
| ---------------- | -------------------------------------- | ------------------- |
| `release/vX.Y.Z` | Nhánh **đang phát triển** của cycle đó | `:next`             |
| `main`           | Nhận squash-merge khi cycle ship xong  | `:main`             |
| tag `vX.Y.Z`     | Bản đã ship, bất biến                  | `:X.Y.Z`, `:latest` |

Tại thời điểm dựng repo này: tag mới nhất là **v3.8.49**; **v3.8.50 chưa có tag**,
nó mới chỉ tồn tại dưới dạng nhánh `release/v3.8.50` (đang là default branch của
upstream).

Mặc định của fork này: **bám nhánh `release/v*` cao nhất** — đúng nhu cầu "muốn
lấy version mới nhất kể cả khi chưa release". Khi upstream chuyển cycle sang
`release/v3.8.51`, script tự phát hiện, không cần sửa gì.

Muốn êm hơn thì đổi nguồn bất cứ lúc nào:

```bash
infra/sync-upstream.sh --ref main       # chậm hơn, ổn định hơn
infra/sync-upstream.sh --ref v3.8.50    # khi tag đã được cắt
```

---

## 3. Bố cục

Trong repo (nhánh `prod`):

```
infra/
├── compose.yml            # blue/green + redis + caddy + cloudflared
├── caddy/Caddyfile        # reverse proxy nội bộ, :8080
├── caddy/active.caddy      # seed — deploy.sh ghi đè mỗi lần deploy
├── deploy.sh              # blue/green + kỷ luật single-writer
├── bootstrap-vps.sh       # chuẩn bị VPS lần đầu
├── backup.sh              # sqlite3 .backup, chạy bằng cron
├── sync-upstream.sh       # kéo code mới từ upstream
└── app.env.example        # template cho .app.env

.github/workflows/
├── prod-deploy.yml        # push prod → build → GHCR → SSH deploy
└── prod-sync-upstream.yml # cron thứ 2 hàng tuần → mở PR sync
```

Trên VPS:

```
/opt/omniroute/
├── compose.yml
├── deploy.sh
├── backup.sh
├── .app.env               # chmod 600
├── .tunnel.env            # chmod 600
├── .deploy.env            # deploy.sh tự quản lý
├── caddy/{Caddyfile,active.caddy}
├── data/                  # bind mount → /app/data, owner UID 1000
├── backups/
└── state/{active_slot,previous_image,deploy.lock}
```

---

## 4. Setup lần đầu

### 4.1 VPS

```bash
# Cài Docker theo docs/ops/VM_DEPLOYMENT_GUIDE.md, rồi:
sudo apt install -y sqlite3          # backup.sh cần
git clone https://github.com/TheDemonTuan/OmniRoute.git -b prod /tmp/omniroute
sudo bash /tmp/omniroute/infra/bootstrap-vps.sh
```

Script tạo `/opt/omniroute`, cài file, bật UFW (chỉ mở 22), đặt cron backup, và
**không khởi động gì cả** — lần deploy đầu tiên do `deploy.sh` làm.

Sau đó:

```bash
cp /tmp/omniroute/infra/app.env.example /opt/omniroute/.app.env
chmod 600 /opt/omniroute/.app.env
nano /opt/omniroute/.app.env          # điền JWT_SECRET, API_KEY_SECRET, INITIAL_PASSWORD, domain

echo 'TUNNEL_TOKEN=eyJ...' > /opt/omniroute/.tunnel.env
chmod 600 /opt/omniroute/.tunnel.env

# Cho VPS quyền pull image private trên GHCR
echo <GITHUB_PAT_read_packages> | docker login ghcr.io -u TheDemonTuan --password-stdin
```

Sinh secret:

```bash
openssl rand -base64 48    # JWT_SECRET
openssl rand -hex 32       # API_KEY_SECRET
```

> `API_KEY_SECRET` mã hoá API key của provider trong SQLite. Đổi nó sau khi đã có
> dữ liệu = mất toàn bộ key đã lưu. Đặt một lần, trước lần boot đầu tiên.

### 4.2 Cloudflare Tunnel & Split-Domain Hardening

Trong Cloudflare Zero Trust, tạo tunnel, lấy token, và trỏ **cả 2 public hostnames** về cùng reverse proxy `caddy:8080`:

```
# 1. Management Dashboard Host (Bảo vệ qua Cloudflare Zero Trust Access + MFA):
Hostname : omniroute-admin.example.com (hoặc omniroute.example.com)
Service  : http://caddy:8080

# 2. Client Model API Host (Chỉ cho phép model serving routes, chặn toàn bộ dashboard/admin UI):
Hostname : omniroute-api.example.com (hoặc ai-api.example.com)
Service  : http://caddy:8080
```

**Không** dùng `http://localhost:8080` — `cloudflared` chạy trong container riêng,
`localhost` với nó là chính nó. Docker DNS lo phần `caddy:8080`.
### 4.3 GitHub

Trong `TheDemonTuan/OmniRoute` → Settings → Environments → tạo `production`, thêm
secrets:

| Secret            | Giá trị                                           |
| ----------------- | ------------------------------------------------- |
| `VPS_HOST`        | IP hoặc hostname VPS                              |
| `VPS_USER`        | user SSH có quyền chạy `/opt/omniroute/deploy.sh` |
| `VPS_PORT`        | cổng SSH (bỏ trống = 22)                          |
| `VPS_SSH_KEY`     | private key ed25519 dành riêng cho CI             |
| `VPS_KNOWN_HOSTS` | output của `ssh-keyscan -p 22 <VPS_IP>`           |

Repo variables (Settings → Variables), chỉ đặt nếu cần khác mặc định:

| Variable          | Mặc định      | Khi nào đổi                                                                         |
| ----------------- | ------------- | ----------------------------------------------------------------------------------- |
| `DEPLOY_PLATFORM` | `linux/amd64` | `linux/arm64` nếu `uname -m` trên VPS ra `aarch64`                                  |
| `IMAGE_TARGET`    | `runner-base` | `runner-web` nếu cần provider web-cookie (gemini-web, claude-web, claude-turnstile) |

Tạo key CI:

```bash
ssh-keygen -t ed25519 -C "omniroute-ci" -f ~/.ssh/omniroute_ci
# public key → ~/.ssh/authorized_keys trên VPS
# private key → secret VPS_SSH_KEY
```

### 4.4 Tắt workflow của upstream trong fork

Fork thừa hưởng ~25 workflow của upstream. Đáng chú ý `build.yml` trigger trên
`push: branches: ["**"]` — tức là mỗi lần push `prod` nó cũng chạy một build nặng
vô ích. Tắt hết, chỉ để lại hai workflow của fork:

```bash
gh workflow list --repo TheDemonTuan/OmniRoute --all
# tắt từng cái không phải prod-deploy.yml / prod-sync-upstream.yml
gh workflow disable build.yml --repo TheDemonTuan/OmniRoute
gh workflow disable ci.yml    --repo TheDemonTuan/OmniRoute
# ...
```

---

## 5. Deploy

```bash
git push origin prod
```

Workflow `Production Deploy`:

1. Build image từ `Dockerfile` (target `runner-base`), push lên
   `ghcr.io/thedemontuan/omniroute`.
2. SSH vào VPS, chạy `deploy.sh <image>@sha256:<digest>`.

`deploy.sh` làm:

```
xác định slot INACTIVE
      ↓
pull image mới → start slot đó          ← cửa sổ overlap MỞ
      ↓
chờ Docker healthy (/healthz)
      ↓
chờ /api/monitoring/health → "healthy"
      │
   FAIL ────→ stop slot mới, slot cũ vẫn phục vụ, exit 1
      │
   PASS
      ↓
caddy validate → caddy reload           ← traffic sang bản mới
      ↓
stabilization 30s (slot cũ VẪN chạy)
      │
   FAIL ────→ reload Caddy về slot cũ, stop slot mới, exit 1
      │
   PASS
      ↓
drain 15s → stop slot cũ                ← cửa sổ overlap ĐÓNG
```

Deploy bằng **digest bất biến**, không phải tag. `deploy.sh` từ chối mọi ref
không khớp `ghcr.io/...@sha256:<64 hex>`.

Chạy tay:

```bash
/opt/omniroute/deploy.sh --status
/opt/omniroute/deploy.sh --rollback     # về image mà bản hiện tại đã thay thế
/opt/omniroute/deploy.sh 'ghcr.io/thedemontuan/omniroute@sha256:...'
```

Tuỳ chỉnh thời lượng qua env:

```bash
READY_TIMEOUT=600 STABILIZE_SECONDS=60 /opt/omniroute/deploy.sh '<image>'
```

---

## 6. Kéo code mới từ upstream

Đây là phần trả lời câu "làm sao update khi version mới chưa release".

### Tự động (khuyến nghị)

`prod-sync-upstream.yml` chạy 04:00 UTC thứ Hai hàng tuần: tìm nhánh
`release/v*` cao nhất của upstream, merge vào một nhánh `sync/upstream-*`, và mở
PR về `prod`. Merge PR đó → push `prod` → deploy.

Chạy ngay không cần đợi cron:

```bash
gh workflow run prod-sync-upstream.yml --repo TheDemonTuan/OmniRoute
# hoặc chỉ định ref
gh workflow run prod-sync-upstream.yml --repo TheDemonTuan/OmniRoute -f ref=main
```

### Thủ công

```bash
infra/sync-upstream.sh --dry-run        # xem sẽ merge những gì, không đổi gì
infra/sync-upstream.sh                  # merge nhánh release/v* cao nhất
infra/sync-upstream.sh --push           # merge và push luôn (deploy ngay)
```

Script in ra số commit sẽ vào, 25 commit mới nhất, và version `package.json`
trước/sau — nhìn phát biết đang lên bản nào.

### Vì sao merge chứ không rebase

`prod` = code upstream + các file mới của `infra/`. Merge giữ nguyên lịch sử
upstream và giữ được ancestry để lần merge sau tính diff đúng. Rebase sẽ viết lại
hàng nghìn commit của upstream mỗi lần sync.

Chỉ conflict khi bạn sửa một file **của upstream**. Cố gắng đừng làm vậy: mọi thứ
riêng nên nằm trong file mới.

---

## 7. Backup

In-app auto-backup bị **tắt** (`DISABLE_SQLITE_AUTO_BACKUP=true`) vì trong cửa sổ
overlap hai slot sẽ cùng chạy nó trên một file. Chủ sở hữu duy nhất của backup là
`backup.sh`, chạy bằng cron 03:17 hàng ngày:

- `sqlite3 .backup` — snapshot nhất quán trên DB đang chạy WAL. `cp`/`tar` có thể
  chộp phải trang bị xé.
- `PRAGMA integrity_check` trước khi cho retention xoá bản cũ.
- gzip, giữ 14 ngày (`RETAIN_DAYS`).

```bash
/opt/omniroute/backup.sh                # chạy tay
ls -la /opt/omniroute/backups/
tail /opt/omniroute/backups/backup.log
```

Restore:

```bash
cd /opt/omniroute
docker compose --env-file .deploy.env -f compose.yml stop app-blue app-green
gunzip -c backups/storage-<stamp>.sqlite.gz > data/storage.sqlite
chown 1000:1000 data/storage.sqlite
./deploy.sh --status                    # rồi start lại slot active
```

---

## 8. Chẩn đoán nhanh

```bash
cd /opt/omniroute
./deploy.sh --status

DC="docker compose --env-file .deploy.env -f compose.yml"
$DC ps
$DC logs -f --tail=100 app-blue
$DC logs --tail=50 caddy
$DC logs --tail=50 cloudflared
cat caddy/active.caddy | head -3        # dòng đầu ghi active=<slot>
```

| Triệu chứng                          | Nguyên nhân thường gặp                                                                   |
| ------------------------------------ | ---------------------------------------------------------------------------------------- |
| Slot mới không bao giờ healthy       | Thiếu `JWT_SECRET`/`API_KEY_SECRET` trong `.app.env`; xem `$DC logs app-<slot>`          |
| `permission denied` trên `/app/data` | `data/` không thuộc UID 1000 → `sudo chown -R 1000:1000 /opt/omniroute/data`             |
| Cloudflare trả 502                   | `cloudflared` trỏ sai service; phải là `http://caddy:8080`                               |
| Caddy reload fail                    | Xem `$DC exec caddy caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile`    |
| SSE/stream bị ngắt                   | `flush_interval -1` phải có trong `caddy/active.caddy`                                   |
| **Cả hai slot đang chạy**            | Bất thường — deploy hỏng giữa chừng. Stop slot không nằm trong `state/active_slot` ngay. |

Kiểm tra bất biến quan trọng nhất — đúng một slot đang chạy:

```bash
docker compose --env-file .deploy.env -f compose.yml ps --status running \
  | grep -c 'app-\(blue\|green\)'      # phải ra 1
```

---

## 9. Còn lại gì chưa giải quyết

- **Vẫn chỉ 1 VPS.** VPS chết, Docker daemon chết, disk chết → mất toàn bộ stack.
  HA thật cần 2 VPS + 2 tunnel, và khi đó SQLite trở thành rào cản kiến trúc thực sự.
- **Không có hot standby**, theo thiết kế — xem §1.1.
- **Migration DB** do upstream quản lý và chạy lúc boot. Vì chỉ một slot sống ở
  trạng thái ổn định nên không cần expand/migrate/contract như plan gốc, nhưng
  rollback qua một migration phá vỡ tương thích thì `--rollback` không cứu được.
  Backup mới là thứ cứu — hãy kiểm tra `backups/` trước khi lên một minor version mới.
