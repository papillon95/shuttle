; Shuttle 安装程序自定义脚本（electron-builder 自动加载 build/installer.nsh）
;
; 0.2.1 及更早的 Windows 安装包是在 macOS 上打的，自带的卸载程序 CRC 校验值是错的
; （修复见 scripts/win-sign.js），一运行就报 “Installer integrity check has failed”。
;
; 安装新版本时，electron-builder 默认会先静默运行旧版的卸载程序；旧卸载程序坏了就会
; 重试几次后提示“卸载失败”并退出，导致老用户无法升级。
; 所以这里：发现已安装的版本低于 0.2.2，就不去调用它的卸载程序（删掉注册表里的卸载命令），
; 直接覆盖安装到原目录；安装完成后注册表会写入新版（正常的）卸载程序。

!include "WordFunc.nsh"

!macro shuttleSkipBrokenUninstaller ROOT KEY
  ClearErrors
  ReadRegStr $R8 ${ROOT} "${KEY}" "DisplayVersion"
  ${if} $R8 != ""
    ${VersionCompare} "$R8" "0.2.2" $R9
    ${if} $R9 == 2
      DetailPrint "Skip broken uninstaller of Shuttle $R8"
      DeleteRegValue ${ROOT} "${KEY}" "UninstallString"
      DeleteRegValue ${ROOT} "${KEY}" "QuietUninstallString"
    ${endif}
  ${endif}
  ClearErrors
!macroend

!macro customInit
  Push $R8
  Push $R9
  !insertmacro shuttleSkipBrokenUninstaller HKCU "${UNINSTALL_REGISTRY_KEY}"
  !insertmacro shuttleSkipBrokenUninstaller HKLM "${UNINSTALL_REGISTRY_KEY}"
  !ifdef UNINSTALL_REGISTRY_KEY_2
    !insertmacro shuttleSkipBrokenUninstaller HKCU "${UNINSTALL_REGISTRY_KEY_2}"
    !insertmacro shuttleSkipBrokenUninstaller HKLM "${UNINSTALL_REGISTRY_KEY_2}"
  !endif
  Pop $R9
  Pop $R8
!macroend
