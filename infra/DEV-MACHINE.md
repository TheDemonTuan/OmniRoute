# Bắt đầu trên một máy dev mới

Máy trắng, chưa có gì. Cần làm gì để tiếp tục công việc.

Liên quan: [SETUP.md](./SETUP.md) (dựng hạ tầng lần đầu) · [README.md](./README.md) (kiến trúc)

---

## 0. Bạn cần cài gì?

Ít hơn bạn tưởng. **Build chạy trên GitHub Actions, không chạy trên máy bạn.**

| Công cụ               | Bắt buộc?                            | Để làm gì                                       |
| --------------------- | ------------------------------------ | ----------------------------------------------- |
| **Git**               | ✅ bắt buộc                          | clone, sync upstream, push                      |
| **GitHub CLI (`gh`)** | khuyến nghị                          | chạy workflow, xem log build, không phải mở web |
| Node.js 24            | ❌ chỉ khi muốn chạy OmniRoute local | xem §4                                          |
| Docker                | ❌ không cần                         | build ảnh diễn ra trên runner                   |

Nếu bạn chỉ định **kéo code mới từ upstream rồi deploy**, chỉ cần Git. Xong §1–§3 là làm việc được.

---

## 1. Cài công cụ

### Windows

```powershell
winget install --id Git.Git -e
winget install --id GitHub.cli -e
```

### macOS

```bash
brew install git gh
```

### Ubuntu / Debian

```bash
sudo apt update && sudo apt install -y git
# gh: https://github.com/cli/cli/blob/trunk/docs/install_linux.md
sudo apt install -y gh
```

Đăng nhập GitHub:

```bash
gh auth login
```

Chọn `HTTPS` và `Login with a web browser`. Việc này cũng cấu hình luôn Git
credential helper, nên `git push` sau đó không hỏi mật khẩu.

> Nếu sau này cần push file trong `.github/workflows/`, token phải có scope
> `workflow`. Kiểm tra bằng `gh auth status`; thiếu thì
> `gh auth refresh -s workflow`.

---

## 2. Clone

```bash
git clone --filter=blob:none https://github.com/TheDemonTuan/OmniRoute.git
cd OmniRoute
```

Hai điểm cần biết:

**`--filter=blob:none`** = blobless clone. Repo này có lịch sử rất nặng
(GitHub báo ~424 MB). Blobless clone chỉ tải commit + tree, blob được tải theo
nhu cầu khi checkout — `.git` còn khoảng 65 MB và clone nhanh hơn nhiều. Mọi
thao tác git vẫn hoạt động bình thường, chỉ cần có mạng lần đầu chạm tới file cũ.

**Không cần `-b prod`.** Default branch của fork đã được đổi thành `prod`, nên
clone xong bạn đứng sẵn trên nhánh đúng. Kiểm tra:

```bash
git branch --show-current    # -> prod
```

---

## 3. Kiểm tra và bắt đầu làm việc

```bash
bash infra/sync-upstream.sh --dry-run
```

Lần chạy đầu trên máy mới, script tự thêm remote `upstream` rồi fetch. Kết quả
mong đợi là một trong hai:

```
==> No 'upstream' remote; adding https://github.com/diegosouzapw/OmniRoute.git
==> Fetching upstream
==> Auto-selected newest upstream release branch: release/v3.8.50
==> prod is 0 commit(s) behind upstream/release/v3.8.50
Already up to date. Nothing to do.
```

hoặc, nếu upstream đã có code mới:

```
==> prod is 37 commit(s) behind upstream/release/v3.8.51
--- upstream commits that would land (newest 25) ---
...
version: 3.8.50 -> 3.8.51
(--dry-run: stopping here, nothing was merged)
```

Xác nhận remote:

```bash
git remote -v
# origin    https://github.com/TheDemonTuan/OmniRoute.git   (fetch/push)
# upstream  https://github.com/diegosouzapw/OmniRoute.git   (fetch/push)
```

> `upstream` chỉ để đọc. Đừng bao giờ `git push upstream` — bạn không có quyền,
> và nếu có cũng không nên.

**Đến đây là xong.** Máy này đã đủ để làm mọi việc thường ngày.

### Vòng lặp hàng ngày

```bash
# kéo về những gì máy khác / PR sync đã merge
git pull

# lấy code mới từ upstream
bash infra/sync-upstream.sh --dry-run    # xem trước
bash infra/sync-upstream.sh              # merge, chưa push
git push origin prod                      # -> build + deploy

# sửa code của chính bạn
git commit -am "..."
git push origin prod
```

Theo dõi build mà không cần mở web:

```bash
gh run watch --repo TheDemonTuan/OmniRoute
gh run list  --repo TheDemonTuan/OmniRoute --limit 5
gh run view --log-failed --repo TheDemonTuan/OmniRoute
```

⚠️ **Mỗi lần `git push origin prod` là một lần deploy thật.** Chưa muốn deploy
thì làm việc trên nhánh khác rồi mở PR về `prod`.

---

## 4. (Tuỳ chọn) Chạy OmniRoute ngay trên máy dev

Chỉ cần khi bạn muốn sửa code và xem kết quả. Để kéo code + deploy thì **không cần**.

### 4.1 Node.js

Yêu cầu: `>=22.22.3 <23`, hoặc `>=24.0.0 <27`. Khuyến nghị **24 LTS**
(`.node-version` trong repo ghi `24`).

```bash
# nvm (macOS/Linux)
nvm install 24 && nvm use 24

# nvm-windows
nvm install 24 && nvm use 24
```

### 4.2 Cài dependency

```bash
npm install
```

Repo có 77 dependency + 53 devDependency + 9 optional, lockfile 1.4 MB — lần
cài đầu khá lâu và `node_modules` rất nặng.

Có native module (`better-sqlite3`) nên cần toolchain biên dịch:

| OS      | Cần                                                 |
| ------- | --------------------------------------------------- |
| Windows | Visual Studio Build Tools (C++ workload) + Python 3 |
| macOS   | `xcode-select --install`                            |
| Ubuntu  | `sudo apt install -y python3 make g++`              |

Kiểm tra native module đã dựng được:

```bash
node -e "require('better-sqlite3')"
```

Nếu ra `MODULE_NOT_FOUND` (hay gặp với npm v11 / Node 24, vì npm chặn
postinstall script):

```bash
npm approve-scripts better-sqlite3 && npm install
```

> Không dựng được cũng không sao — OmniRoute có chuỗi fallback 5 bước
> (`docs/ops/SQLITE_RUNTIME.md`): sau `better-sqlite3` là bản cài runtime, rồi
> `node:sqlite` (stdlib Node 22.5+), cuối cùng là `sql.js` WASM. App vẫn boot,
> chỉ chậm hơn.

### 4.3 File `.env`

```bash
cp .env.example .env
echo "JWT_SECRET=$(openssl rand -base64 48)" >> .env
echo "API_KEY_SECRET=$(openssl rand -hex 32)" >> .env
```

Dùng secret **riêng cho local**. Đừng chép `.app.env` của production về máy dev.

`.env` đã nằm trong `.gitignore` của upstream — nhưng vẫn nên kiểm tra
`git status` trước khi commit.

### 4.4 Chạy

```bash
npm run dev
```

- Dashboard: `http://localhost:20128/dashboard`
- API: `http://localhost:20128/v1`

Lệnh khác:

```bash
npm run build          # production build
npm run lint
npm test               # bộ test rất lớn và lâu
```

> Đây là môi trường dev của **upstream**, không phải bản production của bạn.
> Nó dùng `.env` và DB SQLite local, hoàn toàn tách khỏi VPS.

---

## 5. Nếu máy cũ vẫn còn repo

Không cần clone lại. Chỉ cần đồng bộ:

```bash
cd <thư-mục-repo>
git checkout prod
git pull
```

Các máy đã dựng trước đó (`D:\omniroute\OmniRoute` trên Windows,
`/media/tuannv/Projects/OmniRoute` trên Linux Mint) đều đã có sẵn cả hai remote
nên chạy được ngay.

---

## 6. Bảng tra nhanh

| Tình huống              | Lệnh                                                                                |
| ----------------------- | ----------------------------------------------------------------------------------- |
| Máy mới, chỉ để deploy  | `git clone --filter=blob:none <fork-url>` → xong                                    |
| Thiếu remote upstream   | tự thêm khi chạy `sync-upstream.sh`                                                 |
| Xem upstream có gì mới  | `bash infra/sync-upstream.sh --dry-run`                                             |
| Lấy code mới + deploy   | `bash infra/sync-upstream.sh --push`                                                |
| Đổi nguồn theo dõi      | `--ref main` \| `--ref v3.8.50`                                                     |
| Sync upstream an toàn   | `bash infra/sync-upstream.sh` (xem trước: `--dry-run`)                              |
| Build thử, không deploy | `gh workflow run prod-deploy.yml --repo TheDemonTuan/OmniRoute -f skip_deploy=true` |
| Xem build hỏng ở đâu    | `gh run view --log-failed --repo TheDemonTuan/OmniRoute`                            |
| Rollback production     | `ssh <user>@<vps> '/opt/omniroute/deploy.sh --rollback'`                            |
| Xem đang chạy slot nào  | `ssh <user>@<vps> '/opt/omniroute/deploy.sh --status'`                              |

---

## 7. Sự thật quan trọng nhất

Bạn **không cần máy dev** để vận hành hệ thống này.

Workflow `Sync Upstream` chạy 04:00 UTC thứ Hai hàng tuần, tự phát hiện nhánh
`release/v*` mới nhất của upstream và mở PR về `prod`. Bấm **Merge** trên giao
diện web GitHub — kể cả từ điện thoại — là deploy chạy.

Máy dev chỉ cần khi bạn muốn **sửa code của chính mình**, hoặc muốn xem kỹ diff
trước khi merge.
