# dsh-repo-sync · 仓库同步

一个 DeepSeek Harness 插件：**把工作区里的 git 仓库定时提交并推送到远程。**

## 安装

```bash
dsh plugin --profile desktop add /path/to/dsh-repo-sync
```

装完重启一次 dsh，设置页里会多出「仓库同步」一页。

## 它不做什么（重要）

| 不做 | 为什么 |
| --- | --- |
| 不自动 `git init` | 工作区任何目录都会变仓库，包括你不想要的 |
| 不自动建远程仓库 | 建仓库要账号权限，不该定时任务替你做 |
| 不 force push | 会永久丢掉远程别人推的提交 |
| 不绕过 hook | 你配的 pre-commit 检查照常跑 |

详见 [docs/DETAIL.md](docs/DETAIL.md)。

## 许可

MIT
