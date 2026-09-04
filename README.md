> ## TAD — bản fork thêm SSO doanh nghiệp và theo dõi phiên
>
> Fork của DeepSeek Harness, thêm ba thứ: đăng nhập SSO qua Keycloak, đăng ký phiên làm việc với một máy chủ quản trị (Arkan Studio), và giao diện terminal tiếng Việt tên TAD.
>
> **Bản phát hành này KHÔNG kèm endpoint mặc định.** Realm SSO và địa chỉ Studio phải do bạn cấu hình — chúng trỏ tới hạ tầng của một tổ chức cụ thể, và một giá trị mặc định sai sẽ hỏng dưới dạng lỗi mạng khó hiểu thay vì báo thiếu cấu hình.
>
> ```sh
> export ARKAN_AUTHORITY=https://sso.example.com/realms/<realm>
> export ARKAN_STUDIO_BASE_URL=https://studio.example.com
> ```
>
> Thiếu một trong hai thì lệnh báo đúng biến còn thiếu chứ không thử gọi mạng.
>
> **Cài.** Cần Node >= 24 — đây là ngưỡng cứng, Node 22 làm build đổ với thông báo lạc hướng.
>
> ```sh
> git clone <repo-url> ~/tad-cli
> ~/tad-cli/install/install.sh --skip-clone --dir ~/tad-cli
> ```
>
> Windows dùng `install\install.ps1 -SkipClone -Dir <đường-dẫn>`. Script chạy lại nhiều lần được và không bao giờ ghi credential thật. Chi tiết cùng cách gỡ rối nằm trong `install/README.md`.
>
> **Dùng.**
>
> ```sh
> dsh --profile headless "cau hoi"
> SEEKARKAN_LANG=vi dsh --profile tui
> dsh web
> ```
>
> Trên PowerShell, cú pháp `VAR=value lệnh` không tồn tại — phải đặt biến riêng: `$env:SEEKARKAN_LANG = 'vi'; dsh --profile tui`.
>
> Biến ngôn ngữ là `SEEKARKAN_LANG`, không phải `TAD_LANG` dù giao diện mang tên TAD. Không đặt thì giao diện ra tiếng Trung. Biến chỉ có tác dụng với `--profile tui`, và được đọc một lần lúc nạp nên đổi xong phải khởi động lại.
>
> **Đăng nhập và nhận việc.** Bốn bước đầu là dựng một lần cho mỗi máy; mỗi bước là điều kiện tiên quyết được máy chủ kiểm lại ở bước sau, nên phải theo thứ tự.
>
> ```sh
> dsh login
> dsh session link --approve
> dsh session machine --generate-fingerprint --approve
> dsh session workorder --title T --description D --repo R --checklist ...
> ```
>
> Sau đó mỗi phiên chỉ cần hai lệnh:
>
> ```sh
> dsh workorders
> dsh session run <workorder_id>
> ```
>
> `dsh status` soi cả sáu mắt của chuỗi trong một lần chạy và gọi tên mắt đang hỏng kèm lệnh sửa — chạy nó trước khi đoán bất cứ điều gì.
>
> **Quan hệ với bản gốc.** Phần lõi là [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) của DeepSeek AI, giấy phép MIT, giữ nguyên. Phần thêm nằm ở `apps/cli/src/arkan/` (SSO + phiên), `tui/seekarkan/` (giao diện) và `install/`. Nếu bạn chỉ cần bản harness gốc thì dùng thẳng upstream: `npx @deepseek-ai/dsh web`.
>
> **Cài bằng npm được không?** Upstream thì được. Fork này thì chưa: `apps/cli/lib` không nằm trong git và không có script `prepare` nên cài từ URL git sẽ không có gì để chạy, và 59 trên 62 dependency của `apps/cli` là `workspace:*` nên npm không dựng lại được từ bản checkout. Dùng `pnpm` theo hướng dẫn cài ở trên.

---

# DeepSeek Harness

English | [中文](README.zh.md)

DeepSeek Harness (`dsh`) is an open-source agent harness developed by [DeepSeek AI](https://deepseek.com).

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
pnpm dsh web
```

`pnpm run build` prepares the repository artifacts. `pnpm dsh web` uses those built artifacts without rebuilding.

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
