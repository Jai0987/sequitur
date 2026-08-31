.PHONY: help setup build driver server web up down logs clean

LOGS_DIR := .logs
DRIVER_BIN := third_party/aeron/cmake-build/binaries/aeronmd
VENV_PY := .venv/bin/python3
VENV_PIP := .venv/bin/pip
VENV_UVICORN := .venv/bin/uvicorn

help:
	@echo "sequitur"
	@echo ""
	@echo "  make setup    install Python and npm dependencies (first time only)"
	@echo "  make build    build Aeron and the C++ project"
	@echo "  make up       start the driver, backend, and frontend together"
	@echo "  make down     stop everything make up started"
	@echo "  make logs     tail the logs for driver/server/web"
	@echo "  make clean    remove build output"
	@echo ""
	@echo "  make driver   start just the Aeron media driver"
	@echo "  make server   start just the backend (implies driver)"
	@echo "  make web      start just the frontend dev server"

setup:
	python3 -m venv .venv
	$(VENV_PIP) install --quiet -r server/requirements.txt
	cd web && npm install

build:
	cmake -S third_party/aeron -B third_party/aeron/cmake-build \
		-DCMAKE_BUILD_TYPE=Release \
		-DAERON_TESTS=OFF -DAERON_UNIT_TESTS=OFF -DAERON_SYSTEM_TESTS=OFF \
		-DAERON_BUILD_SAMPLES=OFF -DAERON_BUILD_DOCUMENTATION=OFF \
		-DBUILD_AERON_ARCHIVE_API=OFF
	cmake --build third_party/aeron/cmake-build --parallel
	cmake -S . -B build -DCMAKE_BUILD_TYPE=Release
	cmake --build build --parallel

driver:
	@mkdir -p $(LOGS_DIR)
	@if pgrep -f "$(DRIVER_BIN)" > /dev/null; then \
		echo "driver already running"; \
	else \
		nohup ./$(DRIVER_BIN) > $(LOGS_DIR)/driver.log 2>&1 & \
		sleep 1; \
		echo "driver started -- logs: $(LOGS_DIR)/driver.log"; \
	fi

server: driver
	@mkdir -p $(LOGS_DIR)
	@if pgrep -f "uvicorn main:app" > /dev/null; then \
		echo "backend already running"; \
	else \
		( cd server && nohup ../$(VENV_UVICORN) main:app --port 8000 > ../$(LOGS_DIR)/server.log 2>&1 & ); \
		sleep 1; \
		echo "backend running at http://localhost:8000 -- logs: $(LOGS_DIR)/server.log"; \
	fi

web:
	@mkdir -p $(LOGS_DIR)
	@if pgrep -f "vite" > /dev/null; then \
		echo "frontend already running"; \
	else \
		( cd web && nohup npm run dev > ../$(LOGS_DIR)/web.log 2>&1 & ); \
		sleep 2; \
		echo "frontend running at http://localhost:5173 -- logs: $(LOGS_DIR)/web.log"; \
	fi

up: driver server web
	@echo ""
	@echo "everything is running. Open http://localhost:5173"
	@echo "run 'make logs' to watch what's happening, or 'make down' to stop it all."

down:
	@pkill -f "$(DRIVER_BIN)" 2>/dev/null && echo "stopped driver" || echo "driver was not running"
	@pkill -f "uvicorn main:app" 2>/dev/null && echo "stopped backend" || echo "backend was not running"
	@pkill -f "vite" 2>/dev/null && echo "stopped frontend" || echo "frontend was not running"

logs:
	@tail -f $(LOGS_DIR)/*.log

clean:
	rm -rf build third_party/aeron/cmake-build
