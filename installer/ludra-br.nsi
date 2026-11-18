; Ludra BR installer: for this Windows user only, no administrator needed.
Unicode true
!include "MUI2.nsh"
!define APP "Ludra BR"
!define VERSION "0.6.7"
Name "${APP}"
OutFile "LudraBR-Instalador-${VERSION}.exe"
InstallDir "$LOCALAPPDATA\Programs\Ludra BR"
RequestExecutionLevel user
SetCompressor /SOLID lzma
VIProductVersion "${VERSION}.0"
VIAddVersionKey /LANG=1046 "ProductName" "${APP}"
VIAddVersionKey /LANG=1046 "FileDescription" "Instalador do Ludra BR"
VIAddVersionKey /LANG=1046 "FileVersion" "${VERSION}"
VIAddVersionKey /LANG=1046 "LegalCopyright" "GPL-3.0"
!define MUI_ICON "..\icons\icon.ico"
!define MUI_UNICON "..\icons\icon.ico"
!define MUI_FINISHPAGE_RUN "$INSTDIR\ludra-br.exe"
!define MUI_FINISHPAGE_RUN_TEXT "Abrir o Ludra BR agora"
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "PortugueseBR"

Section "Ludra BR"
  SetOutPath "$INSTDIR"
  ; An open Ludra BR would keep its file locked: close it first.
  nsExec::Exec 'taskkill /IM ludra-br.exe /F'
  Sleep 800
  Delete "$INSTDIR\ludra-br.old.exe"
  File "..\target\x86_64-pc-windows-gnu\release\ludra-br.exe"
  File "WebView2Loader.dll"
  File "..\LICENSE"
  File "LEIA-ME.txt"
  WriteUninstaller "$INSTDIR\Desinstalar.exe"
  CreateShortcut "$SMPROGRAMS\Ludra BR.lnk" "$INSTDIR\ludra-br.exe"
  CreateShortcut "$DESKTOP\Ludra BR.lnk" "$INSTDIR\ludra-br.exe"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\LudraBR" "DisplayName" "${APP}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\LudraBR" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\LudraBR" "Publisher" "Ludra LFG"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\LudraBR" "DisplayIcon" "$INSTDIR\ludra-br.exe"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\LudraBR" "UninstallString" "$\"$INSTDIR\Desinstalar.exe$\""
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\LudraBR" "NoModify" 1
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\LudraBR" "NoRepair" 1
SectionEnd

Section "Uninstall"
  nsExec::Exec 'taskkill /IM ludra-br.exe /F'
  Sleep 800
  Delete "$INSTDIR\ludra-br.exe"
  Delete "$INSTDIR\ludra-br.old.exe"
  Delete "$INSTDIR\ludra-br.new.exe"
  Delete "$INSTDIR\WebView2Loader.dll"
  Delete "$INSTDIR\LICENSE"
  Delete "$INSTDIR\LEIA-ME.txt"
  Delete "$INSTDIR\Desinstalar.exe"
  RMDir "$INSTDIR"
  Delete "$SMPROGRAMS\Ludra BR.lnk"
  Delete "$DESKTOP\Ludra BR.lnk"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\LudraBR"
SectionEnd
