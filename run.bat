@echo off
setlocal
cd /d "%~dp0"

rem Locate uv. Prefer uv on PATH, fall back to `python -m uv`.
where uv >nul 2>&1
if %errorlevel%==0 (
    set "UV=uv"
) else (
    python -m uv --version >nul 2>&1
    if errorlevel 1 (
        echo [setup] Installing uv...
        python -m pip install --disable-pip-version-check -q --user uv || goto :error
    )
    set "UV=python -m uv"
)

echo [setup] Syncing dependencies with uv...
%UV% sync || goto :error

echo.
echo Starting server on http://127.0.0.1:8000
echo Press Ctrl+C to stop.
echo.
%UV% run python app.py
goto :eof

:error
echo.
echo Setup failed. See errors above.
exit /b 1
