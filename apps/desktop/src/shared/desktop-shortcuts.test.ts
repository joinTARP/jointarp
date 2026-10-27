import { expect, test } from "bun:test";

import { desktopShortcut } from "./desktop-shortcuts";

const key = (value: string, overrides = {}) => ({
  key: value,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  metaKey: false,
  ...overrides,
});

test("Windows 窗口快捷键支持主键盘与小键盘缩放，不拦截编辑与输入", () => {
  expect(desktopShortcut(key("w", { ctrlKey: true }))).toBe("close");
  expect(desktopShortcut(key(",", { ctrlKey: true }))).toBe("settings");
  expect(desktopShortcut(key("+", { ctrlKey: true, shiftKey: true }))).toBe("zoom-in");
  expect(desktopShortcut(key("=", { ctrlKey: true }))).toBe("zoom-in");
  expect(desktopShortcut(key("F10"))).toBeUndefined();
  expect(desktopShortcut(key("F11"))).toBe("full-screen");
  for (const value of ["c", "v", "x", "a", "z"]) {
    expect(desktopShortcut(key(value, { ctrlKey: true }))).toBeUndefined();
  }
  expect(desktopShortcut(key("w"))).toBeUndefined();
  expect(desktopShortcut(key("w", { ctrlKey: true, altKey: true }))).toBeUndefined();
  expect(desktopShortcut(key("F10", { shiftKey: true }))).toBeUndefined();
});
