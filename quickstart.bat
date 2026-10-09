@echo off
rem Bam dup de dung lab va chay nghiem thu. Can Docker Desktop + Git for Windows.
rem Chi goi lai scripts/quickstart.sh bang Git Bash - moi logic nam o do.
setlocal
set "GITBASH=%ProgramFiles%\Git\bin\bash.exe"
if not exist "%GITBASH%" set "GITBASH=%ProgramFiles(x86)%\Git\bin\bash.exe"
if not exist "%GITBASH%" set "GITBASH=%LocalAppData%\Programs\Git\bin\bash.exe"
if not exist "%GITBASH%" (
    echo Khong tim thay Git Bash. Cai Git for Windows: https://git-scm.com/download/win
    pause
    exit /b 1
)
rem Duong dan repo co ky tu "&" - luon de trong ngoac kep.
cd /d "%~dp0"
"%GITBASH%" scripts/quickstart.sh %*
echo.
pause
