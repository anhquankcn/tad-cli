> ## TAD — 内部分支
>
> DeepSeek Harness 的内部分支，增加了企业 SSO 登录、Arkan Studio 会话注册，以及名为 TAD 的越南语终端界面。
>
> **在新机器上安装。** 需要 Node >= 24，这是硬性要求：Node 22 会让构建失败并给出误导性的报错。
>
> ```sh
> git clone https://github.com/anhquankcn/tad-cli.git ~/tad-cli
> ~/tad-cli/install/install.sh --skip-clone --dir ~/tad-cli
> ```
>
> Windows 使用 `install\install.ps1 -SkipClone -Dir <路径>`。脚本可重复运行，且从不写入真实凭据。详细说明与排错见 `install/README.md`。
>
> **使用。**
>
> ```sh
> tad --profile headless "cau hoi"
> SEEKARKAN_LANG=vi tad --profile tui
> tad web
> ```
>
> PowerShell 没有 `VAR=value 命令` 这种写法，需要单独设置变量：`$env:SEEKARKAN_LANG = 'vi'; tad --profile tui`。
>
> 语言变量是 `SEEKARKAN_LANG`，不是 `TAD_LANG`，尽管界面名为 TAD。不设置则界面显示中文。该变量只对 `--profile tui` 生效，且在加载时读取一次，改动后须重启。
>
> ### 流程：一次性搭建，然后每个会话申请 lease
>
> 前四步是**每台机器一次性搭建**；每一步都是下一步的前置条件，由服务端重新校验，因此必须按顺序执行。机器已注册则可跳过 `session machine`。
>
> ```sh
> tad login
> tad session link
> tad session machine --generate-fingerprint
> tad session workorder --title T --description D --repo R --checklist ...
> ```
>
> 中间两步只会打印一个 id 然后停下：审批绑定与审批开发机需要 `studio:machines:approve` 权限，而自行申报的人不应是审批的人。把 id 交给有权限的人执行 `--approve-id <id>`。machine token 由审批那一步生成且只显示一次，显示在他们那一侧，因此需要他们回传给你。
>
> 如何写出能通过价值与风险闸门的 work order，以及为什么三个风险等级中有两个无法运行：`install/WORKORDER.md`。
>
> 若你通过 SSH 登录到运行命令的机器，`tad login` 无法完成：监听器位于远程机器的 `127.0.0.1`，而浏览器在你本地。改用 device flow，无需该机器上有浏览器：
>
> ```sh
> tad login --device
> ```
>
> 第五步是**每个会话**执行，因为 lease 仅存活 4 小时（上限 24 小时）：
>
> ```sh
> tad session register --workorder ID --satellite-link UUID --model-ref REF
> ```
>
> lease 过期后，在**同一个 work order** 上重跑该命令即可，无需新建 work order，也无需手动吊销。已过期的 lease 会在签发新 lease 的同一事务内被标记失效。
>
> 还有更省事的方式，不必记住三个 id：`tad workorders` 列出可运行的 work order，`tad session run <id>` 为其中一个取得 lease。
>
> ```sh
> tad workorders
> tad session run <workorder_id>
> ```
>
> 而 `tad status` 一次检查整条链——诊断、登录、权限、绑定、开发机、work order、lease、Model Registry——指名当前断掉的那一环并给出修复命令。在猜测之前先跑它。

> **诊断**一节最先打印，位于"未登录"短路之前，因为登录不上的时候恰恰最需要日志。它给出 `~/.dsh/logs/dsh.log` 的路径——插件写日志的地方，而不是写到屏幕上，因为一行裸写会覆盖正在绘制的 TUI 画面。
>
> 新机器的分步指南：`arkan-docs/RUNBOOK-DSH-DEV.md`。
>
> ### 运行带进度上报的会话
>
> lease id 必须在调用启动器**之前**进入环境变量：
>
> ```powershell
> $env:ARKAN_LEASE_ID     = '<lease-id>'
> $env:ARKAN_WORKORDER_ID = '<workorder-id>'
> & "$env:USERPROFILE\.dsh\arkan-dsh.cmd" --profile headless "cau hoi"
> ```
>
> 不要用 `cmd /c "set VAR=... && arkan-dsh.cmd"` 设置变量。该值**传不到进程里**，`~/.dsh/arkan-env.cmd` 会覆盖它，会话将静默地使用旧 lease——症状与 lease 失效完全一样。
>
> ### 确认会话是否被跟踪
>
> relay 插件会在 stderr 自报状态。看关闭时的汇总行：
>
> ```text
> [dsh-arkan-relay] §8c OK lần đầu ('session_started') → ...
> [dsh-arkan-relay] đóng relay — đã gửi 2, lỗi 0, bỏ 0
> ```
>
> `đã gửi N, lỗi 0` 表示成功。`đã gửi 0, lỗi N` 表示服务端拒绝，紧邻的上一行会说明原因——lease 过期、指纹不符、机器非 ACTIVE、binding 已吊销等十余种原因各有措辞。若完全没有 `dsh-arkan-relay` 行，说明插件未加载：检查 `~/.dsh/profiles/<profile>/cordis.patch.yml` 中的 `arkan-session-relay` 条目。
>
> 生命周期事件（`session_started`、`session_ended`）在网络错误、5xx 或 429 时最多重发 3 次；4xx 立即放弃，因为重发只会得到同一句拒绝。进度事件不重发，仍按至少 2 秒的节流合并。
>
> 完整流程、治理关卡与已知风险见 `arkan-docs/CR-TAD-001-cli-sop.md`。
>
> **能用 npm 安装吗？** 上游可以：`npm install -g @deepseek-ai/dsh`。本分支暂时不行，原因有三：`apps/cli/lib` 未纳入 git 且没有 `prepare` 脚本，从 git URL 安装后无可执行内容；`apps/cli` 的 62 个依赖中有 59 个是 `workspace:*`，npm 无法从 checkout 还原；发布还需要私有 registry，公开 npm 会暴露内部 SSO 与 Arkan 端点。

---

# DeepSeek Harness

[English](README.md) | 中文

DeepSeek Harness（`tad`）是由 [DeepSeek AI](https://deepseek.com) 开发的开源 agent harness（智能体框架）。

它采用**一切皆插件**的架构，并由 [Cordis](https://github.com/cordiverse/cordis) 驱动，其设计参见论文 [_A Programming Paradigm for Spatiotemporal Composability_](https://github.com/cordiverse/paper)。

## 开发者预览

DeepSeek Harness 目前处于 _开发者预览_ 阶段，正在快速迭代。**未来将出现破坏兼容性的变更。**

<a id="run"></a>

## 运行

### 通过 `npm` 运行

安装 `Node.js`，然后运行：

```sh
npx @deepseek-ai/dsh web
```

该命令默认会在 `http://127.0.0.1:3080` 启动 Web UI，本机启动时还会用默认浏览器打开页面。通过 SSH 启动时只打印宿主机 URL，因为本地转发地址由 SSH 客户端或编辑器持有。传入 `--no-open` 可仅运行服务器而不打开浏览器。详见 [Web UI 指南](docs/user/guide/index.zh.md)。

<a id="run-from-source"></a>

### 从源码运行

如需从仓库源码运行：

```sh
git clone https://github.com/deepseek-ai/deepseek-harness.git
cd deepseek-harness
pnpm install
pnpm run build
pnpm tad web
```

`pnpm run build` 会准备仓库产物。`pnpm tad web` 会直接使用这些已构建产物，不会重新构建。

## 社区与支持

- 欢迎通过 [GitHub Discussions](https://github.com/deepseek-ai/deepseek-harness/discussions) 提交反馈或 bug 报告。
- 为你的插件仓库添加 [`dsh-plugin`](https://github.com/topics/dsh-plugin) 话题，便于被发现。
- 欢迎加入 DeepSeek Harness 企微群：扫码添加企微小助手并填写入群问卷，完成后小助手会邀请你入群。

<table>
  <thead>
    <tr>
      <th align="center">企微小助手</th>
      <th align="center">入群问卷</th>
      <th align="center">微信公众号</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td align="center"><img src="https://cdn.deepseek.com/harness/readme/community-wecom-assistant.png" alt="DeepSeek Harness 企微小助手二维码" width="180" height="180"></td>
      <td align="center"><a href="https://trtgsjkv6r.feishu.cn/share/base/form/shrcnIt5twSVdLGD52KJBckGCgg"><img src="https://cdn.deepseek.com/harness/readme/community-wecom-survey.png" alt="DeepSeek Harness 入群问卷二维码" width="180" height="180"></a></td>
      <td align="center"><img src="https://cdn.deepseek.com/harness/readme/community-wechat-official-account.png" alt="DeepSeek Harness 团队微信公众号二维码" width="180" height="180"></td>
    </tr>
  </tbody>
</table>

## 参与贡献

参见 [CONTRIBUTING.md](CONTRIBUTING.zh.md)。

## 开发

请先阅读[开发指南](docs/development.zh.md)与[架构文档](docs/architecture.zh.md)。

面向 agent：请遵循 [AGENTS.md](AGENTS.md)。

## 许可证

[MIT](LICENSE)

第三方依赖及其许可证见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
