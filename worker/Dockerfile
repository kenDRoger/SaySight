FROM golang:1.26-alpine
WORKDIR /app
COPY worker/go.mod worker/go.sum ./
RUN go mod download
COPY worker/ ./
ENV COVERAGE_PATH=/app/data/coverage.json
EXPOSE 8080
CMD ["go", "run", "."]
