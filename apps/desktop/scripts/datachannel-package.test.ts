import { expect, test } from "bun:test";

import { datachannelPackage } from "./datachannel-package";

test("按运行平台选择 WebRTC 原生包", () => {
  expect(datachannelPackage("linux", "x64", "glibc")).toBe("@node-datachannel/linux-x64-gnu");
  expect(datachannelPackage("linux", "arm64", "musl")).toBe("@node-datachannel/linux-arm64-musl");
  expect(datachannelPackage("win32", "x64")).toBe("@node-datachannel/win32-x64-msvc");
  expect(datachannelPackage("darwin", "arm64")).toBe("@node-datachannel/darwin-arm64");
});
