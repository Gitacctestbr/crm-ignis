FROM python:3.11-slim

WORKDIR /app

# Dependências em camada separada para cache eficiente
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY print_processor.py .

# -u = unbuffered stdout → docker logs funciona em tempo real
CMD ["python", "-u", "print_processor.py"]
