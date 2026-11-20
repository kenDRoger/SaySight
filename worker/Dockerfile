FROM golang:1.26-alpine AS build
WORKDIR /app
COPY worker/go.mod worker/go.sum ./
RUN go mod download
COPY worker/ ./
RUN CGO_ENABLED=0 go build -trimpath -o /out/worker .

FROM alpine:3.20
RUN adduser -D -u 10001 worker && mkdir -p /app/data
WORKDIR /app
COPY --from=build /out/worker ./worker
COPY --from=build /app/data/coverage.json ./data/coverage.json
USER worker
ENV COVERAGE_PATH=/app/data/coverage.json
EXPOSE 8080
CMD ["./worker"]
