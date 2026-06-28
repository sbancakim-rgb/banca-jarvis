# playwright 패키지 버전(requirements.txt)과 이 이미지에 내장된 Chromium 버전이
# 반드시 일치해야 한다 (서로 다르면 브라우저 실행 시 버전 불일치 에러가 난다).
FROM mcr.microsoft.com/playwright/python:v1.47.0-jammy

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY main.py .

ENV PORT=8080
# 헤드리스 브라우저가 워커당 메모리를 많이 쓰므로 워커 1개만 사용하고,
# 페이지 렌더링 대기 시간을 감안해 timeout도 늘린다.
CMD ["gunicorn", "--bind", "0.0.0.0:8080", "--workers", "1", "--timeout", "120", "main:app"]
