FROM golang:1.22-alpine AS builder
WORKDIR /app
COPY go.mod ./
RUN go mod download -x 2>/dev/null; true
COPY . .
RUN go mod tidy && CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o license-server .

FROM alpine:3.20
RUN apk add --no-cache ca-certificates wget
COPY --from=builder /app/license-server /license-server
EXPOSE 8080
ENTRYPOINT ["/license-server"]
