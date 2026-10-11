@echo off
rem Inicia el panel en Windows y abre el navegador (doble clic).
rem Usa el kit de marca vecino (..\tazon-para-dos-marca). Para otra ruta: set BRAND_REPO=D:\ruta\al\kit
cd /d "%~dp0"
where python >nul 2>nul || (echo No se encontro Python. Instala Python 3.10 o superior desde python.org. & pause & exit /b 1)
where ffmpeg >nul 2>nul || echo Aviso: no se encontro ffmpeg. Las imagenes funcionan; para videos instala ffmpeg (winget install Gyan.FFmpeg).
echo Cierra esta ventana o presiona Ctrl+C para detener el panel.
python -X utf8 server.py --abrir
pause
