@echo off
chcp 65001 >nul
setlocal
title Jarvis
set "JDIR=%USERPROFILE%\jarvis"
if not exist "%JDIR%\package.json" (
    echo [HATA] Jarvis klasoru bulunamadi: %JDIR%
    pause
    exit /b 1
)

rem --- Ilk calistirmada kendini masaustune kopyalar (OneDrive masaustu dahil)
for /f "usebackq delims=" %%D in (`powershell -NoProfile -Command "[Environment]::GetFolderPath('Desktop')"`) do set "DESK=%%D"
if defined DESK if /i not "%~dp0"=="%DESK%\" if not exist "%DESK%\Jarvis.bat" (
    copy "%~f0" "%DESK%\Jarvis.bat" >nul && echo Masaustune "Jarvis" eklendi. Bundan sonra oradan cift tiklayin.
)

cd /d "%JDIR%"

rem --- Acik kalmis eski Jarvis'i kapat (port 8787 ve 5173)
powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort 8787,5173 -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }" >nul 2>&1

rem --- Guncelleme (anahtarlariniz ve verileriniz korunur)
echo [1/3] Guncellemeler kontrol ediliyor...
git fetch -q https://github.com/ustadonerci/jarvis.git ayarlar-yetenekler
if not errorlevel 1 (
    git merge -q --ff-only FETCH_HEAD >nul 2>&1 || git reset -q --hard FETCH_HEAD
)

echo [2/3] Gerekli paketler kuruluyor (ilk seferde birkac dakika surebilir)...
call npm.cmd run setup
if errorlevel 1 (
    echo.
    echo [HATA] Paketler kurulamadi. Yukaridaki kirmizi yaziyi Claude'a gonderin.
    pause
    exit /b 1
)

echo.
echo [3/3] Nasil acilsin?
echo   1 = Sadece bu bilgisayarda
echo   2 = Telefonda da (telefon linki ve QR kod verir)
choice /c 12 /t 10 /d 1 /n /m "Secin (1 ya da 2, 10 sn icinde secmezseniz 1): "
if errorlevel 2 goto telefon

start "" cmd /c "timeout /t 12 >nul & start http://localhost:5173"
echo.
echo Jarvis baslatiliyor. Tarayici birazdan kendiliginden acilacak: http://localhost:5173
echo Bu pencereyi KAPATMAYIN; kapatirsaniz Jarvis de kapanir.
echo.
call npm.cmd run dev
pause
exit /b

:telefon
start "" cmd /c "timeout /t 15 >nul & start http://localhost:5173"
echo.
echo Jarvis ve telefon baglantisi baslatiliyor. Asagida telefon linki ve QR kod cikacak.
echo Bu pencereyi KAPATMAYIN.
echo.
call npm.cmd run telefon
pause
