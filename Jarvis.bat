@echo off
chcp 65001 >nul
title Jarvis
rem Jarvis: tek tikla bilgisayarda ve telefonda acar, yeni ozellikleri kendiliginden yukler.
rem Asil isi scripts\baslat.mjs yapar; bu dosya bilerek kisa tutuldu.
set "JDIR=%USERPROFILE%\jarvis"
if not exist "%JDIR%\package.json" (
    echo [HATA] Jarvis klasoru bulunamadi: %JDIR%
    pause
    exit /b 1
)
where node >nul 2>&1
if errorlevel 1 (
    echo [HATA] Node.js bulunamadi. https://nodejs.org adresinden LTS surumunu kurun.
    pause
    exit /b 1
)
cd /d "%JDIR%"
set "JARVIS_YENIDEN="
rem Dongu tek blok halinde: Jarvis bu dosyayi calisirken guncellese bile pencere bozulmaz
:basla
(
    node "%JDIR%\scripts\baslat.mjs" %*
    if errorlevel 79 goto kapandi
    if errorlevel 78 (
        set "JARVIS_YENIDEN="
        goto basla
    )
    if errorlevel 77 exit /b 0
    if errorlevel 76 (
        set "JARVIS_YENIDEN=1"
        goto basla
    )
    goto kapandi
)
:kapandi
(
    echo.
    echo Jarvis kapandi. Tekrar acmak icin masaustundeki Jarvis simgesine cift tiklayin.
    pause
    exit /b
)
