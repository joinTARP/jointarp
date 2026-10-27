# Bun 联机实验

## 当前结论

2026-10-26 已在独立实验中验证以下路径：

```text
macOS 系统 WebView
  → 原生桥 → 玩家 Bun 主进程
  → 公网 TCP / libp2p（Noise 加密、Yamux 多路复用）
  → Linux x64 房主 Bun 进程 → 实验 RPC
```

WebView 只调用本机 RPC，不建立 WebRTC 或其他 P2P 连接。本机与房主的网络连接由 Bun 持有。正式游戏、现有内网入口及 WebRTC 实验均未切换；该实验不加载个人设置、冒险或模型服务。

这证明主进程持有网络连接、转发现有 oRPC 契约的方向可行，尚不证明 NAT 打洞、玩家中继、自动重连或完整游戏同步可用。远端房主使用可直接访问的公网 TCP 端口。SSH 只用于启动与清理房主进程，不承载测试 RPC 数据，没有使用端口转发。

## 开发入口

依赖由根级 Bun workspace 安装，仅列入桌面开发依赖。先准备 macOS ARM64 开发包及 Electrobun SDK，再从仓库根目录运行：

```sh
# 本机两个独立 Bun 进程，无界面。
bun apps/desktop/scripts/p2p-probe/headless.ts

# 系统 WebView → 玩家 Bun → 本机独立房主 Bun。
bun apps/desktop/scripts/p2p-probe/run.ts local

# 系统 WebView → 玩家 Bun → Linux 公网房主。
# linux-dev 替换为已授权的 SSH 配置别名，需解析为明确的 IPv4 地址。
bun apps/desktop/scripts/p2p-probe/run.ts remote linux-dev

# 只测本机 Bun → Linux 公网房主，不启动窗口。
bun apps/desktop/scripts/p2p-probe/run.ts remote-headless linux-dev

# 网络边界和订阅生命周期的隔离检查，不访问远程服务器。
bun run test --scope @jointarp/desktop apps/desktop/scripts/p2p-probe/rpc.test.ts
```

远程模式交叉编译 `bun-linux-x64-baseline` 独立程序，目标服务器无需安装 Bun、Node 或依赖。编译可能首次下载 Bun 的对应目标运行时。程序上传到 `/tmp/tarp-p2p-probe.*`，在随机 TCP 端口临时监听；需要网络入口允许访问该端口。房主只接受本次玩家 Peer ID，身份通过 Noise 验证。该 Peer ID 不是正式入房或角色恢复身份。

产物位于 `apps/desktop/out/p2p-probe/`，与正式开发包和旧 WebRTC 实验目录分开。窗口实验最多 45 秒，远端房主 90 秒硬期限；SSH 标准输入关闭后房主停止。正常和异常退出均尝试清理远端临时文件；若本地进程被强制杀死，远端程序仍有硬期限，但可能需要人工清理临时目录。实验没有安装系统依赖、修改防火墙或注册常驻服务。

## 已验证行为

- 本机两个独立 Bun 进程间，大帧中文 RPC 往返一致。
- 三条订阅事件有序到达，并正常结束。
- 从界面取消订阅，信号经过本机 RPC 转发到房主，房主停止生成事件。
- 取消单条订阅不关闭共享连接，后续请求仍成功。
- 畸形长度、超限长度、未知帧类型及截断帧关闭对应数据流；房主和其他 RPC 数据流仍可用。
- 本机系统 WebView 经原生桥和 Bun，直接访问 Linux 公网房主，上述请求和订阅行为通过。
- 远端实验完成后检查：临时目录与实验进程均为零。

本机命令行使用 Bun 1.4.2；桌面实验副本沿用开发包的 Bun 1.4.0；Linux 使用 Bun 1.4.2 交叉编译程序。当前 Noise 默认原生 ChaCha20 大帧路径在 Bun 上不兼容，实验显式使用库公开提供的 `pureJsCrypto`，未关闭加密。

## 实现边界

`stream-port.ts` 将 libp2p 字节流适配为现有 oRPC MessagePort 接口，使用长度前缀保留字符串/二进制帧边界。单帧最多 1 MiB，发送队列最多 4 MiB，按 16 KiB 分块并等待背压解除。此限制只供实验，不代表实际游戏的状态帧上限；正式接入前需要有界分块与完整资源传输验证。

`main.ts` 保留界面到本机 Bun 的原生桥，并将 RPC 转发到远端链路，同时传递取消信号及事件游标。`host.ts` 是独立房主进程，只暴露实验路由，不暴露桌面配置、文件系统或真实游戏路由。`rpc.test.ts` 验证取消与数据帧错误隔离，避免将传输成功等同于 RPC 生命周期完整。

下一步应验证受限网络下的可达性，再接入实际房间身份、授权、状态同步及资源传输。独立资源流、玩家中继授权与切换、断线时未决请求语义，以及 Windows/Linux 桌面宿主均未验收。当前不删除旧 WebRTC 实验，不启用服务器中继或付费流程。

## 后续 WebRTC 验证

Bun 主进程中的 werift 已另行完成数据通道与公网候选实验；具体 STUN 实测及通过边界见 [Bun WebRTC 实验](BunWebRTC实验.md)。这不改变本文 libp2p TCP 实验尚未完成 NAT 打洞的结论。
