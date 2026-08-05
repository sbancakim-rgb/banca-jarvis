@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

rem 커밋 메시지: deploy.bat "메시지" 처럼 넘기면 그 메시지를 쓰고, 없으면 날짜/시각을 쓴다.
set "MSG=%~1"
if "%MSG%"=="" set "MSG=deploy %DATE% %TIME:~0,5%"

echo.
echo [1/3] Apps Script 업로드 (Code.gs)
call clasp push --force
if errorlevel 1 goto :fail

echo.
echo [2/3] Apps Script 배포
call clasp deploy --deploymentId AKfycbyo3aaLvJjbYE2_XmabUyybIDj4ZVST0EJoIJzPPj8gyBb4D2sm2yigCtHZ7T9EbalE -d "updated"
if errorlevel 1 goto :fail

echo.
echo [3/3] GitHub 배포 (화면 index.html)
git add -A
git diff --cached --quiet
if errorlevel 1 (
    git commit -m "%MSG%"
    if errorlevel 1 goto :fail
) else (
    echo      바뀐 파일이 없어 커밋을 건너뜁니다.
)
git push origin main
if errorlevel 1 goto :fail

echo.
echo ============================================
echo  배포 완료!
echo    백엔드 : Apps Script (즉시 반영)
echo    화면   : https://sbancakim-rgb.github.io/banca-jarvis/
echo             GitHub Pages 반영까지 30초~1분 걸립니다.
echo ============================================
echo.
goto :end

:fail
echo.
echo ********************************************
echo  배포 실패! 위 오류 메시지를 확인하세요.
echo  (아무것도 반영되지 않았거나 일부만 반영됐을 수 있습니다)
echo ********************************************
echo.
endlocal
exit /b 1

:end
endlocal
