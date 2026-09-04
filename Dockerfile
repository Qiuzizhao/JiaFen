FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY application ./application

ENV PORT=5000
EXPOSE 5000

WORKDIR /app/application
CMD ["python", "app.py"]
