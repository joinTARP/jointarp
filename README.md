# TARP

TARP 是一款由 AI 主持的文字角色扮演应用。支持 AI 队友、自定义模组和语音朗读，模组与存档保存在本机。

支持 Windows、macOS 和 Linux，暂不支持真人在线联机。AI 和语音需连接服务商，相关内容会发送给服务商，费用按其规则计收。

[官网下载](https://jointarp.party/) · [使用文档](https://jointarp.party/docs/getting-started/introduction/) · [模组规范](https://jointarp.party/docs/modules/structure/)

## 本地开发

需要 Bun 1.4.0 或更新版本，在仓库根目录运行：

```sh
bun install --frozen-lockfile
bun run dev
```

本仓库使用 Bun workspace，仅维护根级 `bun.lock`。桌面应用位于 `apps/desktop/`，共享代码与模组 CLI 位于 `packages/`。

[桌面开发](apps/desktop/README.md) · [模组 CLI](packages/module-cli/README.md) · [开发文档](docs/README.md) · [测试维护](docs/测试维护.md) · [发布流程](docs/发布流程.md)

## 许可证

原创代码与文档采用 [GPL-3.0-only](LICENSE)，允许商业使用。版权及授权范围见 [NOTICE.md](NOTICE.md)；第三方依赖、模组、规则和素材遵循各自的授权条件。
