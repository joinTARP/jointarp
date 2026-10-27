#!/bin/zsh
set -o pipefail
cd "${0:A:h}"
print 'TARP 双 Mac 联机验证（两台电脑先连接同一个 Wi-Fi）'
print '1：本机当房主  2：加入另一台 Mac'
read 'role?请选择 1 或 2：'
case "$role" in
  1) export TARP_WEBRTC_PROBE_MODE=listen ;;
  2) export TARP_WEBRTC_PROBE_MODE=join
     read 'TARP_WEBRTC_PROBE_URL?粘贴房主终端显示的完整加入地址：'
     export TARP_WEBRTC_PROBE_URL ;;
  *) print '无效选择'; exit 1 ;;
esac
cd Probe.app/Contents/MacOS
./launcher 2>&1 | tee ../../../测试结果.log
result=$?
print "测试已结束，退出码：$result。结果保存在测试结果.log。"
read 'reply?按回车关闭。'
exit "$result"
