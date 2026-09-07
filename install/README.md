# Cài TAD lên máy mới

```sh
# Linux / macOS
git clone https://github.com/anhquankcn/tad-cli.git ~/tad-cli
~/tad-cli/install/install.sh --skip-clone --dir ~/tad-cli
```

```powershell
# Windows
git clone https://github.com/anhquankcn/tad-cli.git $HOME\tad-cli
& $HOME\arkan-dsh\install\install.ps1 -SkipClone -Dir $HOME\arkan-dsh
```

Chạy lại nhiều lần được: bước nào đã xong thì bỏ qua, file cấu hình đã có thì
sao lưu trước khi ghi đè. Script **không bao giờ** ghi credential thật.

## Yêu cầu

| | |
|---|---|
| Node | **>= 24** — ngưỡng cứng, xem dưới |
| git | bản nào cũng được |
| corepack | đi kèm Node |

**Vì sao Node 24 là bắt buộc.** Trên Node 22, `tsdown` rơi sang loader `unrun`;
loader đó dịch config xuống `node_modules/.unrun/` khiến `REPOSITORY_ROOT`
(suy từ `import.meta.url`) trỏ sai chỗ, và build đổ với thông báo hoàn toàn lạc
hướng:

```
tsdown: no packages/*/*/package.json declares the name @deepseek-ai/dsh-api-remotes
```

Package đó vẫn nằm đúng chỗ. Cài `unrun` **không** cứu được. Đổi sang Node 24 là
hết.

Sau mỗi lần `nvm use` sang bản Node khác, phải `corepack enable pnpm` lại — nó
gắn theo từng bản Node.

## Script làm gì

1. Kiểm git, Node >= 24, corepack/pnpm
2. Clone (hoặc dùng kho có sẵn), `pnpm install --frozen-lockfile`, `pnpm build`
3. Kiểm bản vá `pi-tui` đã áp chưa
4. Cài lệnh `tad` (Linux: `~/.local/bin`; Windows: `%APPDATA%\npm`, cả `.cmd` lẫn
   shim `sh` cho Git Bash)
5. Dựng profile `headless` và `tui`, `pnpm install` trong từng cái (phải là
   pnpm: `link:` là cú pháp pnpm, npm từ chối với `EUNSUPPORTEDPROTOCOL`)
6. Tạo `~/.dsh/.credentials.yaml` rỗng nếu chưa có
7. Kiểm `tad --version` và compose được cả hai profile

## Hai việc script KHÔNG làm

Cả hai đều cần quyết định của người cài, nên script không tự đoán hộ.

### 1. Route model

Chưa có route thì `tad` không gọi được model nào. Khuôn tối thiểu, ghi vào
`~/.dsh/profiles/<tên>/cordis.patch.yml`:

```yaml
- id: llm-pi-ai
  config:
    providers:
      vertex:
        displayName: Vertex Key
        apiKeyEnv: VERTEX_KEY_API_KEY
        api: openai-completions
        baseURL: https://<cong-model-cua-ban>/api/v1
        compat:
          supportsDeveloperRole: false
          maxTokensField: max_tokens
        models:
          - id: aws/claude-sonnet-5-medium
            name: Claude Sonnet 5
            contextWindow: 1000000
            maxTokens: 32768

- id: agent-default-model
  config:
    provider: vertex
    model: aws/claude-sonnet-5-medium
```

Mỗi `id` **chỉ được xuất hiện một lần** trong file. Hai khối cùng
`- id: llm-pi-ai` thì khối sau **ghi đè** khối trước chứ không gộp — muốn thêm
provider thì gộp vào cùng một khối.

Ba ref đang ACTIVE trong Model Registry, tức dùng được với lease:
`aws/claude-sonnet-5-medium`, `aws/claude-opus-5-medium`, `aws/claude-haiku-4-5`.
Riêng `claude-haiku-4-5` **không có hậu tố** effort tier; thêm `-medium` vào nó
sẽ ra lỗi không tìm thấy model.

### 2. Credential

Điền khoá vào `~/.dsh/.credentials.yaml`, dưới khối `refs:`, thụt hai dấu cách:

```yaml
version: 1
refs:
  VERTEX_KEY_API_KEY: <khoá của bạn>
```

## Chạy

```sh
tad --profile headless "câu hỏi"          # một tác vụ rồi thoát
SEEKARKAN_LANG=vi tad --profile tui       # giao diện terminal (sh)
tad web                                    # giao diện trình duyệt
```

Trên PowerShell **không có** cú pháp `VAR=value lệnh`; phải đặt biến riêng:

```powershell
$env:SEEKARKAN_LANG = 'vi'
tad --profile tui
```

Biến ngôn ngữ là `SEEKARKAN_LANG` (hoặc `SEEKTTY_LANG` cho tương thích ngược) —
**không phải** `TAD_LANG`, dù giao diện mang tên TAD. Không đặt thì giao diện ra
**tiếng Trung**, không phải tiếng Anh.

## Cập nhật về sau

```sh
cd ~/tad-cli && git pull
bash install/install.sh --skip-clone --dir ~/tad-cli
```

Chạy qua `bash` cho chắc: bản clone trước 2026-09-06 nhận `install.sh` với mode
`100644` và gọi trực tiếp sẽ ra `Permission denied`.

## Xin lease để chạy có báo tiến độ

Phiên báo tiến độ lên Console cần một lease, và lease treo trên một work order
đã qua Value & Risk Gate. Cách viết work order qua được cổng — và ba bậc rủi ro,
trong đó hai bậc không chạy được — nằm trong `install/WORKORDER.md`.

## Log của harness

Plugin ghi chẩn đoán vào `~/.dsh/logs/dsh.log`, không ghi ra màn hình — một dòng
ghi thô sẽ đè lên khung TUI đang vẽ. File tự xoay vòng một thế hệ khi quá 4MB.

`tad status` in đường dẫn đó ở mục **CHẨN ĐOÁN**, ngay đầu báo cáo. Nếu mục đó
báo file "chưa có" thì bản tad của bạn cũ hơn 2026-09-06: khi ấy harness chưa
đăng ký sink nào, nên mọi thứ plugin ghi qua `ctx.logger` đều bị vứt.

## Kiểm tra khi có trục trặc

```sh
tad status                           # chuỗi quản trị + đường dẫn log
tad --profile tui --dump-config      # xem cây plugin đã compose
ls node_modules/.pnpm | grep pi-tui  # phải thấy bản có hậu tố hash
```

Thấy `@mariozechner+pi-tui@0.73.1` trơn (không hậu tố) là bản vá chưa áp, và TUI
sẽ xoá trắng màn hình mỗi lần vẽ lại. Bản vá khai ở `pnpm-workspace.yaml` **gốc**
— file `pnpm-workspace.yaml` lồng trong `tui/seekarkan/` bị pnpm bỏ qua.

Sửa mã nguồn xong phải `pnpm build` thì lệnh `tad` mới đổi — shim trỏ vào bản đã
build. Muốn thấy thay đổi ngay thì chạy `pnpm tad --profile ...` trong kho.
