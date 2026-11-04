!macro customInstall
  ; Refresh both shortcut icons during upgrades using a stable, installed ICO.
  ${ifNot} ${isNoDesktopShortcut}
    CreateShortCut "$newDesktopLink" "$appExe" "" "$INSTDIR\resources\resources\app-icon.ico" 0 "" "" "${APP_DESCRIPTION}"
    WinShell::SetLnkAUMI "$newDesktopLink" "${APP_ID}"
  ${endIf}
  CreateShortCut "$newStartMenuLink" "$appExe" "" "$INSTDIR\resources\resources\app-icon.ico" 0 "" "" "${APP_DESCRIPTION}"
  WinShell::SetLnkAUMI "$newStartMenuLink" "${APP_ID}"
  System::Call 'Shell32::SHChangeNotify(i 0x8000000, i 0, i 0, i 0)'
!macroend

!macro customUnInstall
  ; 升级先暂存识别结果，新版启动后迁回安装目录；正常卸载清除全部专用缓存。
  ${if} ${isUpdated}
    CreateDirectory "$APPDATA\${APP_PACKAGE_NAME}\cache"
    CopyFiles /SILENT "$INSTDIR\techpack-studio-cache\*.json" "$APPDATA\${APP_PACKAGE_NAME}\cache"
  ${else}
    Push $R0
    Push $R1
    Push $R2
    Push $R3
    ReadINIStr $R2 "$APPDATA\${APP_PACKAGE_NAME}\cache-locations.ini" "Cache" "Count"
    StrCpy $R1 0
    ${DoWhile} $R1 < $R2
      ReadINIStr $R0 "$APPDATA\${APP_PACKAGE_NAME}\cache-locations.ini" "Cache$R1" "Directory"
      ${GetFileName} "$R0" $R3
      ${if} $R3 == "techpack-studio-cache"
      ${orIf} $R0 == "$APPDATA\${APP_PACKAGE_NAME}\cache"
        RMDir /r "$R0"
      ${endIf}
      IntOp $R1 $R1 + 1
    ${Loop}
    Pop $R3
    Pop $R2
    Pop $R1
    Pop $R0
  ${endIf}
!macroend
