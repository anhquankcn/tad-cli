> ## TAD — bản fork nội bộ
>
> Fork riêng của DeepSeek Harness, thêm đăng nhập SSO doanh nghiệp, đăng ký phiên với Arkan Studio, và giao diện terminal tiếng Việt tên TAD.
>
> **Cài lên máy mới.** Cần Node >= 24 — đây là ngưỡng cứng, Node 22 làm build đổ với thông báo lạc hướng.
>
> ```sh
> git clone https://github.com/anhquankcn/tad-cli.git ~/tad-cli
> ~/tad-cli/install/install.sh --skip-clone --dir ~/tad-cli
> ```
>
> Windows dùng `install\install.ps1 -SkipClone -Dir <đường-dẫn>`. Script chạy lại nhiều lần được và không bao giờ ghi credential thật. Chi tiết cùng cách gỡ rối nằm trong `install/README.md`.
>
> **Dùng.**
>
> ```sh
> tad --profile headless "cau hoi"
> SEEKARKAN_LANG=vi tad --profile tui
> tad web
> ```
>
> Trên PowerShell, cú pháp `VAR=value lệnh` không tồn tại — phải đặt biến riêng: `$env:SEEKARKAN_LANG = 'vi'; tad --profile tui`.
>
> Biến ngôn ngữ là `SEEKARKAN_LANG`, không phải `TAD_LANG` dù giao diện mang tên TAD. Không đặt thì giao diện ra tiếng Trung. Biến chỉ có tác dụng với `--profile tui`, và được đọc một lần lúc nạp nên đổi xong phải khởi động lại.
>
> ### Quy trình: dựng một lần, rồi xin lease mỗi phiên
>
> Bốn bước đầu là **dựng một lần cho mỗi máy**; mỗi bước là điều kiện tiên quyết được máy chủ kiểm lại ở bước sau, nên phải theo thứ tự. Máy đã đăng ký rồi thì bỏ qua `session machine`.
>
> ```sh
> tad login
> tad session link
> tad session machine --generate-fingerprint
> tad session workorder --title T --description D --repo R --checklist ...
> ```
>
> Hai bước giữa in ra một id rồi dừng: duyệt binding và duyệt máy dev cần quyền `studio:machines:approve`, và người tự khai không phải người duyệt. Đưa id cho người có quyền chạy `--approve-id <id>`. Machine token do bước duyệt sinh ra và chỉ hiện một lần ở phía họ, nên họ phải chuyển lại cho bạn.
>
> Viết work order sao cho qua được cổng thẩm định — và vì sao hai trong ba bậc rủi ro không chạy được: `install/WORKORDER.md`.
>
> Đang SSH vào máy chạy lệnh thì `tad login` không xong được: listener nằm trên `127.0.0.1` của máy remote, còn trình duyệt ở máy bạn. Dùng device flow, không cần trình duyệt trên máy đó:
>
> ```sh
> tad login --device
> ```
>
> Bước thứ năm là **mỗi phiên**, vì lease chỉ sống 4 giờ (trần 24 giờ):
>
> ```sh
> tad session register --workorder ID --satellite-link UUID --model-ref REF
> ```
>
> Lease hết hạn thì chạy lại đúng lệnh đó trên **cùng work order cũ** — không cần tạo work order mới, không cần thu hồi gì. Lease quá hạn được đánh dấu hết hiệu lực ngay trong giao dịch cấp lease mới.
>
> Có cách gọn hơn, không phải nhớ ba id: `tad workorders` liệt kê work order chạy được, `tad session run <id>` nhận lease cho một cái.
>
> ```sh
> tad workorders
> tad session run <workorder_id>
> ```
>
> Và `tad status` soi cả chuỗi trong một lần chạy — chẩn đoán, đăng nhập, quyền, binding, máy dev, work order, lease, Model Registry — gọi tên mắt đang hỏng kèm lệnh sửa. Chạy nó trước khi đoán bất cứ điều gì.
>
> Mục **CHẨN ĐOÁN** in đầu tiên, trên cả nhánh "chưa đăng nhập", vì lúc không đăng nhập được cũng là lúc cần log nhất. Nó cho đường dẫn `~/.dsh/logs/dsh.log` — nơi plugin ghi thay vì ghi ra màn hình, vì một dòng ghi thô sẽ đè lên khung TUI đang vẽ.
>
> Hướng dẫn từng bước cho máy mới: `arkan-docs/RUNBOOK-DSH-DEV.md`.
>
> ### Chạy phiên có báo tiến độ
>
> Lease id phải nằm trong môi trường **trước khi** gọi launcher:
>
> ```powershell
> $env:ARKAN_LEASE_ID     = '<lease-id>'
> $env:ARKAN_WORKORDER_ID = '<workorder-id>'
> & "$env:USERPROFILE\.dsh\arkan-dsh.cmd" --profile headless "cau hoi"
> ```
>
> Đừng đặt biến bằng `cmd /c "set VAR=... && arkan-dsh.cmd"`. Giá trị đó **không tới được tiến trình**, file `~/.dsh/arkan-env.cmd` sẽ thắng, và phiên chạy bằng lease cũ mà không có dấu hiệu gì — triệu chứng giống hệt lease hỏng.
>
> ### Kiểm phiên có được theo dõi không
>
> Plugin relay tự nói ra tình trạng ở stderr. Đọc dòng tổng kết lúc đóng:
>
> ```text
> [dsh-arkan-relay] §8c OK lần đầu ('session_started') → ...
> [dsh-arkan-relay] đóng relay — đã gửi 2, lỗi 0, bỏ 0
> ```
>
> `đã gửi N, lỗi 0` là xong. `đã gửi 0, lỗi N` là máy chủ từ chối, và dòng ngay phía trên nói rõ vì sao — lease hết hạn, fingerprint lệch, máy không ACTIVE, binding bị thu hồi, và khoảng chục nguyên nhân khác đều có câu chữ riêng. Không có dòng `dsh-arkan-relay` nào thì plugin chưa được nạp: kiểm mục `arkan-session-relay` trong `~/.dsh/profiles/<profile>/cordis.patch.yml`.
>
> Sự kiện lifecycle (`session_started`, `session_ended`) được gửi lại tối đa 3 lần khi lỗi mạng, 5xx hay 429; lỗi 4xx thì bỏ ngay vì gửi lại cũng chỉ nhận đúng câu từ chối đó. Sự kiện tiến độ không gửi lại và vẫn gộp theo nhịp tối thiểu 2 giây.
>
> Quy trình đầy đủ, các cổng quản trị và rủi ro đã biết nằm trong `arkan-docs/CR-TAD-001-cli-sop.md`.
>
> **Cài bằng npm được không?** Upstream thì được: `npm install -g @deepseek-ai/dsh`. Fork này thì chưa, vì ba lý do có thật: `apps/cli/lib` không nằm trong git và không có script `prepare` nên cài từ URL git sẽ không có gì để chạy; 59 trên 62 dependency của `apps/cli` là `workspace:*` nên npm không dựng lại được từ bản checkout; và publish thì cần registry riêng, vì đẩy lên npm công khai sẽ lộ endpoint SSO và Arkan nội bộ.

---

# DeepSeek Harness

English | [中文](README.zh.md)

DeepSeek Harness (`tad`) is an open-source agent harness developed by [DeepSeek AI](https://deepseek.com).

It uses an architecture where **everything is a plugin**, and is powered by [Cordis](https://github.com/cordiverse/cordis), whose design is described in [_A Programming Paradigm for Spatiotemporal Composability_](https://github.com/cordiverse/paper).

## Developer preview

DeepSeek Harness is currently in _developer preview_ and is iterating rapidly. **THERE WILL BE COMPATIBILITY-BREAKING CHANGES.**

## Run

### Run from `npm`

Install `Node.js`, then run:

```sh
npx @deepseek-ai/dsh web
```

The command starts the Web UI at `http://127.0.0.1:3080` by default and opens it in the default browser for a local launch. An SSH launch only prints the host URL because the SSH client or editor owns the local forwarded address. Pass `--no-open` to run the server without opening a browser. See [Web UI guide](docs/user/guide/index.md).

### Run from source

To run from a repository checkout:

```sh
git clone https://github.com/deepseek-ai/deepseek-harness.git
cd deepseek-harness
pnpm install
pnpm run build
pnpm tad web
```

`pnpm run build` prepares the repository artifacts. `pnpm tad web` uses those built artifacts without rebuilding.

## Community and support

- Feel free to submit feedback or bug reports through [GitHub Discussions](https://github.com/deepseek-ai/deepseek-harness/discussions).
- Add the [`dsh-plugin`](https://github.com/topics/dsh-plugin) topic to your plugin repository for discoverability.
- Join <a href="https://discord.gg/Ycq5dCaS4">DeepSeek Harness Discord community</a>.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Development

Start with the [development guide](docs/development.md) and [architecture documentation](docs/architecture.md).

For agents, follow [AGENTS.md](AGENTS.md).

## License

[MIT](LICENSE)

Third-party dependencies and their licenses are disclosed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
