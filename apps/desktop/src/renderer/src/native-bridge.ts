import { desktopShortcut } from "@shared/desktop-shortcuts";
import { setDocumentMediaBase } from "@shared/document-media";
import { NativeMessagePort, type NativeBridge } from "@shared/native-bridge";
import { Electroview } from "electrobun/view";

const events = new EventTarget();
export const nativePort = new NativeMessagePort((packet) => rpc.send.orpc(packet));
const rpc = Electroview.defineRPC<NativeBridge>({
  maxRequestTime: 30_000,
  handlers: {
    requests: {},
    messages: {
      orpc: (packet) => nativePort.receive(packet),
      desktop: ({ name }) => events.dispatchEvent(new Event(name)),
    },
  },
});
new Electroview({ rpc });

function listen(name: string, listener: () => void) {
  events.addEventListener(name, listener);
  return () => events.removeEventListener(name, listener);
}
export const desktopReady = rpc.request.bootstrap().then(({ mediaBase }) => {
  setDocumentMediaBase(mediaBase);
});
window.desktopEvents = {
  windowAction: (action) => rpc.request.windowAction({ action }),
  claimStartupAnimation: () => rpc.request.claimStartupAnimation(),
  setGamePage: (active) => {
    void rpc.request.setGamePage({ active });
  },
  onOpenSettings: (listener) => listen("open-settings", listener),
  onRequestLeaveRoom: (listener) => listen("request-leave-room", listener),
};

if (navigator.userAgent.includes("Windows")) {
  document.addEventListener("keydown", (event) => {
    if (event.defaultPrevented || event.isComposing) return;
    const action = desktopShortcut(event);
    if (!action) return;
    event.preventDefault();
    void rpc.request.windowAction({ action });
  });
}

window.addEventListener("pagehide", () => nativePort.close(), { once: true });
document.addEventListener(
  "click",
  (event) => {
    const anchor = event
      .composedPath()
      .find((target) => target instanceof HTMLAnchorElement && target.hasAttribute("href"));
    if (!(anchor instanceof HTMLAnchorElement) || !/^https?:/iu.test(anchor.href)) return;
    const target = new URL(anchor.href);
    const current = new URL(location.href);
    target.hash = "";
    current.hash = "";
    // 开发模式的应用内链接也是 HTTP，交给路由处理，不能误开系统浏览器。
    if (target.href === current.href) return;
    event.preventDefault();
    void rpc.request.openExternal({ url: anchor.href });
  },
  true,
);
