> ## TAD — 增加企业 SSO 与会话跟踪的分支
>
> DeepSeek Harness 的分支，增加三样东西：通过 Keycloak 的 SSO 登录、向治理服务端（Arkan Studio）注册工作会话，以及名为 TAD 的越南语终端界面。
>
> **本发行版不附带任何默认 endpoint。** SSO realm 与 Studio 地址必须由你自己配置——它们指向某个组织的专有基础设施，而一个错误但存在的默认值会以令人费解的网络错误失败，而不是提示缺少配置。
>
> ```sh
> export ARKAN_AUTHORITY=https://sso.example.com/realms/<realm>
> export ARKAN_STUDIO_BASE_URL=https://studio.example.com
> ```
>
> 二者缺一时，命令会指名缺少的变量，而不会去发起网络调用。
>
> **安装。** 需要 Node >= 24，这是硬性要求：Node 22 会让构建失败并给出误导性的报错。
>
> ```sh
> git clone <repo-url> ~/tad-cli
> ~/tad-cli/install/install.sh --skip-clone --dir ~/tad-cli
> ```
>
> Windows 使用 `install\install.ps1 -SkipClone -Dir <路径>`。脚本可重复运行，且从不写入真实凭据。详细说明与排错见 `install/README.md`。
>
> **使用。**
>
> ```sh
> dsh --profile headless "cau hoi"
> SEEKARKAN_LANG=vi dsh --profile tui
> dsh web
> ```
>
> PowerShell 没有 `VAR=value 命令` 这种写法，需要单独设置变量：`$env:SEEKARKAN_LANG = 'vi'; dsh --profile tui`。
>
> 语言变量是 `SEEKARKAN_LANG`，不是 `TAD_LANG`，尽管界面名为 TAD。不设置则界面显示中文。该变量只对 `--profile tui` 生效，且在加载时读取一次，改动后须重启。
>
> **登录与领取任务。** 前四步是每台机器一次性搭建；每一步都是下一步的前置条件，由服务端重新校验，因此必须按顺序执行。
>
> ```sh
> dsh login
> dsh session link --approve
> dsh session machine --generate-fingerprint --approve
> dsh session workorder --title T --description D --repo R --checklist ...
> ```
>
> 之后每个会话只需两条命令：
>
> ```sh
> dsh workorders
> dsh session run <workorder_id>
> ```
>
> `dsh status` 一次检查链条全部六个环节，指名当前断掉的那一环并给出修复命令——在猜测之前先跑它。
>
> **与上游的关系。** 核心是 DeepSeek AI 的 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)，MIT 许可，保持原样。新增部分位于 `apps/cli/src/arkan/`（SSO 与会话）、`tui/seekarkan/`（界面）与 `install/`。若你只需要原版 harness，请直接使用上游：`npx @deepseek-ai/dsh web`。
>
> **能用 npm 安装吗？** 上游可以。本分支暂时不行：`apps/cli/lib` 未纳入 git 且没有 `prepare` 脚本，从 git URL 安装后无可执行内容；`apps/cli` 的 62 个依赖中有 59 个是 `workspace:*`，npm 无法从 checkout 还原。请按上面的安装说明使用 `pnpm`。

---

# DeepSeek Harness

[English](README.md) | 中文

DeepSeek Harness（`dsh`）是由 [DeepSeek AI](https://deepseek.com) 开发的开源 agent harness（智能体框架）。

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
pnpm dsh web
```

`pnpm run build` 会准备仓库产物。`pnpm dsh web` 会直接使用这些已构建产物，不会重新构建。

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
