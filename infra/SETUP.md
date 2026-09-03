# OmniRoute — Checklist triển khai đầy đủ

Tài liệu này là **danh sách việc phải làm theo thứ tự**. Phần giải thích kiến
trúc và lý do thiết kế nằm ở [README.md](./README.md).

Ký hiệu: ✅ = tôi đã làm xong · ⬜ = bạn cần làm

---

## 0. Flow này có đúng ý bạn không?

Bạn mô tả:

> máy dev thì chỉ việc push commit hoặc kéo code mới từ fork về, github xử lý
> gần như hết mọi thứ, vps chỉ việc chạy docker image

Đối chiếu thực tế:

| Thành phần  | Bạn muốn              | Thực tế                                                                                                                                           | Khớp?                   |
| ----------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| **Máy dev** | chỉ push / kéo code   | `infra/sync-upstream.sh` rồi `git push origin prod`. Hoặc **không đụng máy dev chút nào** — cron thứ Hai tự mở PR, bạn bấm Merge trên web là xong | ✅ còn nhẹ hơn bạn nghĩ |
| **GitHub**  | xử lý gần hết         | `npm ci` + `npm run build` + `docker build` + push GHCR + đồng bộ file infra + SSH gọi deploy                                                     | ✅                      |
| **VPS**     | chỉ chạy docker image | chạy container + `deploy.sh` điều phối blue/green + cron backup                                                                                   | ⚠️ xem dưới             |

**Chỗ lệch duy nhất, nói thẳng:** VPS không chỉ "chạy image". Nó còn giữ
`deploy.sh` — script quyết định slot nào nhận traffic, gọi `caddy reload`, và
stop slot cũ.

Lý do không đẩy phần đó lên GitHub: việc chuyển traffic là một chuỗi thao tác có
trạng thái (khoá `flock`, file `active_slot`, cửa sổ stabilization 30 giây).
Nếu để GitHub Actions gõ từng lệnh docker qua SSH, một cú rớt mạng giữa chừng sẽ
để lại hai container cùng sống trên một file SQLite — đúng thứ nguy hiểm nhất
với app này. Đặt logic trên VPS thì mất kết nối cũng không sao: script vẫn chạy
tiếp tới cùng.

**Bù lại, VPS hoàn toàn không cần source code.** Nó không `git pull`, không
`npm install`, không `docker build`. Nó chỉ `docker pull` một digest và chạy.
Bốn file hạ tầng (`compose.yml`, `Caddyfile`, `deploy.sh`, `backup.sh`) được
GitHub Actions tự đồng bộ mỗi lần deploy, nên sau bootstrap bạn không SSH vào
nữa trừ khi debug.

> Ngoại lệ duy nhất phải SSH lại: khi **thêm/sửa biến trong `.app.env`**. File
> đó chứa secret nên cố ý không nằm trong git và không được đồng bộ tự động.

---

## 1. Đã làm sẵn ✅

Không cần làm lại, ghi ra để bạn biết trạng thái hiện tại.

- ✅ Fork `diegosouzapw/OmniRoute` → **`TheDemonTuan/OmniRoute`**
- ✅ Nhánh **`prod`** = code upstream (`release/v3.8.50`) + thư mục `infra/` + 2 workflow
- ✅ Default branch của fork đổi thành `prod`
  _(bắt buộc — GitHub chỉ chạy `on: schedule` từ default branch)_
- ✅ Bật GitHub Actions trên fork
- ✅ Tắt 25 workflow của upstream, chỉ chừa `Production Deploy` + `Sync Upstream`
  _(quan trọng: `build.yml` của upstream trigger trên `push: branches: ["**"]`)_
- ✅ Repo local trên máy dev đang dùng: `/media/tuannv/Projects/OmniRoute` (Linux Mint).
  Máy Windows cũ ở `D:\omniroute\OmniRoute` vẫn dùng được, hai máy độc lập nhau.
  Cả hai đều có:
  - `origin` → fork của bạn
  - `upstream` → repo gốc (chỉ đọc)

---

## 2. Trước khi bắt đầu ⬜

- ⬜ **VPS** Ubuntu 22.04+ **hoặc** RHEL-family 8/9 (Oracle Linux, Rocky, Alma) ·
  tối thiểu 2 vCPU / 2 GB RAM / 25 GB SSD
  _(OmniRoute mặc định `OMNIROUTE_MEMORY_MB=1024`; trong cửa sổ blue/green có
  lúc 2 container cùng sống nên 1 GB RAM là quá chật)_
- ⬜ **Domain** đang trỏ nameserver về Cloudflare
- ⬜ **Docker Engine 24+** trên VPS
- ⬜ Một user SSH có `sudo`, không phải login bằng root

---

## 3. Kiến trúc VPS ⬜

### 3.1 Xác định kiến trúc CPU

```bash
uname -m
```

| Kết quả   | Cần làm ở bước 6.2                                                                        |
| --------- | ----------------------------------------------------------------------------------------- |
| `x86_64`  | không cần gì (mặc định `DEPLOY_PLATFORM=linux/amd64`, runner `ubuntu-latest`)             |
| `aarch64` | **bắt buộc cả hai**: `DEPLOY_PLATFORM=linux/arm64` **và** `BUILD_RUNNER=ubuntu-24.04-arm` |

Đặt thiếu `BUILD_RUNNER` là lỗi tốn thời gian nhất ở đây: `DEPLOY_PLATFORM`
chỉ nói _build ra kiến trúc nào_, không nói _build trên máy nào_. Runner x86
build `linux/arm64` sẽ chạy qua QEMU — image này mất hàng giờ (và hay OOM) thay
vì khoảng 20 phút. Runner ARM64 của GitHub **miễn phí với repo public**.

Đồng thời xác định họ distro, vì lệnh cài Docker khác nhau:

```bash
cat /etc/os-release | head -3
```

### 3.2 Cài Docker + sqlite3

#### Debian / Ubuntu

```bash
apt update && apt upgrade -y
apt install -y ca-certificates curl gnupg sqlite3

install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
chmod a+r /etc/apt/keyrings/docker.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
  | tee /etc/apt/sources.list.d/docker.list > /dev/null
apt update
apt install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin

# cho user SSH chạy docker không cần sudo
usermod -aG docker "$USER"
newgrp docker
```

#### Oracle Linux / Rocky / Alma / RHEL 8–9

Không có `apt`. Ngoài ra RHEL-family cài sẵn `podman`/`runc`, xung đột với
`containerd.io` — `--allowerasing` để dnf gỡ chúng ra.

```bash
sudo dnf -y install dnf-plugins-core sqlite cronie
sudo dnf config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo
sudo dnf -y install --allowerasing docker-ce docker-ce-cli containerd.io docker-compose-plugin
sudo systemctl enable --now docker
sudo systemctl enable --now crond          # /etc/cron.d cần crond đang chạy
sudo usermod -aG docker "$USER"
```

Ba khác biệt so với Ubuntu, đừng bỏ qua:

- **Package tên `sqlite`**, không phải `sqlite3` (binary vẫn là `sqlite3`).
- **`cronie` thường không có sẵn** trên image minimal. Thiếu nó thì cron backup
  hàng đêm không bao giờ chạy mà cũng không báo lỗi. `bootstrap-vps.sh` sẽ cảnh
  báo nếu không tìm thấy cron daemon.
- **SELinux mặc định `Enforcing`.** `compose.yml` gắn `:z` lên các bind mount để
  Docker tự relabel — không cần `setenforce 0`. Nếu bạn thấy container không ghi
  được `storage.sqlite`, kiểm tra `:z` còn nguyên trong `/opt/omniroute/compose.yml`.

Không có `ufw` — `bootstrap-vps.sh` tự chuyển sang `firewalld`. Trên Oracle
Cloud, inbound còn bị chặn thêm một lớp nữa ở Security List / NSG của VCN;
không cần mở gì thêm vì Cloudflare Tunnel là kết nối **đi ra**.

#### Cả hai họ distro

`sqlite3` là bắt buộc — `backup.sh` dùng `sqlite3 .backup` để snapshot DB đang
chạy WAL. Không có nó thì cron backup fail mỗi đêm.

### 3.3 Chạy bootstrap

```bash
git clone https://github.com/TheDemonTuan/OmniRoute.git -b prod /tmp/omniroute-infra
sudo bash /tmp/omniroute-infra/infra/bootstrap-vps.sh
```

Script tạo `/opt/omniroute`, cài 4 file hạ tầng, siết firewall về chỉ port 22
(UFW trên Debian/Ubuntu, `firewalld` trên RHEL-family, bỏ qua nếu không có cả
hai), đặt cron backup 03:17 hàng ngày, và **không khởi động gì cả**. Lần deploy
đầu tiên do `deploy.sh` làm.

Đây là lần **duy nhất** VPS cần source code. Xoá được ngay sau đó:

```bash
rm -rf /tmp/omniroute-infra
```

### 3.4 Điền `.app.env`

```bash
sudo cp /tmp/omniroute-infra/infra/app.env.example /opt/omniroute/.app.env
sudo chown "$USER":"$USER" /opt/omniroute/.app.env
chmod 600 /opt/omniroute/.app.env

# sinh secret
openssl rand -base64 48   # -> JWT_SECRET
openssl rand -hex 32      # -> API_KEY_SECRET

nano /opt/omniroute/.app.env
```

Bắt buộc điền và cấu hình:

| Biến                      | Ghi chú                                                                                                                          |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `JWT_SECRET`              | đổi = mọi phiên đăng nhập dashboard bị vô hiệu                                                                                   |
| `API_KEY_SECRET`          | **đặt một lần, đừng bao giờ đổi** — nó mã hoá API key của provider trong SQLite; đổi sau khi đã có dữ liệu = mất sạch key đã lưu |
| `INITIAL_PASSWORD`        | mật khẩu dashboard lần đầu, đổi trong Settings → Security sau khi vào được                                                       |
| `DASHBOARD_HOST`          | Hostname quản trị dashboard (vd: `omniroute-admin.<domain-của-bạn>` hoặc `omniroute.<domain-của-bạn>`)                           |
| `API_HOST`                | Hostname phục vụ model API cho client (vd: `omniroute-api.<domain-của-bạn>` hoặc `ai-api.<domain-của-bạn>`)                      |
| `NEXT_PUBLIC_BASE_URL`    | `https://${DASHBOARD_HOST}` (vd: `https://omniroute-admin.<domain-của-bạn>`)                                                     |
| `CORS_ORIGIN`             | `https://${DASHBOARD_HOST}`                                                                                                      |
| `LIVE_WS_ALLOWED_ORIGINS` | `https://${DASHBOARD_HOST}`                                                                                                      |

Các giá trị bảo mật đã set sẵn hợp lý trong template, đừng sửa nếu không có lý do:
`AUTH_COOKIE_SECURE=true`, `REQUIRE_API_KEY=true`, `ALLOW_API_KEY_REVEAL=false`,
`DISABLE_SQLITE_AUTO_BACKUP=true`, `REDIS_URL=redis://redis:6379`,
`OMNIROUTE_TRUST_PROXY=private`.

> `ALLOW_API_KEY_REVEAL=false`: Bảo vệ production bằng cách không bao giờ hiển thị lại các API key bí mật của Provider trong giao diện UI hoặc API response sau khi đã nhập.
>
> `DISABLE_SQLITE_AUTO_BACKUP=true` **không phải tuỳ chọn**. Trong cửa sổ
> blue/green có lúc 2 container cùng sống; nếu bật, cả hai sẽ cùng chạy
> auto-backup trên một file SQLite. Backup do `backup.sh` + cron lo.

### 3.5 Quyền pull image — không cần làm gì

Package `ghcr.io/thedemontuan/omniroute` hiện **public**: nó được publish từ một
repo public nên GitHub cho pull ẩn danh. Kiểm chứng bằng một máy chưa từng
`docker login ghcr.io`:

```bash
T=$(curl -s "https://ghcr.io/token?scope=repository:thedemontuan/omniroute:pull&service=ghcr.io" \
    | python3 -c 'import sys,json;print(json.load(sys.stdin)["token"])')
curl -s -o /dev/null -w "%{http_code}\n" -H "Authorization: Bearer $T" \
  -H "Accept: application/vnd.oci.image.index.v1+json" \
  https://ghcr.io/v2/thedemontuan/omniroute/manifests/<digest>
# 200 = public
```

Nghĩa là VPS không cần credential gì để pull. Ai cũng pull được bản build của
bạn — image không chứa secret (secret nằm ở `.app.env` trên VPS, không bao giờ
vào image), và mã nguồn fork vốn đã public.

Dù vậy job deploy vẫn cho VPS mượn `GITHUB_TOKEN` của lần chạy đó (step 2.3b) và
logout ngay sau (step 2.6). Hai bước ấy tốn vài giây và hiện không bắt buộc —
giữ lại để nếu có ngày bạn chuyển package sang private thì không phải sửa gì,
và để `~/.docker/config.json` trên VPS luôn trống giữa hai lần deploy.

## 4. Khoá SSH cho CI ⬜

Tạo key **riêng** cho GitHub Actions, đừng dùng lại key cá nhân.

Trên máy dev:

```bash
ssh-keygen -t ed25519 -C "omniroute-ci" -f ~/.ssh/omniroute_ci -N ""
```

Public key → VPS:

```bash
ssh-copy-id -i ~/.ssh/omniroute_ci.pub <user>@<vps-ip>
# hoặc thủ công: nối nội dung .pub vào ~/.ssh/authorized_keys trên VPS
```

Lấy known_hosts (chống MITM — đừng bỏ qua):

```bash
ssh-keyscan -p 22 <vps-ip>
```

Kiểm tra key hoạt động trước khi giao cho CI:

```bash
ssh -i ~/.ssh/omniroute_ci <user>@<vps-ip> '/opt/omniroute/deploy.sh --status'
```

Phải in ra `(not deployed yet — ...)`. Nếu lỗi ở đây thì CI cũng sẽ lỗi.

---

## 5. Cloudflare Tunnel & Split-Domain Setup ⬜

Kiến trúc **Split-Domain Hardening** phân tách rõ rệt 2 hostname vào cùng Caddy reverse proxy:

1. **Dashboard Host** (`DASHBOARD_HOST`): UI quản trị, cài đặt, tạo API key — **bảo vệ sau Cloudflare Access + MFA**.
2. **API Host** (`API_HOST`): Model Gateway cho client AI/IDE — **chỉ mở các route model (`/v1/*`, `/chat/completions`, ...) và chặn toàn bộ route dashboard/admin**.

### 5.1 Cấu hình Cloudflare Tunnel

1. Cloudflare Dashboard → **Zero Trust** → Networks → **Tunnels** → Create a tunnel
2. Chọn **Cloudflared**, đặt tên (vd: `omniroute-prod`), **copy token** (chuỗi `eyJ...`)
3. Tab **Public Hostname** → Thêm **cả 2 hostname** sau:

   **Hostname 1 (Dashboard Admin):**

   | Trường             | Giá trị                                                 |
   | ------------------ | ------------------------------------------------------- |
   | Subdomain / Domain | `<DASHBOARD_HOST>` (vd: `omniroute-admin.<domain-bạn>`) |
   | Type               | `HTTP`                                                  |
   | URL                | `caddy:8080`                                            |

   **Hostname 2 (Model Serving API):**

   | Trường             | Giá trị                                         |
   | ------------------ | ----------------------------------------------- |
   | Subdomain / Domain | `<API_HOST>` (vd: `omniroute-api.<domain-bạn>`) |
   | Type               | `HTTP`                                          |
   | URL                | `caddy:8080`                                    |

   ⚠️ **Không** điền `localhost:8080`. `cloudflared` chạy trong container riêng,
   `localhost` với nó là chính nó. Docker DNS phân giải `caddy` được vì hai
   container cùng network `edge`.

4. Ghi token lên VPS:

```bash
echo 'TUNNEL_TOKEN=eyJ...' > /opt/omniroute/.tunnel.env
chmod 600 /opt/omniroute/.tunnel.env
```

Không cần mở port 80/443 trên VPS. Tunnel là đường vào duy nhất.

### 5.2 Khóa Dashboard bằng Cloudflare Zero Trust Access ⬜

Để bảo vệ bề mặt quản trị không bị quét hoặc tấn công brute-force:

1. Cloudflare Dashboard → **Zero Trust** → **Access** → **Applications** → **Add an application** → Chọn **Self-hosted**.
2. Cấu hình Application:
   - **Application name**: `OmniRoute Admin Dashboard`
   - **Application domain**: Điền đúng `<DASHBOARD_HOST>` (vd: `omniroute-admin.yourdomain.com`).
   - **Session Duration**: 24 hours (hoặc tuỳ chọn).
3. Cấu hình Policies:
   - Policy name: `Allow Admins Only`
   - Action: `Allow`
   - Rule: `Include` → `Emails` (hoặc `Emails ending in`) → Nhập email của bạn (hoặc kết nối Google / GitHub SSO IdP).
4. **LƯU Ý QUAN TRỌNG**: **KHÔNG** gán Cloudflare Access Application lên `<API_HOST>`.
   - `<API_HOST>` là endpoint để các client AI (Cline, Cursor, Roo Code, LibreChat, scripts) gửi request mang `Authorization: Bearer sk-...`.
   - Caddy trên `<API_HOST>` sẽ tự động chặn mọi request truy cập `/dashboard`, `/login`, `/api/settings` và chỉ cho phép các API route hợp lệ.

### 5.3 Cloudflare WAF và Rate Limiting ⬜

Trong zone `tuannguyenviet.site`, mở **Security → WAF**. Gói Free có một Rate
Limiting rule; tạo đúng rule sau:

- Name: `OmniRoute API burst protection`
- Expression:

```text
(http.host eq "omniroute-api.tuannguyenviet.site" and ((http.request.uri.path eq "/v1" or starts_with(http.request.uri.path, "/v1/")) or (http.request.uri.path eq "/api/v1" or starts_with(http.request.uri.path, "/api/v1/")) or (http.request.uri.path eq "/v1beta" or starts_with(http.request.uri.path, "/v1beta/")) or (http.request.uri.path eq "/api/v1beta" or starts_with(http.request.uri.path, "/api/v1beta/")) or (http.request.uri.path eq "/chat/completions" or starts_with(http.request.uri.path, "/chat/completions/")) or (http.request.uri.path eq "/responses" or starts_with(http.request.uri.path, "/responses/")) or (http.request.uri.path eq "/models" or starts_with(http.request.uri.path, "/models/")) or (http.request.uri.path eq "/codex" or starts_with(http.request.uri.path, "/codex/")) or (http.request.uri.path eq "/api/cursor-cli" or starts_with(http.request.uri.path, "/api/cursor-cli/"))))
```

- Characteristics: `IP`; Requests: `60`; Period: `10 seconds`
- Action: `Block`; Mitigation duration: `10 seconds`

Rate limit Free áp dụng theo IP + datacenter Cloudflare và chỉ match đúng API
host cùng ranh giới path (`/v1` hoặc `/v1/...`, không match `/v1evil`).

Tạo năm **Custom WAF rules** theo đúng thứ tự sau (dùng hết quota 5 rules của gói Free):

1. Name: `OmniRoute API require Authorization`; Action: `Block`

```text
(http.host eq "omniroute-api.tuannguyenviet.site" and http.request.method ne "OPTIONS" and ((http.request.uri.path eq "/v1" or starts_with(http.request.uri.path, "/v1/")) or (http.request.uri.path eq "/api/v1" or starts_with(http.request.uri.path, "/api/v1/")) or (http.request.uri.path eq "/v1beta" or starts_with(http.request.uri.path, "/v1beta/")) or (http.request.uri.path eq "/api/v1beta" or starts_with(http.request.uri.path, "/api/v1beta/")) or (http.request.uri.path eq "/chat/completions" or starts_with(http.request.uri.path, "/chat/completions/")) or (http.request.uri.path eq "/responses" or starts_with(http.request.uri.path, "/responses/")) or (http.request.uri.path eq "/models" or starts_with(http.request.uri.path, "/models/")) or (http.request.uri.path eq "/codex" or starts_with(http.request.uri.path, "/codex/")) or (http.request.uri.path eq "/api/cursor-cli" or starts_with(http.request.uri.path, "/api/cursor-cli/"))) and not any(lower(http.request.headers.names[*])[*] in {"authorization" "x-api-key" "x-goog-api-key"}) and not starts_with(http.request.uri.path, "/api/v1/vscode/") and not starts_with(http.request.uri.path, "/vscode/"))
```

Rule chấp nhận Bearer key, Anthropic/OpenAI-style `x-api-key`, Gemini
`x-goog-api-key`, và VS Code path token; request rác bị chặn trước Worker/VPS.

2. Name: `Block common scanners`; Action: `Block`

```text
((http.host eq "omniroute-api.tuannguyenviet.site" or http.host eq "omniroute-admin.tuannguyenviet.site") and (lower(http.request.uri.path) eq "/.env" or lower(http.request.uri.path) eq "/.git" or starts_with(lower(http.request.uri.path), "/.git/") or lower(http.request.uri.path) eq "/.svn" or starts_with(lower(http.request.uri.path), "/.svn/") or starts_with(lower(http.request.uri.path), "/wp-admin") or lower(http.request.uri.path) eq "/wp-login.php" or lower(http.request.uri.path) eq "/xmlrpc.php" or starts_with(lower(http.request.uri.path), "/phpmyadmin") or starts_with(lower(http.request.uri.path), "/cgi-bin/") or lower(http.request.uri.path) eq "/server-status" or lower(http.request.uri.path) eq "/.ds_store"))
```

3. Name: `OmniRoute API restrict methods`; Action: `Block`

```text
(http.host eq "omniroute-api.tuannguyenviet.site" and not http.request.method in {"GET" "POST" "OPTIONS" "HEAD"})
```

4. Name: `OmniRoute API block unknown routes`; Action: `Block`

Chặn mọi path khác trên API hostname ngay tại WAF, ngoại trừ model routes,
`/api/monitoring/health`, `/tg-ops/*` và `/__edge-control/*`. Caddy và Worker vẫn
giữ cùng policy ở lớp sau để defense-in-depth. Đây là custom rule thứ 4/5 của
gói Free.

5. Name: `Skip Managed Rules for LLM payloads`; Action: `Skip`

```text
(http.host eq "omniroute-api.tuannguyenviet.site" and ((http.request.uri.path eq "/v1" or starts_with(http.request.uri.path, "/v1/")) or (http.request.uri.path eq "/api/v1" or starts_with(http.request.uri.path, "/api/v1/")) or (http.request.uri.path eq "/v1beta" or starts_with(http.request.uri.path, "/v1beta/")) or (http.request.uri.path eq "/api/v1beta" or starts_with(http.request.uri.path, "/api/v1beta/")) or (http.request.uri.path eq "/chat/completions" or starts_with(http.request.uri.path, "/chat/completions/")) or (http.request.uri.path eq "/responses" or starts_with(http.request.uri.path, "/responses/")) or (http.request.uri.path eq "/models" or starts_with(http.request.uri.path, "/models/")) or (http.request.uri.path eq "/codex" or starts_with(http.request.uri.path, "/codex/")) or (http.request.uri.path eq "/api/cursor-cli" or starts_with(http.request.uri.path, "/api/cursor-cli/"))))
```

Chỉ chọn **All managed rules** trong Skip Components; không chọn **All rate
limiting rules** hoặc **All remaining custom rules**. Bật Cloudflare Managed Free
Ruleset cho hai OmniRoute host; skip này chỉ miễn model payload để tránh false
positive SQL/XSS, còn dashboard và path không phải model vẫn được managed WAF quét.

Giữ `Always Use HTTPS = On`, `Minimum TLS Version = TLS 1.2`, `TLS 1.3 = On`.
Bot Fight Mode của gói Free không thể skip theo hostname/path và Cloudflare cảnh
báo có thể challenge API/mobile traffic; tắt nó nếu client AI gặp challenge 403.
---

## 6. GitHub ⬜

### 6.1 Environment + secrets

`TheDemonTuan/OmniRoute` → Settings → Environments → **New environment** → tên
chính xác là **`production`** → thêm 5 secret:

| Secret            | Giá trị                                                                                     |
| ----------------- | ------------------------------------------------------------------------------------------- |
| `VPS_HOST`        | IP hoặc hostname VPS                                                                        |
| `VPS_USER`        | user SSH ở bước 4                                                                           |
| `VPS_PORT`        | cổng SSH (bỏ trống nếu là 22)                                                               |
| `VPS_SSH_KEY`     | **toàn bộ** nội dung `~/.ssh/omniroute_ci` (private key, gồm cả dòng `-----BEGIN/END-----`) |
| `VPS_KNOWN_HOSTS` | output của `ssh-keyscan` ở bước 4                                                           |

Muốn deploy phải bấm duyệt: trong environment đó bật **Required reviewers**.

### 6.2 Repo variables

Settings → Secrets and variables → Actions → tab **Variables**.

| Variable          | Mặc định        | Khi nào đặt                                                                                                       |
| ----------------- | --------------- | ----------------------------------------------------------------------------------------------------------------- |
| `DEPLOY_PLATFORM` | `linux/amd64`   | đặt `linux/arm64` nếu bước 3.1 ra `aarch64`                                                                       |
| `BUILD_RUNNER`    | `ubuntu-latest` | đặt `ubuntu-24.04-arm` nếu bước 3.1 ra `aarch64` — **luôn đi kèm** `DEPLOY_PLATFORM`                              |
| `IMAGE_TARGET`    | `runner-base`   | đặt `runner-web` nếu cần provider web-cookie (gemini-web, claude-web, claude-turnstile) — image nặng thêm ~300 MB |

### 6.3 Telegram Ops Bot (tùy chọn)

Bot quản trị chạy bằng systemd trên VPS và dùng BotFather token/GitHub App riêng. Làm theo
[`docs/ops/TELEGRAM_OPS_BOT.md`](../docs/ops/TELEGRAM_OPS_BOT.md) để tạo credential, lấy Telegram
user/chat ID, tạo PIN hash và điền `/etc/omniroute/ops-bot.env`. Production deploy chỉ cài/cập nhật
mã bot; service không được bật nếu file cấu hình chưa hợp lệ.

---

## 7. Deploy lần đầu ⬜

### 7.1 Thử build trước (khuyến nghị)

Build mất khoảng 20–40 phút lần đầu (chưa có cache). Chạy riêng phần build để
chắc chắn nó xanh trước khi đụng tới VPS:

```bash
gh workflow run prod-deploy.yml --repo TheDemonTuan/OmniRoute -f skip_deploy=true
gh run watch --repo TheDemonTuan/OmniRoute
```

Xong thì kiểm tra image đã lên GHCR:
`https://github.com/TheDemonTuan?tab=packages`

### 7.2 Deploy thật

```bash
gh workflow run prod-deploy.yml --repo TheDemonTuan/OmniRoute
gh run watch --repo TheDemonTuan/OmniRoute
```

Lần này `deploy.sh` sẽ:

```
chọn slot blue  →  pull image  →  start
      ↓
chờ /healthz healthy
      ↓
chờ /api/monitoring/health → "healthy"
      ↓
sinh caddy/active.caddy trỏ blue
      ↓
start caddy + cloudflared
      ↓
ghi state/active_slot = blue
```

### 7.3 Kiểm tra Split-Domain Hardening

```bash
ssh <user>@<vps> '/opt/omniroute/deploy.sh --status'

# 1. Kiểm tra liveness và health của app:
curl https://<DASHBOARD_HOST>/api/monitoring/health   # -> {"status":"healthy",...}
curl https://<API_HOST>/api/monitoring/health         # -> {"status":"healthy",...}

# 2. Kiểm tra chặn Dashboard & Admin routes trên API host (phải trả về 404):
curl -I https://<API_HOST>/dashboard                 # -> HTTP/2 404
curl -I https://<API_HOST>/login                     # -> HTTP/2 404
curl -I https://<API_HOST>/api/settings              # -> HTTP/2 404

# 3. Kiểm tra Model Serving trên API host:
curl -H "Authorization: Bearer <API_KEY>" https://<API_HOST>/v1/models   # -> 200 OK (danh sách models)
```

Mở `https://<DASHBOARD_HOST>` (qua Cloudflare Zero Trust Access OTP) → đăng nhập bằng `INITIAL_PASSWORD` → **đổi mật
khẩu ngay** trong Settings → Security.
---

## 8. Vận hành hàng ngày

### 8.1 Kéo code mới từ upstream

Sử dụng script `infra/sync-upstream.sh` từ máy dev:

```bash
cd /media/tuannv/Projects/OmniRoute
bash infra/sync-upstream.sh --dry-run    # xem sẽ merge gì, version trước/sau
bash infra/sync-upstream.sh              # merge, chưa push
git push origin prod                     # -> deploy
```

Đổi nguồn theo dõi bất cứ lúc nào:

```bash
bash infra/sync-upstream.sh --ref main       # chậm hơn, ổn định hơn
bash infra/sync-upstream.sh --ref v3.8.50    # ghim tag, khi tag đã được cắt
```

> Vì sao mặc định là nhánh `release/v*` chứ không phải tag: **một version chưa
> release thì chỉ tồn tại dưới dạng nhánh**. Lúc dựng repo này, tag mới nhất của
> upstream là `v3.8.49`; `v3.8.50` mới chỉ là nhánh `release/v3.8.50`. Script
> dùng `sort -V` nên khi upstream chuyển sang `release/v3.8.51` nó tự theo, bạn
> không phải sửa gì.
>
> Đánh đổi: nhánh đó là đầu phát triển, có CI gác nhưng **chưa freeze** và vẫn
> có lúc đỏ. Trước khi merge PR sync, liếc qua CI của upstream cho ref đó.

### 8.2 Sửa code của chính bạn

```bash
git checkout prod
# ...sửa...
git commit -am "..."
git push origin prod     # -> build + deploy
```

Cố gắng chỉ **thêm file mới**. Sửa file của upstream = file đó thành gánh nặng
merge của bạn về sau.

### 8.3 Rollback

```bash
ssh <user>@<vps> '/opt/omniroute/deploy.sh --rollback'
```

Quay về đúng image mà bản hiện tại đã thay thế.

Chạy tay qua SSH được. Hiện package là public nên pull luôn thành công; ngoài ra
`deploy.sh` còn một lớp dự phòng: pull hỏng thì kiểm tra image đã có sẵn trên đĩa
chưa — có thì dùng bản local, không có mới báo lỗi. Slot cũ vẫn giữ tham chiếu
tới image đó nên `docker image prune` không xoá nó. Lớp này chỉ thành thiết yếu
nếu bạn chuyển package sang private.

⚠️ `--rollback` không cứu được khi bản mới đã chạy một migration DB phá vỡ tương
thích ngược. Lúc đó thứ cứu bạn là backup — xem 8.4.

### 8.4 Backup

Tự động 03:17 hàng ngày, giữ 14 ngày.

```bash
ls -la /opt/omniroute/backups/
tail /opt/omniroute/backups/backup.log
/opt/omniroute/backup.sh                 # chạy tay
```

Restore: xem [README.md §7](./README.md).

Về dung lượng: backup là ảnh chụp `storage.sqlite` đã gzip. Với DB 2 MB thì mỗi
bản khoảng 0.3–0.5 MB, giữ 14 bản là ~5 MB. Nó **không** phải thứ chiếm đĩa —
xem 8.6 trước khi định tắt nó đi.

Và đây là thứ duy nhất cứu được dữ liệu. `storage.sqlite` chứa toàn bộ provider
connection kèm API key đã mã hoá, cấu hình combo/routing, settings dashboard,
log usage/cost, memory, MCP audit. `--rollback` chỉ đổi image, không đụng dữ
liệu — mất file này là ngồi nhập lại từng API key bằng tay.

### 8.5 Deploy có làm gián đoạn người đang dùng không?

Không, trừ một trường hợp — và trường hợp đó đã được nới.

Green phải `healthy` (qua `/healthz` **và** `/api/monitoring/health`) _trước_ khi
Caddy đổi hướng, nên không có khoảnh khắc nào không ai lắng nghe. Dòng thời gian
tính từ lúc `caddy reload`:

```
t=0s     request MỚI đi vào green
t=0–30   stabilization  (blue vẫn chạy; nếu green hỏng thì traffic quay lại blue)
t=30–45  drain          (DRAIN_SECONDS=15)
t=45     SIGTERM tới blue
t=45+    blue drain request đang bay, thoát NGAY khi request cuối kết thúc
t=165    trần app tự thoát   (SHUTDOWN_TIMEOUT_MS=120s)
t=195    trần Docker SIGKILL (stop_grace_period=150s) — thực tế không bao giờ chạm tới
```

| Bạn đang làm gì lúc switch      | Ảnh hưởng                          |
| ------------------------------- | ---------------------------------- |
| Bấm dashboard, gọi API thường   | không thấy gì                      |
| Stream câu trả lời LLM < 2 phút | chạy hết trên blue                 |
| Stream dài hơn 2 phút           | bị cắt ở t=165                     |
| WebSocket live-monitoring       | rớt, client tự reconnect vào green |

**Ba con số phải giữ đúng thứ tự này:**

```
SHUTDOWN_TIMEOUT_MS  <  stop_grace_period  ≤  stream_close_delay
    120s (compose)        150s (compose)       5m (deploy.sh sinh ra)
```

- App phải tự quyết định thoát **trước** khi Docker `SIGKILL`. Nếu ngược lại,
  `cleanup()` trong `src/lib/gracefulShutdown.ts` không kịp chạy và
  `storage.sqlite` bị bỏ lại với WAL chưa checkpoint.
- Caddy phải kiên nhẫn ít nhất bằng app, nếu không nó cắt stream mà slot cũ vẫn
  đang sẵn sàng phục vụ tới cùng.

**Tăng `SHUTDOWN_TIMEOUT_MS` không làm deploy chậm đi.** `waitForDrain()` thoát
ngay khi `activeRequests <= 0`, nên slot rảnh vẫn tắt trong khoảng 0.25 giây.
Con số 120s chỉ có tác dụng khi thật sự còn stream đang chạy.

Hệ quả duy nhất cần biết: cửa sổ hai container cùng mở `storage.sqlite` kéo dài
đúng bằng thời gian stream cuối cùng còn sống. SQLite WAL có khoá liên tiến trình
nên không hỏng dữ liệu, nhưng đó là lý do các con số này không nên nới vô tội vạ.

### 8.6 Đĩa

Thứ thật sự ăn đĩa là image, không phải backup:

|                                        | Dung lượng |
| -------------------------------------- | ---------- |
| Image OmniRoute (`runner-base`, arm64) | ~5.6 GB    |
| redis + caddy + cloudflared            | ~350 MB    |
| `storage.sqlite`                       | vài MB     |
| 14 bản backup                          | ~5 MB      |

Blue/green giữ **2 image** ở trạng thái ổn định (slot đang dừng vẫn tham chiếu
image cũ, nên `docker image prune -f` ở cuối `deploy.sh` chỉ dọn image thật sự
mồ côi). Trong cửa sổ deploy có lúc tồn tại 3 image cùng lúc, tức đỉnh khoảng
**17 GB** chỉ riêng cho image.

Kiểm tra:

```bash
docker system df
df -h /
```

Nếu sắp đầy, hai đường:

1. **Resize boot volume** trong OCI Console (Always Free cho tổng 200 GB block
   storage), rồi trên VPS:

   ```bash
   sudo /usr/libexec/oci-growfs -y
   sudo lvextend -l +100%FREE /dev/ocivolume/root
   sudo xfs_growfs /
   ```

   Không cần reboot, XFS nở online.

2. **Thu hồi `/var/oled`** nếu máy còn LV đó. Image Oracle Linux mặc định cắt
   15 GB cho dữ liệu chẩn đoán (PCP + kdump) mà gần như không bao giờ dùng tới.
   Trên VPS này đã làm rồi: dừng/disable PCP, chuyển `path` trong
   `/etc/kdump.conf` sang `/var/crash`, `umount /var/oled`, bỏ dòng fstab,
   `lvremove ocivolume/oled`, rồi `lvextend` + `xfs_growfs`. Root từ 29.5 GB
   lên 44.5 GB. Bản sao config để ở `/etc/fstab.bak-preoled` và
   `/etc/kdump.conf.bak-preoled`.

---

## 9. Checklist tổng

Cắt dán để tick dần.

```
CHUẨN BỊ
[ ] VPS Ubuntu 22.04+, >= 2 vCPU / 2 GB RAM
[ ] Domain đã trỏ nameserver về Cloudflare
[ ] User SSH có sudo (không dùng root)

VPS
[ ] uname -m  -> ghi lại kết quả: ______________
[ ] /etc/os-release -> họ distro: ______________
[ ] cài docker-ce + docker-compose-plugin + sqlite3 (+ cronie nếu RHEL-family)
[ ] usermod -aG docker <user>
[ ] chạy infra/bootstrap-vps.sh
[ ] điền /opt/omniroute/.app.env (JWT_SECRET, API_KEY_SECRET, INITIAL_PASSWORD, DASHBOARD_HOST, API_HOST, NEXT_PUBLIC_BASE_URL)
[ ] chmod 600 .app.env
[ ] xác nhận UFW chỉ mở 22

SSH CHO CI
[ ] ssh-keygen -t ed25519 -f ~/.ssh/omniroute_ci
[ ] public key -> authorized_keys trên VPS
[ ] ssh-keyscan -> lưu lại cho VPS_KNOWN_HOSTS
[ ] test: ssh -i ~/.ssh/omniroute_ci <user>@<vps> '/opt/omniroute/deploy.sh --status'

CLOUDFLARE
[ ] tạo tunnel, copy token
[ ] public hostname 1: <DASHBOARD_HOST> -> http://caddy:8080 (KHÔNG phải localhost:8080)
[ ] public hostname 2: <API_HOST> -> http://caddy:8080
[ ] Cloudflare Zero Trust Access Application: bảo vệ <DASHBOARD_HOST> (KHÔNG gán lên <API_HOST>)
[ ] echo 'TUNNEL_TOKEN=...' > /opt/omniroute/.tunnel.env
[ ] chmod 600 .tunnel.env
GITHUB
[ ] Environment tên chính xác 'production'
[ ] secret VPS_HOST
[ ] secret VPS_USER
[ ] secret VPS_PORT
[ ] secret VPS_SSH_KEY
[ ] secret VPS_KNOWN_HOSTS
[ ] variable DEPLOY_PLATFORM  (chỉ khi VPS là aarch64)
[ ] variable BUILD_RUNNER     (chỉ khi VPS là aarch64 — đi kèm DEPLOY_PLATFORM)
[ ] variable IMAGE_TARGET     (chỉ khi cần provider web-cookie)

DEPLOY
[ ] chạy thử với skip_deploy=true, build xanh
[ ] image xuất hiện ở github.com/TheDemonTuan?tab=packages
[ ] deploy thật
[ ] deploy.sh --status -> active slot = blue
[ ] curl https://<domain>/api/monitoring/health -> "healthy"
[ ] đăng nhập dashboard, ĐỔI MẬT KHẨU

SAU 24H
[ ] ls /opt/omniroute/backups/  -> có file .gz đầu tiên
[ ] push một commit nhỏ, xác nhận blue -> green và slot cũ đã stop
```

---

## 10. Những gì **không** tự động

Nói trước để không bị bất ngờ.

| Việc                           | Vì sao thủ công                                       |
| ------------------------------ | ----------------------------------------------------- |
| Thêm/sửa biến trong `.app.env` | chứa secret, cố ý không nằm trong git                 |
| Xoay `TUNNEL_TOKEN`            | như trên                                              |
| Nâng cấp Docker / OS trên VPS  | ngoài phạm vi pipeline                                |
| Restore từ backup              | phá huỷ dữ liệu, phải có người quyết định             |
| Duyệt PR sync upstream         | có chủ đích — nguồn mặc định là nhánh đang phát triển |

Ngược lại, những thứ **có** tự động: build image, push GHCR, đồng bộ 4 file hạ
tầng lên VPS, blue/green switch, rollback khi health gate fail, backup hàng đêm,
dọn image cũ, phát hiện nhánh release mới của upstream.

---

## 11. Rủi ro còn lại

- **Vẫn chỉ 1 VPS.** VPS chết / Docker daemon chết / disk chết → mất toàn bộ
  stack. HA thật cần 2 VPS + 2 tunnel, và khi đó SQLite mới thành rào cản kiến
  trúc thực sự.
- **Không có hot standby**, theo thiết kế. Xem [README.md §1.1](./README.md).
- **Nhánh `release/*` có thể đỏ.** Nó là đầu phát triển, không phải bản đã freeze.
- **Chưa có ai chạy thử pipeline này end-to-end.** Máy dev không có Docker/Node
  nên chưa verify được bằng cách chạy thật. Các script mới chỉ pass `bash -n`,
  YAML pass parser, và `sync-upstream.sh --dry-run` là thứ duy nhất đã chạy thật.
  Bước 7.1 (`skip_deploy=true`) tồn tại chính vì lý do đó — hãy làm nó trước.
